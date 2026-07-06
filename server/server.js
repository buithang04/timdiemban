// ——— Load .env nếu có ———
(function loadEnv() {
  const envPath = require("path").join(__dirname, ".env");
  if (!require("fs").existsSync(envPath)) return;
  const lines = require("fs").readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
})();

const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { pushPointsExternal, resolveImportUrl, resolveImportUrls } = require("./points-push");
const {
  resolveAcqId,
  sanitizeAddInfo,
  generateVietQrV2,
  buildQuickLinkUrl
} = require("./vietqr");

const USE_MYSQL = (process.env.DB_TYPE || "").toLowerCase() === "mysql";

let dbModule, authModule;
if (USE_MYSQL) {
  dbModule   = require("./db-mysql");
  authModule = require("./auth-store-mysql");
} else {
  dbModule   = require("./db");
  authModule = require("./auth-store");
}

const { getSetting, setSetting } = dbModule;
const {
  createUser,
  loginUser,
  loginAdmin,
  getUserFromToken,
  getAdminFromToken,
  requestPasswordReset,
  resetPasswordWithToken,
  adminResetPassword,
  listUsers,
  listPackages,
  addPoints,
  assignPackage,
  requestPackagePurchase,
  confirmPayment,
  listPackageOrders,
  getPackageOrderById,
  approvePackageOrder,
  rejectPackageOrder,
  deletePackageOrder,
  cancelPackageOrder,
  setUserActive,
  setUserPoints,
  chargePoints,
  logoutToken
} = authModule;

// ——— Khởi tạo database ———
let dbReady = false;
async function initDatabase() {
  if (USE_MYSQL) {
    await dbModule.initDb();
  } else {
    dbModule.getDb();
  }
  dbReady = true;
}
initDatabase().catch((err) => {
  console.error("[DB] Lỗi khởi tạo:", err.message);
  console.error("Kiểm tra cấu hình MySQL trong server/.env");
  process.exit(1);
});

const extManifestPath = path.join(__dirname, "..", "extension", "manifest.json");
function getExtensionManifestVersion() {
  try {
    const raw = fs.readFileSync(extManifestPath, "utf8");
    const manifest = JSON.parse(raw);
    return { version: manifest.version || "0.0.0", name: manifest.name || "Tim Diem Ban" };
  } catch {
    return { version: "0.0.0", name: "Tim Diem Ban" };
  }
}

const app = express();
const PORT = 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "JSON không hợp lệ — kiểm tra Content-Type và nội dung request" });
  }
  next(err);
});

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return req.headers["x-auth-token"] || "";
}

async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromToken(getToken(req));
    if (!user) return res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const admin = await getAdminFromToken(getToken(req));
    if (!admin) return res.status(403).json({ error: "Cần đăng nhập quản trị viên" });
    req.admin = admin;
    next();
  } catch (err) {
    next(err);
  }
}

async function isVietQrConfigured() {
  const bankId = await getSetting("vietqr_bank_id", "");
  const accountNo = await getSetting("vietqr_account_no", "");
  const clientId = await getSetting("vietqr_client_id", "");
  const apiKey = await getSetting("vietqr_api_key", "");
  const acqId = await getSetting("vietqr_acq_id", "");
  if (clientId && apiKey && accountNo && resolveAcqId(bankId, acqId)) return true;
  return !!(bankId && accountNo);
}

async function buildVietQrPayment(order) {
  if (!order?.paymentAmount) return null;

  const bankId = await getSetting("vietqr_bank_id", "");
  const accountNo = await getSetting("vietqr_account_no", "");
  const accountName = await getSetting("vietqr_account_name", "");
  const clientId = await getSetting("vietqr_client_id", "");
  const apiKey = await getSetting("vietqr_api_key", "");
  const acqIdSetting = await getSetting("vietqr_acq_id", "");

  if (!accountNo) return null;

  const amount = order.paymentAmount;
  const notePlain = sanitizeAddInfo(String(order.id).slice(0, 25));
  const paymentInfo = {
    bankId,
    accountNo,
    accountName,
    acqId: resolveAcqId(bankId, acqIdSetting),
    amount,
    note: notePlain
  };

  // Ưu tiên API v2 khi có Client ID + API Key
  if (clientId && apiKey) {
    const acqId = resolveAcqId(bankId, acqIdSetting);
    if (acqId) {
      try {
        const v2 = await generateVietQrV2({
          clientId,
          apiKey,
          accountNo,
          accountName,
          acqId,
          amount,
          addInfo: notePlain,
          template: "compact2"
        });
        return { ...v2, paymentInfo: { ...paymentInfo, method: "api-v2" } };
      } catch (err) {
        console.warn("[VietQR v2]", err.message, "— fallback Quick Link");
      }
    }
  }

  // Fallback: Quick Link img.vietqr.io (không cần API key)
  if (bankId) {
    const quick = buildQuickLinkUrl({
      bankId,
      accountNo,
      accountName,
      amount,
      addInfo: notePlain
    });
    if (quick) {
      return { ...quick, paymentInfo: { ...paymentInfo, method: "quick-link" } };
    }
  }

  return null;
}

