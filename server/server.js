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
const nodemailer = require("nodemailer");
const { pushPointsExternal, resolveImportUrl, resolveImportUrls } = require("./points-push");
const {
  resolveAcqId,
  sanitizeAddInfo,
  generateVietQrV2,
  buildQuickLinkUrl
} = require("./vietqr");

const dbModule = require("./db");
const authModule = require("./auth-store");

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
  updateOwnProfile,
  adminUpdateUserProfile,
  chargePoints,
  logoutToken,
  acceptTerms
} = authModule;

// ——— Khởi tạo database ———
let dbReady = false;
async function initDatabase() {
  await dbModule.initDb();
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
const PORT = Number(process.env.PORT || process.env.APP_PORT || 3000);
app.set("json escape", true);

const appConfig = require(path.join(__dirname, "..", "config", "app-config.js"));
const { hasSessionCookie, COOKIE_NAME, COOKIE_VALUE, MAX_AGE_SEC } = require(path.join(
  __dirname,
  "..",
  "config",
  "session-cookie"
));

function sessionCookieAttributes(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "").toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  return `Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax${secure}`;
}

function attachSessionCookie(req, res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${COOKIE_VALUE}; ${sessionCookieAttributes(req)}`
  );
}

function clearSessionCookieHeader(req, res) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "").toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`);
}
const appOrigin = String(process.env.APP_ORIGIN || appConfig.APP_ORIGIN || "")
  .replace(/\/$/, "") || `http://localhost:${PORT}`;
const newsOrigin = String(
  process.env.NEWS_ORIGIN || appConfig.NEWS_ORIGIN || `http://localhost:3001`
).replace(/\/+$/, "");

function expandOriginAliases(origin) {
  const out = new Set();
  const raw = String(origin || "").trim().replace(/\/$/, "");
  if (!raw) return out;
  out.add(raw);
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const port = u.port ? `:${u.port}` : "";
    const base = `${u.protocol}//${host}${port}`;
    out.add(base);
    if (host.startsWith("www.")) {
      out.add(`${u.protocol}//${host.slice(4)}${port}`);
    } else if (host !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      out.add(`${u.protocol}//www.${host}${port}`);
    }
    // Cùng hệ Findmap (apex / www / app / subdomain)
    if (host === "findmap.vn" || host.endsWith(".findmap.vn")) {
      out.add(`${u.protocol}//findmap.vn`);
      out.add(`${u.protocol}//www.findmap.vn`);
      out.add(`${u.protocol}//app.findmap.vn`);
    }
  } catch {}
  return out;
}

const allowedOrigins = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://findmap.vn",
  "https://www.findmap.vn",
  "https://app.findmap.vn"
]);
for (const o of expandOriginAliases(appOrigin)) allowedOrigins.add(o);
for (const o of expandOriginAliases(newsOrigin)) allowedOrigins.add(o);

function hostnameOf(urlLike) {
  try {
    return new URL(String(urlLike || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Origin / Referer hợp lệ: allowlist + cùng hệ findmap.vn + host của APP/NEWS_ORIGIN */
function isAllowedWebOrigin(originOrUrl) {
  const raw = String(originOrUrl || "").trim();
  if (!raw) return true;
  const normalized = raw.replace(/\/$/, "");
  if (allowedOrigins.has(normalized)) return true;
  // Referer có path → so khớp prefix allowlist
  if ([...allowedOrigins].some((o) => raw === o || raw.startsWith(`${o}/`))) return true;

  const host = hostnameOf(raw.includes("://") ? raw : `https://${raw}`);
  if (!host) return false;
  if (host === "findmap.vn" || host.endsWith(".findmap.vn")) return true;
  if (host === "localhost" || host === "127.0.0.1") return true;

  const appHost = hostnameOf(appOrigin);
  const newsHost = hostnameOf(newsOrigin);
  for (const h of [appHost, newsHost].filter(Boolean)) {
    if (host === h) return true;
    if (host === `www.${h}` || h === `www.${host}`) return true;
  }
  return false;
}

function createRateLimiter({ windowMs, max, keyPrefix }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;
    const row = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > row.resetAt) {
      row.count = 0;
      row.resetAt = now + windowMs;
    }
    row.count += 1;
    hits.set(key, row);
    if (row.count > max) {
      const retryAfter = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Quá nhiều yêu cầu, vui lòng thử lại sau." });
    }
    next();
  };
}

const apiRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 600, keyPrefix: "api" });
const authWriteRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyPrefix: "authw" });

function sanitizeValue(val, key) {
  // Không làm biến dạng mật khẩu (ký tự đặc biệt hợp lệ).
  if (typeof val === "string" && /password/i.test(String(key || ""))) {
    return val;
  }
  if (typeof val === "string") {
    let s = val.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
    s = s.replace(/[<>]/g, "");
    return s.trim();
  }
  if (Array.isArray(val)) return val.map((item) => sanitizeValue(item, key));
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = sanitizeValue(v, k);
    return out;
  }
  return val;
}

function requestSanitizer(req, res, next) {
  if (req.body && typeof req.body === "object") req.body = sanitizeValue(req.body);
  if (req.query && typeof req.query === "object") req.query = sanitizeValue(req.query);
  next();
}

function hasSuspiciousSqlInput(v) {
  const s = String(v || "").toLowerCase();
  return /(\bor\b\s+1=1\b|union\s+select|drop\s+table|--|;\s*--|\/\*|\*\/)/i.test(s);
}

function guardSensitiveInput(...fields) {
  return (req, res, next) => {
    for (const f of fields) {
      const v = req.body?.[f];
      if (v != null && hasSuspiciousSqlInput(v)) {
        return res.status(400).json({ error: "Dữ liệu đầu vào không hợp lệ." });
      }
    }
    next();
  };
}

function csrfOriginGuard(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  if (!isAllowedWebOrigin(origin) || !isAllowedWebOrigin(referer)) {
    return res.status(403).json({ error: "CSRF blocked: origin không hợp lệ." });
  }
  next();
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self)");
  res.setHeader("Content-Security-Policy", "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'");
  next();
});
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    cb(null, isAllowedWebOrigin(origin));
  },
  credentials: true
}));
app.use(express.json({ limit: "5mb" }));
app.use(requestSanitizer);
app.use(csrfOriginGuard);
app.use("/api/", apiRateLimit);

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
    if (!admin) return res.status(403).json({ error: "Cần đăng nhập quản trị viên hệ thống" });
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

async function getSmtpConfig() {
  const cfg = {
    host: await getSetting("smtp_host", ""),
    hostBackup: await getSetting("smtp_host_backup", ""),
    port: Number(await getSetting("smtp_port", "465")) || 465,
    secureMode: await getSetting("smtp_secure_mode", "ssl"),
    username: await getSetting("smtp_username", ""),
    password: await getSetting("smtp_password", ""),
    fromEmail: await getSetting("smtp_from_email", ""),
    fromName: await getSetting("smtp_from_name", "findmap"),
    clientHostname: await getSetting("smtp_client_hostname", ""),
    helo: await getSetting("smtp_helo", ""),
    rerouteAddress: await getSetting("smtp_reroute_address", "")
  };
  return cfg;
}

function smtpConfigured(cfg) {
  return !!(cfg.host && cfg.port && cfg.username && cfg.password && cfg.fromEmail);
}

function createMailTransport(cfg, host) {
  const secure = String(cfg.secureMode || "ssl").toLowerCase() !== "tls";
  return nodemailer.createTransport({
    host,
    port: Number(cfg.port) || 465,
    secure,
    auth: { user: cfg.username, pass: cfg.password },
    name: cfg.clientHostname || undefined,
    tls: {
      servername: cfg.helo || undefined
    }
  });
}