app.get("/api/packages", async (req, res) => {
  res.json({ packages: await listPackages() });
});

app.get("/api/packages/vietqr-status", requireAuth, async (req, res) => {
  res.json({ configured: await isVietQrConfigured() });
});

app.get("/api/ext-version", (req, res) => {
  res.json(getExtensionManifestVersion());
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await loginUser(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  await logoutToken(getToken(req));
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await getUserFromToken(getToken(req));
  if (!user) return res.status(401).json({ error: "Chưa đăng nhập" });
  res.json({ user });
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    const result = await requestPasswordReset(email);
    const payload = { ok: true, message: result.message };
    if (result.token) {
      payload.resetPath = `/dat-lai-mat-khau?token=${result.token}`;
    }
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await resetPasswordWithToken(token, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await loginAdmin(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ user: req.admin });
});

app.get("/api/admin/packages", requireAdmin, async (req, res) => {
  res.json({ packages: await listPackages() });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const { email, password, packageId, points } = req.body || {};
    const user = await createUser(email, password, { packageId: packageId || null, points });
    res.json({
      user,
      message: `Đã tạo tài khoản ${user.email} — ${user.points} điểm`
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  res.json({ users: await listUsers(), packages: await listPackages() });
});

app.post("/api/admin/reset-password", requireAdmin, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await adminResetPassword(email, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/points/add", requireAdmin, async (req, res) => {
  try {
    const { email, amount } = req.body || {};
    const user = await addPoints(email, amount);
    res.json({ user, message: `Đã cộng ${amount} điểm cho ${email}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/points/set", requireAdmin, async (req, res) => {
  try {
    const { email, points } = req.body || {};
    const user = await setUserPoints(email, points);
    res.json({ user, message: `Đã đặt ${user.points} điểm cho ${email}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/package/assign", requireAdmin, async (req, res) => {
  try {
    const { email, packageId } = req.body || {};
    const result = await assignPackage(email, packageId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/users/toggle-active", requireAdmin, async (req, res) => {
  try {
    const { email, active } = req.body || {};
    const user = await setUserActive(email, active !== false);
    res.json({
      user,
      message: user.isActive ? `Đã mở khóa ${email}` : `Đã khóa ${email}`
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/packages/purchase", requireAuth, async (req, res) => {
  try {
    const packageId = String(req.body?.packageId || "").trim();
    if (!packageId) return res.status(400).json({ error: "Thiếu mã gói" });
    const result = await requestPackagePurchase(req.user.id, packageId);
    const payment = result.order ? await buildVietQrPayment(result.order) : null;
    if (payment) {
      result.qrUrl = payment.qrUrl;
      result.paymentInfo = payment.paymentInfo;
      result.qrMethod = payment.method;
    }
    result.vietqrConfigured = await isVietQrConfigured();

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/packages/orders/:id/confirm-payment", requireAuth, async (req, res) => {
  try {
    if (!confirmPayment) {
      return res.status(400).json({ error: "Chức năng này yêu cầu MySQL" });
    }
    if (!(await isVietQrConfigured())) {
      return res.status(400).json({
        error: "Admin chưa cấu hình VietQR — vui lòng liên hệ admin trước khi xác nhận thanh toán"
      });
    }
    const result = await confirmPayment(req.params.id, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/packages/orders/:id/cancel", requireAuth, async (req, res) => {
  try {
    if (!cancelPackageOrder) {
      return res.status(400).json({ error: "Chức năng hủy đơn chưa khả dụng" });
    }
    const result = await cancelPackageOrder(req.params.id, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/packages/orders/:id/payment", requireAuth, async (req, res) => {
  try {
    if (!getPackageOrderById) {
      return res.status(400).json({ error: "Chức năng này yêu cầu MySQL" });
    }
    const order = await getPackageOrderById(req.params.id);
    if (!order || order.userId !== req.user.id) {
      return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ error: "Đơn không còn ở trạng thái chờ thanh toán" });
    }
    const payment = await buildVietQrPayment(order);
    res.json({
      order,
      vietqrConfigured: await isVietQrConfigured(),
      qrUrl: payment?.qrUrl || null,
      qrMethod: payment?.method || null,
      paymentInfo: payment?.paymentInfo || null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/packages/orders", requireAuth, async (req, res) => {
  try {
    const orders = await listPackageOrders({ userId: req.user.id });
    const vietqrConfigured = await isVietQrConfigured();
    res.json({ orders, vietqrConfigured });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/package/orders", requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || "pending").trim() || "pending";
    const orders = await listPackageOrders({ status });
    res.json({ orders });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/package/orders/:id/approve", requireAdmin, async (req, res) => {
  try {
    const result = await approvePackageOrder(req.params.id, req.admin.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/package/orders/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { note } = req.body || {};
    const result = await rejectPackageOrder(req.params.id, req.admin.id, note);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/package/orders/:id/delete", requireAdmin, async (req, res) => {
  try {
    const result = await deletePackageOrder(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/search/charge", requireAuth, async (req, res) => {
  try {
    const phoneCount = Math.max(0, Math.floor(Number(req.body?.phoneCount) || 0));
    const result = await chargePoints(req.user.id, phoneCount);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ——— Admin VietQR config ———
app.get("/api/admin/vietqr-config", requireAdmin, async (req, res) => {
  res.json({
    bankId: await getSetting("vietqr_bank_id", ""),
    accountNo: await getSetting("vietqr_account_no", ""),
    accountName: await getSetting("vietqr_account_name", ""),
    acqId: await getSetting("vietqr_acq_id", ""),
    clientId: await getSetting("vietqr_client_id", ""),
    hasApiKey: !!(await getSetting("vietqr_api_key", ""))
  });
});

app.post("/api/admin/vietqr-config", requireAdmin, async (req, res) => {
  try {
    const { bankId, accountNo, accountName, acqId, clientId, apiKey } = req.body || {};
    await setSetting("vietqr_bank_id", String(bankId || "").trim());
    await setSetting("vietqr_account_no", String(accountNo || "").trim());
    await setSetting("vietqr_account_name", String(accountName || "").trim());
    await setSetting("vietqr_acq_id", String(acqId || "").trim());
    await setSetting("vietqr_client_id", String(clientId || "").trim());
    if (String(apiKey || "").trim()) {
      await setSetting("vietqr_api_key", String(apiKey).trim());
    }
    const savedBankId = await getSetting("vietqr_bank_id", "");
    const savedAccountNo = await getSetting("vietqr_account_no", "");
    const savedAccountName = await getSetting("vietqr_account_name", "");
    const savedAcqId = await getSetting("vietqr_acq_id", "");
    const savedClient = await getSetting("vietqr_client_id", "");
    const savedKey = await getSetting("vietqr_api_key", "");
    const hasV2 = !!(savedClient && savedKey && resolveAcqId(savedBankId, savedAcqId) && savedAccountNo);
    res.json({
      ok: true,
      message: hasV2
        ? "Đã lưu — VietQR API v2 sẵn sàng (Client ID + API Key + STK + BIN)"
        : "Đã lưu STK ngân hàng. Để dùng API v2: nhập Client ID, API Key và mã BIN (6 số).",
      vietqrV2Ready: hasV2,
      bankId: savedBankId,
      accountNo: savedAccountNo,
      accountName: savedAccountName,
      acqId: savedAcqId,
      clientId: savedClient,
      hasApiKey: !!savedKey
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Admin test tạo QR thử (API v2 hoặc Quick Link) */
app.post("/api/admin/vietqr-test", requireAdmin, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 99000;
    const fakeOrder = {
      id: "ord_test_preview",
      paymentAmount: amount
    };
    const payment = await buildVietQrPayment(fakeOrder);
    if (!payment?.qrUrl) {
      return res.status(400).json({ error: "Chưa đủ cấu hình — kiểm tra STK, mã NH và API Key" });
    }
    res.json({
      ok: true,
      qrUrl: payment.qrUrl,
      qrMethod: payment.method,
      paymentInfo: payment.paymentInfo,
      message: payment.method === "api-v2" ? "QR tạo qua API v2" : "QR tạo qua Quick Link"
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Lấy site Winmap — CHỈ theo tài khoản đang đăng nhập (mỗi user 1 site + token riêng).
 */
async function getWinmapSite(userId) {
  const url = (await getSetting(`winmap_site_url:${userId}`, "")).trim();
  const token = (await getSetting(`winmap_site_token:${userId}`, "")).trim();
  const label = (await getSetting(`winmap_site_label:${userId}`, "")).trim();
  return { url, token, label };
}

function siteHost(url) {
  try {
    return new URL(resolveImportUrl(url)).host;
  } catch {
    return "";
  }
}

/** Cấu hình site nhận dữ liệu — dùng cho nút "Lưu site" và "Gửi về site". Riêng theo từng tài khoản. */
app.get("/api/points/site", requireAuth, async (req, res) => {
  const site = await getWinmapSite(req.user.id);
  res.json({
    url: site.url,
    label: site.label,
    host: siteHost(site.url),
    importUrl: site.url ? resolveImportUrl(site.url) : "",
    hasToken: Boolean(site.token),
    configured: Boolean(site.url && site.token)
  });
});

/** Lưu site trả dữ liệu (domain + Bearer token của winmap) — riêng cho tài khoản đang đăng nhập. */
app.post("/api/points/site", requireAuth, async (req, res) => {
  try {
    const { url, token, label } = req.body || {};
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl) return res.status(400).json({ error: "Thiếu địa chỉ site (vd: demo.winmap.vn)" });

    const importUrl = resolveImportUrl(cleanUrl);
    try {
      // eslint-disable-next-line no-new
      new URL(importUrl);
    } catch {
      return res.status(400).json({ error: "Địa chỉ site không hợp lệ" });
    }

    const uid = req.user.id;
    await setSetting(`winmap_site_url:${uid}`, cleanUrl);
    await setSetting(`winmap_site_label:${uid}`, String(label || "").trim());
    if (typeof token === "string" && token.trim() !== "") {
      await setSetting(`winmap_site_token:${uid}`, token.trim());
    }

    const site = await getWinmapSite(uid);
    res.json({
      ok: true,
      message: `Đã lưu site ${siteHost(cleanUrl)}`,
      url: site.url,
      label: site.label,
      host: siteHost(site.url),
      importUrl,
      hasToken: Boolean(site.token),
      configured: Boolean(site.url && site.token)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Lỗi lưu site" });
  }
});

/** Chẩn đoán kết nối sang Winmap — không gửi dữ liệu thật. */
app.get("/api/points/ping", requireAuth, async (req, res) => {
  const saved = await getWinmapSite(req.user.id);
  const rawUrl = (req.query.url && String(req.query.url).trim()) || saved.url;
  const token  = (req.query.token && String(req.query.token).trim()) || saved.token;

  if (!rawUrl) {
    return res.json({ ok: false, configured: false, message: "Chưa lưu site. Nhập địa chỉ và token rồi bấm 'Lưu site'." });
  }

  const { clean: importUrl, fallback: fallbackUrl } = resolveImportUrls(rawUrl);

  const report = { configured: Boolean(rawUrl && token), importUrl, fallbackUrl, steps: [] };

  // Thử GET tới base URL trước để xem server có sống không
  const baseUrl = importUrl.replace(/\/api\/points\/import$/i, "");
  try {
    const r = await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
    report.steps.push({ url: baseUrl, status: r.status, ok: r.status < 500 });
  } catch (e) {
    report.steps.push({ url: baseUrl, status: 0, ok: false, error: e.message });
    return res.json({ ok: false, ...report, message: `Không kết nối được tới ${baseUrl}: ${e.message}` });
  }

  // Thử POST tới import URL với payload rỗng (để kiểm tra auth)
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (const tryUrl of [importUrl, fallbackUrl]) {
    if (!tryUrl) continue;
    try {
      const r = await fetch(tryUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ points: [], source: "timdiemban_ping" }),
        signal: AbortSignal.timeout(8000)
      });
      const text = await r.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
      report.steps.push({ url: tryUrl, status: r.status, ok: r.ok, response: data });

      if (r.status === 403) {
        return res.json({ ok: false, ...report, usedUrl: tryUrl,
          message: `403 Forbidden — token không khớp. Kiểm tra token trong ⚙ Cấu hình API TimDiemBan bên Winmap. URL: ${tryUrl}` });
      }
      if (r.status === 404 && tryUrl === importUrl) {
        report.steps.push({ note: "Clean URL 404, thử fallback ?q= ..." });
        continue;
      }
      if (r.ok || r.status < 500) {
        return res.json({ ok: true, ...report, usedUrl: tryUrl,
          message: `Kết nối OK (HTTP ${r.status}) — ${tryUrl}` });
      }
      return res.json({ ok: false, ...report, usedUrl: tryUrl,
        message: `HTTP ${r.status} từ ${tryUrl}` });
    } catch (e) {
      report.steps.push({ url: tryUrl, status: 0, ok: false, error: e.message });
    }
  }

  return res.json({ ok: false, ...report, message: `Không gọi được API import. Kiểm tra log server XAMPP (error_log).` });
});

/** Gửi điểm bán sang site Winmap đã lưu (hoặc site truyền kèm trong body). */
app.post("/api/points/push", requireAuth, async (req, res) => {
  try {
    const { points, site } = req.body || {};
    if (!Array.isArray(points) || !points.length) {
      return res.status(400).json({ error: "Danh sách điểm trống" });
    }
    const saved = await getWinmapSite(req.user.id);
    const target = {
      url: (site && String(site).trim()) || saved.url,
      token: saved.token
    };
    const result = await pushPointsExternal(points, target);
    if (result.failed > 0 && result.pushed === 0) {
      return res.status(502).json({ error: result.message || "Gửi thất bại", ...result });
    }
    res.json({ ok: true, host: siteHost(target.url), ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Lỗi gửi điểm" });
  }
});

app.get("/api/points/push-config", requireAuth, async (req, res) => {
  const site = await getWinmapSite(req.user.id);
  res.json({
    configured: Boolean(site.url),
    url: site.url ? resolveImportUrl(site.url).replace(/\/\/[^/]+/, "//***") : null,
    host: siteHost(site.url)
  });
});

const webDir = path.join(__dirname, "..", "web");
const appConfig = require(path.join(__dirname, "..", "config", "app-config.js"));
const appOrigin = String(appConfig.APP_ORIGIN || "").replace(/\/$/, "") || `http://localhost:${PORT}`;

function sendWebPage(res, file) {
  res.sendFile(path.join(webDir, file));
}

/** Route trang — URL sạch, file HTML giữ trong web/ */
const webPages = {
  "/admin": "admin.html",
  "/nap-diem": "nap-diem.html",
  "/quen-mat-khau": "quen-mat-khau.html",
  "/dat-lai-mat-khau": "dat-lai-mat-khau.html"
};

for (const [route, file] of Object.entries(webPages)) {
  app.get(route, (req, res) => sendWebPage(res, file));
}

/** Chuyển hướng URL .html cũ → route chuẩn */
const legacyHtmlRedirects = {
  "/admin.html": "/admin",
  "/nap-diem.html": "/nap-diem",
  "/quen-mat-khau.html": "/quen-mat-khau",
  "/dat-lai-mat-khau.html": "/dat-lai-mat-khau",
  "/index.html": "/"
};

for (const [from, to] of Object.entries(legacyHtmlRedirects)) {
  app.get(from, (req, res) => {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(301, to + qs);
  });
}

app.use(express.static(webDir));

const server = app.listen(PORT, () => {
  console.log(`Trang web: ${appOrigin}`);
  console.log(`Trang quản trị: ${appOrigin}/admin`);
  console.log(`Quên MK: ${appOrigin}/quen-mat-khau`);
  console.log(`Database: ${USE_MYSQL ? `MySQL (${process.env.MYSQL_HOST || "localhost"}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || "timdiemban"})` : "SQLite (server/data/timdiemban.db)"}`);

});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} đang được dùng. Dừng server cũ:`);
    console.error(`  netstat -ano | findstr :${PORT}`);
    console.error("  taskkill /PID <số_PID> /F");
    process.exit(1);
  }
  throw err;
});