async function sendResetMail({ to, resetLink }) {
  const cfg = await getSmtpConfig();
  if (!smtpConfigured(cfg)) return { ok: false, reason: "smtp_not_configured" };
  const hosts = [cfg.host, cfg.hostBackup].filter(Boolean);
  if (!hosts.length) return { ok: false, reason: "smtp_host_missing" };

  const recipient = cfg.rerouteAddress || to;
  let lastErr = null;
  for (const host of hosts) {
    try {
      const transporter = createMailTransport(cfg, host);
      await transporter.sendMail({
        from: `"${cfg.fromName || "findmap"}" <${cfg.fromEmail}>`,
        to: recipient,
        subject: "Đặt lại mật khẩu findmap",
        text: `Bạn vừa yêu cầu đặt lại mật khẩu.\n\nNhấn link sau để đổi mật khẩu:\n${resetLink}\n\nNếu không phải bạn yêu cầu, hãy bỏ qua email này.`,
        html: `
          <p>Bạn vừa yêu cầu đặt lại mật khẩu.</p>
          <p><a href="${resetLink}">Bấm vào đây để đổi mật khẩu</a></p>
          <p>Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p>
        `
      });
      return { ok: true, host, rerouted: Boolean(cfg.rerouteAddress) };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, reason: "smtp_send_failed", error: lastErr?.message || "SMTP send failed" };
}

async function sendSmtpTestMail({ to }) {
  const cfg = await getSmtpConfig();
  if (!smtpConfigured(cfg)) return { ok: false, reason: "smtp_not_configured" };
  const hosts = [cfg.host, cfg.hostBackup].filter(Boolean);
  if (!hosts.length) return { ok: false, reason: "smtp_host_missing" };

  const recipient = String(to || cfg.rerouteAddress || cfg.fromEmail || "").trim();
  if (!recipient) return { ok: false, reason: "smtp_test_recipient_missing" };

  let lastErr = null;
  for (const host of hosts) {
    try {
      const transporter = createMailTransport(cfg, host);
      await transporter.sendMail({
        from: `"${cfg.fromName || "findmap"}" <${cfg.fromEmail}>`,
        to: recipient,
        subject: "Test SMTP findmap",
        text: "Day la email test cau hinh SMTP tu findmap.",
        html: "<p>Day la email <strong>test cau hinh SMTP</strong> tu findmap.</p>"
      });
      return { ok: true, host, to: recipient };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, reason: "smtp_send_failed", error: lastErr?.message || "SMTP send failed" };
}

app.get("/api/packages", async (req, res) => {
  res.json({ packages: await listPackages() });
});

app.get("/api/packages/vietqr-status", requireAuth, async (req, res) => {
  res.json({ configured: await isVietQrConfigured() });
});

/** Origin public theo Host / X-Forwarded-* — để client dùng path tương đối đúng subdomain đang mở. */
function requestPublicOrigin(req) {
  const xfProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const xfHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = xfHost || String(req.headers.host || "").trim();
  if (!host) return "";
  const proto = xfProto || (req.secure ? "https" : "http");
  return `${proto}://${host}`.replace(/\/$/, "");
}

app.get("/api/config/origins", (req, res) => {
  const page = requestPublicOrigin(req);
  // Cùng host (nginx chung domain): trả origin đang truy cập — tránh app.* bị ép sang apex.
  if (page && sameNewsOrigin()) {
    return res.json({
      searchOrigin: page,
      newsOrigin: page,
      appOrigin: page
    });
  }
  res.json({
    searchOrigin: appOrigin,
    newsOrigin,
    appOrigin
  });
});

app.get("/api/ext-version", (req, res) => {
  res.json(getExtensionManifestVersion());
});

app.post("/api/auth/login", authWriteRateLimit, guardSensitiveInput("email", "password"), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await loginUser(email, password);
    attachSessionCookie(req, res);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/api/auth/register", authWriteRateLimit, guardSensitiveInput("email", "password"), async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body || {};
    const user = await createUser(email, password, { fullName, phone });
    const result = await loginUser(email, password);
    attachSessionCookie(req, res);
    res.status(201).json({ ok: true, user, token: result.token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/logout", authWriteRateLimit, async (req, res) => {
  await logoutToken(getToken(req));
  clearSessionCookieHeader(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await getUserFromToken(getToken(req));
  if (!user) return res.status(401).json({ error: "Chưa đăng nhập" });
  res.json({ user });
});

app.post("/api/auth/profile", authWriteRateLimit, requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const user = await updateOwnProfile(req.user.id, body);
    const changedPw = !!(String(body.newPassword || "").trim());
    res.json({
      ok: true,
      user,
      message: changedPw ? "Đã cập nhật hồ sơ và mật khẩu" : "Đã cập nhật hồ sơ"
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/accept-terms", authWriteRateLimit, requireAuth, async (req, res) => {
  try {
    const version = req.body?.version || "v1";
    const user = await acceptTerms(req.user.id, version);
    attachSessionCookie(req, res);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/forgot-password", authWriteRateLimit, guardSensitiveInput("email"), async (req, res) => {
  try {
    const { email } = req.body || {};
    const result = await requestPasswordReset(email);
    if (result?.token) {
      const resetLink = `${appOrigin}/dat-lai-mat-khau?token=${result.token}`;
      const mailResult = await sendResetMail({
        to: String(email || "").trim().toLowerCase(),
        resetLink
      });
      console.log(
        `[AUTH] Reset link for ${String(email || "").trim().toLowerCase()}: ${resetLink}`
      );
      if (!mailResult.ok) {
        console.warn(`[AUTH] SMTP chưa gửi được (${mailResult.reason})`);
      }
    }
    res.json({
      ok: true,
      message:
        "Nếu email tồn tại, hệ thống đã gửi hướng dẫn đặt lại mật khẩu. Nếu chưa nhận được, vui lòng liên hệ admin hỗ trợ."
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/reset-password", authWriteRateLimit, guardSensitiveInput("token", "password"), async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await resetPasswordWithToken(token, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/login", authWriteRateLimit, guardSensitiveInput("email", "password"), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await loginAdmin(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/admin/me", async (req, res, next) => {
  try {
    const admin = await getAdminFromToken(getToken(req));
    if (!admin) return res.status(403).json({ error: "Cần đăng nhập quản trị" });
    res.json({ user: admin });
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/packages", requireAdmin, async (req, res) => {
  res.json({ packages: await listPackages() });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const { email, password, packageId, points, fullName, phone } = req.body || {};
    const user = await createUser(email, password, {
      packageId: packageId || null,
      points,
      fullName,
      phone
    });
    res.json({
      user,
      message: `Đã tạo tài khoản ${user.email} — ${user.points} credit`
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
    res.json({ user, message: `Đã cộng ${amount} credit cho ${email}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/points/set", requireAdmin, async (req, res) => {
  try {
    const { email, points } = req.body || {};
    const user = await setUserPoints(email, points);
    res.json({ user, message: `Đã đặt ${user.points} credit cho ${email}` });
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

app.post("/api/admin/users/update-profile", requireAdmin, async (req, res) => {
  try {
    const { email, fullName, phone, newPassword } = req.body || {};
    const user = await adminUpdateUserProfile(email, { fullName, phone, newPassword });
    const changedPw = !!(String(newPassword || "").trim());
    res.json({
      ok: true,
      user,
      message: changedPw
        ? `Đã cập nhật hồ sơ và mật khẩu ${user.email}`
        : `Đã cập nhật hồ sơ ${user.email}`
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
    const orders = await listPackageOrders({
      status,
      paymentConfirmedOnly: status === "pending"
    });
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

app.get("/api/admin/system-config", requireAdmin, async (req, res) => {
  const creditPerPoint = Math.max(0.1, Number(await getSetting("credit_per_point", "1")) || 1);
  const smtp = await getSmtpConfig();
  res.json({
    creditPerPoint,
    smtp: {
      host: smtp.host,
      hostBackup: smtp.hostBackup,
      port: smtp.port,
      secureMode: smtp.secureMode,
      username: smtp.username,
      password: smtp.password,
      fromEmail: smtp.fromEmail,
      fromName: smtp.fromName,
      clientHostname: smtp.clientHostname,
      helo: smtp.helo,
      rerouteAddress: smtp.rerouteAddress
    }
  });
});

app.post("/api/admin/system-config", requireAdmin, async (req, res) => {
  try {
    const raw = req.body?.creditPerPoint;
    const creditPerPoint = Math.max(0.1, Number(raw) || 1);
    const smtp = req.body?.smtp || {};
    const prev = await getSmtpConfig();
    const pick = (incoming, fallback) => {
      const v = String(incoming ?? "").trim();
      return v ? v : String(fallback ?? "").trim();
    };
    await setSetting("credit_per_point", String(creditPerPoint));
    await setSetting("smtp_host", pick(smtp.host, prev.host));
    await setSetting("smtp_host_backup", pick(smtp.hostBackup, prev.hostBackup));
    await setSetting(
      "smtp_port",
      String(Math.max(1, Number(smtp.port) || Number(prev.port) || 465))
    );
    await setSetting(
      "smtp_secure_mode",
      pick(smtp.secureMode, prev.secureMode || "ssl").toLowerCase()
    );
    await setSetting("smtp_username", pick(smtp.username, prev.username));
    if (typeof smtp.password === "string" && smtp.password.trim()) {
      await setSetting("smtp_password", smtp.password.trim());
    }
    await setSetting("smtp_from_email", pick(smtp.fromEmail, prev.fromEmail));
    await setSetting("smtp_from_name", pick(smtp.fromName, prev.fromName));
    await setSetting("smtp_client_hostname", pick(smtp.clientHostname, prev.clientHostname));
    await setSetting("smtp_helo", pick(smtp.helo, prev.helo));
    await setSetting("smtp_reroute_address", pick(smtp.rerouteAddress, prev.rerouteAddress));
    res.json({
      ok: true,
      creditPerPoint,
      message: `Đã lưu cấu hình: ${creditPerPoint} credit / 1 điểm + SMTP`
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Lưu cấu hình thất bại" });
  }
});

app.post("/api/admin/system-config/test-mail", requireAdmin, async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    const result = await sendSmtpTestMail({ to });
    if (!result.ok) {
      return res.status(400).json({
        error:
          result.reason === "smtp_not_configured"
            ? "SMTP chưa cấu hình đủ"
            : result.reason === "smtp_test_recipient_missing"
              ? "Thiếu email nhận test"
              : result.error || "Gửi mail test thất bại"
      });
    }
    return res.json({
      ok: true,
      message: `Đã gửi mail test tới ${result.to} qua ${result.host}`
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Gửi mail test thất bại" });
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
  const pushConfigRaw = await getSetting(`winmap_site_push_config:${userId}`, "");
  const { parsePushConfig } = require("./push-config");
  const pushConfig = parsePushConfig(pushConfigRaw || null);
  return { url, token, label, pushConfig };
}

function siteHost(url, urlMode = "winmap") {
  try {
    return new URL(resolveImportUrl(url, urlMode)).host;
  } catch {
    return "";
  }
}

/** Cấu hình site nhận dữ liệu — dùng cho nút "Gửi về site". Riêng theo từng tài khoản. */
app.get("/api/points/site", requireAuth, async (req, res) => {
  const site = await getWinmapSite(req.user.id);
  const urlMode = site.pushConfig?.urlMode || "winmap";
  res.json({
    url: site.url,
    label: site.label,
    host: siteHost(site.url, urlMode),
    importUrl: site.url ? resolveImportUrl(site.url, urlMode) : "",
    hasToken: Boolean(site.token),
    configured: Boolean(site.url && site.token),
    pushConfig: site.pushConfig
  });
});

/** Lưu site nhận dữ liệu — Winmap hoặc webhook/API tùy chỉnh. */
app.post("/api/points/site", requireAuth, async (req, res) => {
  try {
    const { url, token, label, pushConfig } = req.body || {};
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl) return res.status(400).json({ error: "Thiếu địa chỉ site (vd: demo.winmap.vn hoặc https://api.example.com/hook)" });

    const { parsePushConfig } = require("./push-config");
    const cfg = pushConfig && typeof pushConfig === "object" ? parsePushConfig(pushConfig) : null;
    const urlMode = cfg?.urlMode || "winmap";
    const importUrl = resolveImportUrl(cleanUrl, urlMode);
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
    if (cfg) {
      await setSetting(`winmap_site_push_config:${uid}`, JSON.stringify(cfg));
    }

    const site = await getWinmapSite(uid);
    const savedMode = site.pushConfig?.urlMode || "winmap";
    res.json({
      ok: true,
      message: `Đã lưu site ${siteHost(cleanUrl, savedMode)}`,
      url: site.url,
      label: site.label,
      host: siteHost(site.url, savedMode),
      importUrl: resolveImportUrl(site.url, savedMode),
      hasToken: Boolean(site.token),
      configured: Boolean(site.url && site.token),
      pushConfig: site.pushConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Lỗi lưu site" });
  }
});

/** Chẩn đoán kết nối sang site nhận — không gửi dữ liệu thật. */
app.get("/api/points/ping", requireAuth, async (req, res) => {
  const saved = await getWinmapSite(req.user.id);
  const rawUrl = (req.query.url && String(req.query.url).trim()) || saved.url;
  const token  = (req.query.token && String(req.query.token).trim()) || saved.token;
  const urlMode = req.query.urlMode === "custom" ? "custom" : (saved.pushConfig?.urlMode || "winmap");

  if (!rawUrl) {
    return res.json({ ok: false, configured: false, message: "Chưa lưu site. Nhập địa chỉ và token rồi bấm Lưu." });
  }

  const { clean: importUrl, fallback: fallbackUrl } = resolveImportUrls(rawUrl, { urlMode });

  const report = { configured: Boolean(rawUrl && token), importUrl, fallbackUrl, urlMode, steps: [] };

  let baseUrl;
  if (urlMode === "custom") {
    try {
      baseUrl = new URL(importUrl).origin;
    } catch {
      baseUrl = importUrl;
    }
  } else {
    baseUrl = importUrl.replace(/\/api\/points\/import$/i, "");
  }
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
          message: `403 Forbidden — token không khớp hoặc không có quyền. URL: ${tryUrl}` });
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
      token: saved.token,
      pushConfig: saved.pushConfig
    };
    const result = await pushPointsExternal(points, target);
    if (result.failed > 0 && result.pushed === 0) {
      return res.status(502).json({ error: result.message || "Gửi thất bại", ...result });
    }
    res.json({ ok: true, host: siteHost(target.url, saved.pushConfig?.urlMode), ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Lỗi gửi điểm" });
  }
});

app.get("/api/points/push-config", requireAuth, async (req, res) => {
  const site = await getWinmapSite(req.user.id);
  const urlMode = site.pushConfig?.urlMode || "winmap";
  res.json({
    configured: Boolean(site.url && site.token),
    url: site.url,
    host: siteHost(site.url, urlMode),
    importUrl: site.url ? resolveImportUrl(site.url, urlMode) : "",
    hasToken: Boolean(site.token),
    pushConfig: site.pushConfig
  });
});

const webDir = path.join(__dirname, "..", "web");
const landingDir = path.join(__dirname, "..", "landing");
const landingIndexHtml = path.join(landingDir, "index.html");

function sendWebPage(res, file) {
  res.sendFile(path.join(webDir, file));
}

function redirectToNews(req, res) {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  // Cùng domain reverse-proxy: redirect tương đối (giữ app.findmap.vn / findmap.vn).
  if (sameNewsOrigin()) {
    return res.redirect(302, `${req.path}${qs}`);
  }
  res.redirect(302, `${newsOrigin}${req.path}${qs}`);
}

function redirectGioiThieuToHome(req, res) {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/${qs}`);
}

function sameNewsOrigin() {
  try {
    return new URL(newsOrigin).host === new URL(appOrigin).host;
  } catch {
    return newsOrigin.replace(/\/+$/, "") === appOrigin.replace(/\/+$/, "");
  }
}

/** Tin tức / giới thiệu / CMS đã tách sang hệ news — chuyển hướng. */
app.get("/gioi-thieu", redirectGioiThieuToHome);
[
  "/tin-tuc",
  "/sitemap.xml",
  "/admin-post-article",
  "/admin-post-editor",
  "/admin-post-categories",
  "/admin-post-seo",
  "/admin-post-trash",
  "/admin-post-media",
  "/preview-bai-viet",
  "/cms",
  "/login-admin-post"
].forEach((route) => {
  app.get(route, redirectToNews);
});
app.get(/^\/tin-tuc(\/.*)?$/, redirectToNews);
app.get(/^\/admin-post-/, redirectToNews);
app.get(/^\/media(\/.*)?$/, redirectToNews);
app.get(/^\/landing(\/.*)?$/, redirectToNews);

app.get("/robots.txt", (req, res) => {
  const origin = requestPublicOrigin(req) || newsOrigin;
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /nap-diem",
    "Disallow: /dat-lai-mat-khau",
    "Disallow: /quen-mat-khau",
    `Sitemap: ${origin}/sitemap.xml`,
    ""
  ].join("\n");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("text/plain; charset=utf-8").send(body);
});

app.get("/login-admin", (_req, res) => res.redirect(301, "/login"));

const webPages = {
  "/login": "login.html",
  "/admin": "admin.html",
  "/nap-diem": "nap-diem.html",
  "/cau-hinh-site": "cau-hinh-site.html",
  "/quen-mat-khau": "quen-mat-khau.html",
  "/dat-lai-mat-khau": "dat-lai-mat-khau.html"
};

for (const [route, file] of Object.entries(webPages)) {
  app.get(route, (req, res) => sendWebPage(res, file));
}

/** Trang tìm điểm — alias cũ → "/" (một URL duy nhất). */
app.get("/app", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/${qs}`);
});

app.get("/", (req, res) => {
  if (hasSessionCookie(req)) {
    return sendWebPage(res, "index.html");
  }
  // Cùng domain: trả HTML giới thiệu tại "/" (không redirect — tránh vòng lặp)
  if (sameNewsOrigin() && fs.existsSync(landingIndexHtml)) {
    return res.sendFile(landingIndexHtml);
  }
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  if (sameNewsOrigin()) {
    return res.redirect(302, `/${qs}`);
  }
  res.redirect(302, `${newsOrigin}/${qs}`);
});

const legacyHtmlRedirects = {
  "/login.html": "/login",
  "/admin.html": "/admin",
  "/login-admin.html": "/login",
  "/nap-diem.html": "/nap-diem",
  "/cau-hinh-site.html": "/cau-hinh-site",
  "/quen-mat-khau.html": "/quen-mat-khau",
  "/dat-lai-mat-khau.html": "/dat-lai-mat-khau",
  "/index.html": "/",
  "/cms.html": `${newsOrigin}/admin-post-article`,
  "/admin-post-article.html": `${newsOrigin}/admin-post-article`,
  "/preview-bai-viet.html": `${newsOrigin}/preview-bai-viet`
};

for (const [from, to] of Object.entries(legacyHtmlRedirects)) {
  app.get(from, (req, res) => {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(301, to.startsWith("http") ? to + qs : to + qs);
  });
}

app.use(
  express.static(webDir, {
    setHeaders(res, filePath) {
      // Tránh cache cứng HTML/JS/CSS — prod hay giữ bản cũ (panel GPS ảnh 2)
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    }
  })
);

const { execSync } = require("child_process");

function freePort(port) {
  const self = String(process.pid);
  if (process.platform === "win32") {
    let out = "";
    try {
      out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return false;
    }
    const pids = new Set();
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.trim().match(/\s(\d+)\s*$/);
      if (m && m[1] !== self) pids.add(m[1]);
    }
    let killed = false;
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        killed = true;
      } catch {
        /* ignore */
      }
    }
    return killed;
  }
  try {
    execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
    return true;
  } catch {
    try {
      const out = execSync(`lsof -ti tcp:${port}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      for (const pid of String(out).split(/\s+/).filter(Boolean)) {
        if (pid === self) continue;
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          /* ignore */
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}

function startServer(retried = false) {
  const server = app.listen(PORT, () => {
    console.log(`Hệ tìm kiếm: ${appOrigin}`);
    console.log(`Trang quản trị: ${appOrigin}/admin`);
    console.log(`Đăng nhập: ${appOrigin}/login`);
    console.log(`Hệ tin tức / CMS: ${newsOrigin}`);
    console.log(`Quên MK: ${appOrigin}/quen-mat-khau`);
    console.log(
      `Database: MySQL (${process.env.MYSQL_HOST || "localhost"}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || "timdiemban"})`
    );
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !retried) {
      console.warn(`Port ${PORT} đang bận — đang tắt process cũ rồi chạy lại…`);
      freePort(PORT);
      setTimeout(() => startServer(true), 600);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(`Không mở được port ${PORT} (vẫn bị chiếm).`);
      process.exit(1);
    }
    throw err;
  });
}

startServer();
