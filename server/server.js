// â€”â€”â€” Load .env náº¿u cÃ³ â€”â€”â€”
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
const {
  getUserSearchResults,
  saveUserSearchResults,
  deleteUserSearchResults
} = require("./search-results-store");
const {
  JobsIntegrationError,
  createJobsIntegrationService
} = require("./jobs-integration");
const { getProvinces, getWards, getWardBoundary, getWardInfo, getProvinceInfo, getProvinceBoundary } = require("./geo-api");

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

// â€”â€”â€” Khá»Ÿi táº¡o database â€”â€”â€”
let dbReady = false;
async function initDatabase() {
  await dbModule.initDb();
  dbReady = true;
}
initDatabase().catch((err) => {
  console.error("[DB] Lá»—i khá»Ÿi táº¡o:", err.message);
  console.error("Kiá»ƒm tra cáº¥u hÃ¬nh MySQL trong server/.env");
  process.exit(1);
});

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
    // Chá»‰ alias apex/www thuá»™c á»©ng dá»¥ng Findmap hiá»‡n táº¡i.
    if (host === "findmap.vn" || host.endsWith(".findmap.vn")) {
      out.add(`${u.protocol}//findmap.vn`);
      out.add(`${u.protocol}//www.findmap.vn`);
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
  "https://www.findmap.vn"
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

/** Origin / Referer há»£p lá»‡: allowlist + cÃ¹ng há»‡ findmap.vn + host cá»§a APP/NEWS_ORIGIN */
function isAllowedWebOrigin(originOrUrl) {
  const raw = String(originOrUrl || "").trim();
  if (!raw) return true;
  const normalized = raw.replace(/\/$/, "");
  if (allowedOrigins.has(normalized)) return true;
  // Referer cÃ³ path â†’ so khá»›p prefix allowlist
  if ([...allowedOrigins].some((o) => raw === o || raw.startsWith(`${o}/`))) return true;

  const host = hostnameOf(raw.includes("://") ? raw : `https://${raw}`);
  if (!host) return false;
  if (host === "findmap.vn" || host === "www.findmap.vn") return true;
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
      return res.status(429).json({ error: "QuÃ¡ nhiá»u yÃªu cáº§u, vui lÃ²ng thá»­ láº¡i sau." });
    }
    next();
  };
}

const apiRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 600, keyPrefix: "api" });
const authWriteRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyPrefix: "authw" });
const jobsIntegrationRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyPrefix: "jobs-integration"
});

function sanitizeValue(val, key) {
  // KhÃ´ng lÃ m biáº¿n dáº¡ng máº­t kháº©u (kÃ½ tá»± Ä‘áº·c biá»‡t há»£p lá»‡).
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
        return res.status(400).json({ error: "Dá»¯ liá»‡u Ä‘áº§u vÃ o khÃ´ng há»£p lá»‡." });
      }
    }
    next();
  };
}

function csrfOriginGuard(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // Server Jobs chá»‰ kÃ­ch hoáº¡t Ä‘á»‘i soÃ¡t; Findmap váº«n tá»± xÃ¡c minh token vá»›i Jobs trÆ°á»›c khi thu há»“i.
  if (req.path === "/api/integrations/jobs/reconcile") return next();
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  if (!isAllowedWebOrigin(origin) || !isAllowedWebOrigin(referer)) {
    return res.status(403).json({ error: "CSRF blocked: origin khÃ´ng há»£p lá»‡." });
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
app.use(express.json({ limit: "10mb" }));
app.use(requestSanitizer);
app.use(csrfOriginGuard);
app.use("/api/", apiRateLimit);

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "JSON khÃ´ng há»£p lá»‡ â€” kiá»ƒm tra Content-Type vÃ  ná»™i dung request" });
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
    if (!user) return res.status(401).json({ error: "ChÆ°a Ä‘Äƒng nháº­p hoáº·c phiÃªn háº¿t háº¡n" });
    req.user = user;
    // Gia háº¡n cookie routing khi cÃ²n hoáº¡t Ä‘á»™ng
    attachSessionCookie(req, res);
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const admin = await getAdminFromToken(getToken(req));
    if (!admin) return res.status(403).json({ error: "Cáº§n Ä‘Äƒng nháº­p quáº£n trá»‹ viÃªn há»‡ thá»‘ng" });
    req.admin = admin;
    next();
  } catch (err) {
    next(err);
  }
}

const jobsIntegration = createJobsIntegrationService({ db: dbModule });

function sendJobsIntegrationError(res, error) {
  const status = error instanceof JobsIntegrationError ? error.status : 500;
  if (!(error instanceof JobsIntegrationError)) {
    console.error("[Jobs integration]", error?.message || error);
  }
  return res.status(status).json({
    error: error?.message || "KhÃ´ng xá»­ lÃ½ Ä‘Æ°á»£c yÃªu cáº§u tÃ­ch há»£p Jobs ClickOn.",
    code: error instanceof JobsIntegrationError ? error.code : "jobs_integration_error"
  });
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

  // Æ¯u tiÃªn API v2 khi cÃ³ Client ID + API Key
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
        console.warn("[VietQR v2]", err.message, "â€” fallback Quick Link");
      }
    }
  }

  // Fallback: Quick Link img.vietqr.io (khÃ´ng cáº§n API key)
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
        subject: "Äáº·t láº¡i máº­t kháº©u findmap",
        text: `Báº¡n vá»«a yÃªu cáº§u Ä‘áº·t láº¡i máº­t kháº©u.\n\nNháº¥n link sau Ä‘á»ƒ Ä‘á»•i máº­t kháº©u:\n${resetLink}\n\nNáº¿u khÃ´ng pháº£i báº¡n yÃªu cáº§u, hÃ£y bá» qua email nÃ y.`,
        html: `
          <p>Báº¡n vá»«a yÃªu cáº§u Ä‘áº·t láº¡i máº­t kháº©u.</p>
          <p><a href="${resetLink}">Báº¥m vÃ o Ä‘Ã¢y Ä‘á»ƒ Ä‘á»•i máº­t kháº©u</a></p>
          <p>Náº¿u khÃ´ng pháº£i báº¡n yÃªu cáº§u, hÃ£y bá» qua email nÃ y.</p>
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

/** Origin public theo Host / X-Forwarded-* â€” Ä‘á»ƒ client dÃ¹ng path tÆ°Æ¡ng Ä‘á»‘i Ä‘Ãºng subdomain Ä‘ang má»Ÿ. */
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
  // CÃ¹ng host (nginx chung domain): tráº£ origin Ä‘ang truy cáº­p â€” trÃ¡nh app.* bá»‹ Ã©p sang apex.
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

app.get("/api/geo/provinces", getProvinces);
app.get("/api/geo/wards", getWards);
app.get("/api/geo/ward-boundary/:code", getWardBoundary);
app.get("/api/geo/ward-info/:code", getWardInfo);
app.get("/api/geo/province-boundary/:code", getProvinceBoundary);
app.get("/api/geo/province-info/:code", getProvinceInfo);

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
  if (!user) return res.status(401).json({ error: "ChÆ°a Ä‘Äƒng nháº­p" });
  // Gia háº¡n cookie routing + sliding token (touch trong getTokenRow)
  attachSessionCookie(req, res);
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
      message: changedPw ? "ÄÃ£ cáº­p nháº­t há»“ sÆ¡ vÃ  máº­t kháº©u" : "ÄÃ£ cáº­p nháº­t há»“ sÆ¡"
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

app.get("/api/integrations/jobs/status", jobsIntegrationRateLimit, requireAuth, async (req, res) => {
  try {
    const verify = String(req.query.verify || "") === "1";
    res.json(await jobsIntegration.status(req.user.id, { verify }));
  } catch (error) {
    sendJobsIntegrationError(res, error);
  }
});

app.post("/api/integrations/jobs/reconcile", jobsIntegrationRateLimit, async (req, res) => {
  try {
    res.json(
      await jobsIntegration.reconcileRevocation(
        req.body?.findmap_user_id,
        req.body?.jobs_user_id
      )
    );
  } catch (error) {
    sendJobsIntegrationError(res, error);
  }
});

app.post("/api/integrations/jobs/request-preview", jobsIntegrationRateLimit, requireAuth, async (req, res) => {
  try {
    res.json(await jobsIntegration.previewRequest(req.body?.request_token));
  } catch (error) {
    sendJobsIntegrationError(res, error);
  }
});

app.post("/api/integrations/jobs/connect", jobsIntegrationRateLimit, requireAuth, async (req, res) => {
  try {
    res.json(await jobsIntegration.connect(req.user, req.body?.request_token || req.body?.pairing_code));
  } catch (error) {
    sendJobsIntegrationError(res, error);
  }
});

app.post("/api/integrations/jobs/request-decline", jobsIntegrationRateLimit, requireAuth, async (req, res) => {
  try {
    res.json(await jobsIntegration.declineRequest(req.body?.request_token));
  } catch (error) {
    sendJobsIntegrationError(res, error);
  }
});

app.delete("/api/integrations/jobs/disconnect", jobsIntegrationRateLimit, requireAuth, async (req, res) => {
  try {
    res.json(await jobsIntegration.disconnect(req.user.id));
  } catch (error) {
    sendJobsIntegrationError(res, error);
  }
});

app.post("/api/integrations/jobs/sync-customers", jobsIntegrationRateLimit, requireAuth, async (req, res) => {
  try {
    res.json(
      await jobsIntegration.syncCustomers(
        req.user.id,
        req.body?.items,
        req.body?.request_id
      )
    );
  } catch (error) {
    sendJobsIntegrationError(res, error);
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
        console.warn(`[AUTH] SMTP chÆ°a gá»­i Ä‘Æ°á»£c (${mailResult.reason})`);
      }
    }
    res.json({
      ok: true,
      message:
        "Náº¿u email tá»“n táº¡i, há»‡ thá»‘ng Ä‘Ã£ gá»­i hÆ°á»›ng dáº«n Ä‘áº·t láº¡i máº­t kháº©u. Náº¿u chÆ°a nháº­n Ä‘Æ°á»£c, vui lÃ²ng liÃªn há»‡ admin há»— trá»£."
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
    if (!admin) return res.status(403).json({ error: "Cáº§n Ä‘Äƒng nháº­p quáº£n trá»‹" });
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
      message: `ÄÃ£ táº¡o tÃ i khoáº£n ${user.email} â€” ${user.points} credit`
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
    res.json({ user, message: `ÄÃ£ cá»™ng ${amount} credit cho ${email}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/points/set", requireAdmin, async (req, res) => {
  try {
    const { email, points } = req.body || {};
    const user = await setUserPoints(email, points);
    res.json({ user, message: `ÄÃ£ Ä‘áº·t ${user.points} credit cho ${email}` });
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
      message: user.isActive ? `ÄÃ£ má»Ÿ khÃ³a ${email}` : `ÄÃ£ khÃ³a ${email}`
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
        ? `ÄÃ£ cáº­p nháº­t há»“ sÆ¡ vÃ  máº­t kháº©u ${user.email}`
        : `ÄÃ£ cáº­p nháº­t há»“ sÆ¡ ${user.email}`
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/packages/purchase", requireAuth, async (req, res) => {
  try {
    const packageId = String(req.body?.packageId || "").trim();
    if (!packageId) return res.status(400).json({ error: "Thiáº¿u mÃ£ gÃ³i" });
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
      return res.status(400).json({ error: "Chá»©c nÄƒng nÃ y yÃªu cáº§u MySQL" });
    }
    if (!(await isVietQrConfigured())) {
      return res.status(400).json({
        error: "Admin chÆ°a cáº¥u hÃ¬nh VietQR â€” vui lÃ²ng liÃªn há»‡ admin trÆ°á»›c khi xÃ¡c nháº­n thanh toÃ¡n"
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
      return res.status(400).json({ error: "Chá»©c nÄƒng há»§y Ä‘Æ¡n chÆ°a kháº£ dá»¥ng" });
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
      return res.status(400).json({ error: "Chá»©c nÄƒng nÃ y yÃªu cáº§u MySQL" });
    }
    const order = await getPackageOrderById(req.params.id);
    if (!order || order.userId !== req.user.id) {
      return res.status(404).json({ error: "KhÃ´ng tÃ¬m tháº¥y Ä‘Æ¡n hÃ ng" });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ error: "ÄÆ¡n khÃ´ng cÃ²n á»Ÿ tráº¡ng thÃ¡i chá» thanh toÃ¡n" });
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

// â€”â€”â€” LÆ°u / khÃ´i phá»¥c káº¿t quáº£ tÃ¬m kiáº¿m theo tÃ i khoáº£n â€”â€”â€”
app.get("/api/search/results", requireAuth, async (req, res) => {
  try {
    const result = await getUserSearchResults(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/search/results", requireAuth, async (req, res) => {
  try {
    const result = await saveUserSearchResults(req.user.id, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/search/results", requireAuth, async (req, res) => {
  try {
    const result = await deleteUserSearchResults(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// â€”â€”â€” Admin VietQR config â€”â€”â€”
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
        ? "ÄÃ£ lÆ°u â€” VietQR API v2 sáºµn sÃ ng (Client ID + API Key + STK + BIN)"
        : "ÄÃ£ lÆ°u STK ngÃ¢n hÃ ng. Äá»ƒ dÃ¹ng API v2: nháº­p Client ID, API Key vÃ  mÃ£ BIN (6 sá»‘).",
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
      message: `ÄÃ£ lÆ°u cáº¥u hÃ¬nh: ${creditPerPoint} credit / 1 Ä‘iá»ƒm + SMTP`
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "LÆ°u cáº¥u hÃ¬nh tháº¥t báº¡i" });
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
            ? "SMTP chÆ°a cáº¥u hÃ¬nh Ä‘á»§"
            : result.reason === "smtp_test_recipient_missing"
              ? "Thiáº¿u email nháº­n test"
              : result.error || "Gá»­i mail test tháº¥t báº¡i"
      });
    }
    return res.json({
      ok: true,
      message: `ÄÃ£ gá»­i mail test tá»›i ${result.to} qua ${result.host}`
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Gá»­i mail test tháº¥t báº¡i" });
  }
});

/** Admin test táº¡o QR thá»­ (API v2 hoáº·c Quick Link) */
app.post("/api/admin/vietqr-test", requireAdmin, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 99000;
    const fakeOrder = {
      id: "ord_test_preview",
      paymentAmount: amount
    };
    const payment = await buildVietQrPayment(fakeOrder);
    if (!payment?.qrUrl) {
      return res.status(400).json({ error: "ChÆ°a Ä‘á»§ cáº¥u hÃ¬nh â€” kiá»ƒm tra STK, mÃ£ NH vÃ  API Key" });
    }
    res.json({
      ok: true,
      qrUrl: payment.qrUrl,
      qrMethod: payment.method,
      paymentInfo: payment.paymentInfo,
      message: payment.method === "api-v2" ? "QR táº¡o qua API v2" : "QR táº¡o qua Quick Link"
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Láº¥y site Winmap â€” CHá»ˆ theo tÃ i khoáº£n Ä‘ang Ä‘Äƒng nháº­p (má»—i user 1 site + token riÃªng).
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

/** Cáº¥u hÃ¬nh site nháº­n dá»¯ liá»‡u â€” dÃ¹ng cho nÃºt "Gá»­i vá» site". RiÃªng theo tá»«ng tÃ i khoáº£n. */
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

/** LÆ°u site nháº­n dá»¯ liá»‡u â€” Winmap hoáº·c webhook/API tÃ¹y chá»‰nh. */
app.post("/api/points/site", requireAuth, async (req, res) => {
  try {
    const { url, token, label, pushConfig } = req.body || {};
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl) return res.status(400).json({ error: "Thiáº¿u Ä‘á»‹a chá»‰ site (vd: demo.winmap.vn hoáº·c https://api.example.com/hook)" });

    const { parsePushConfig } = require("./push-config");
    const cfg = pushConfig && typeof pushConfig === "object" ? parsePushConfig(pushConfig) : null;
    const urlMode = cfg?.urlMode || "winmap";
    const importUrl = resolveImportUrl(cleanUrl, urlMode);
    try {
      // eslint-disable-next-line no-new
      new URL(importUrl);
    } catch {
      return res.status(400).json({ error: "Äá»‹a chá»‰ site khÃ´ng há»£p lá»‡" });
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
      message: `ÄÃ£ lÆ°u site ${siteHost(cleanUrl, savedMode)}`,
      url: site.url,
      label: site.label,
      host: siteHost(site.url, savedMode),
      importUrl: resolveImportUrl(site.url, savedMode),
      hasToken: Boolean(site.token),
      configured: Boolean(site.url && site.token),
      pushConfig: site.pushConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Lá»—i lÆ°u site" });
  }
});

/** Cháº©n Ä‘oÃ¡n káº¿t ná»‘i sang site nháº­n â€” khÃ´ng gá»­i dá»¯ liá»‡u tháº­t. */
app.get("/api/points/ping", requireAuth, async (req, res) => {
  const saved = await getWinmapSite(req.user.id);
  const rawUrl = (req.query.url && String(req.query.url).trim()) || saved.url;
  const token  = (req.query.token && String(req.query.token).trim()) || saved.token;
  const urlMode = req.query.urlMode === "custom" ? "custom" : (saved.pushConfig?.urlMode || "winmap");

  if (!rawUrl) {
    return res.json({ ok: false, configured: false, message: "ChÆ°a lÆ°u site. Nháº­p Ä‘á»‹a chá»‰ vÃ  token rá»“i báº¥m LÆ°u." });
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
    return res.json({ ok: false, ...report, message: `KhÃ´ng káº¿t ná»‘i Ä‘Æ°á»£c tá»›i ${baseUrl}: ${e.message}` });
  }

  // Thá»­ POST tá»›i import URL vá»›i payload rá»—ng (Ä‘á»ƒ kiá»ƒm tra auth)
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
          message: `403 Forbidden â€” token khÃ´ng khá»›p hoáº·c khÃ´ng cÃ³ quyá»n. URL: ${tryUrl}` });
      }
      if (r.status === 404 && tryUrl === importUrl) {
        report.steps.push({ note: "Clean URL 404, thá»­ fallback ?q= ..." });
        continue;
      }
      if (r.ok || r.status < 500) {
        return res.json({ ok: true, ...report, usedUrl: tryUrl,
          message: `Káº¿t ná»‘i OK (HTTP ${r.status}) â€” ${tryUrl}` });
      }
      return res.json({ ok: false, ...report, usedUrl: tryUrl,
        message: `HTTP ${r.status} tá»« ${tryUrl}` });
    } catch (e) {
      report.steps.push({ url: tryUrl, status: 0, ok: false, error: e.message });
    }
  }

  return res.json({ ok: false, ...report, message: `KhÃ´ng gá»i Ä‘Æ°á»£c API import. Kiá»ƒm tra log server XAMPP (error_log).` });
});

/** Gá»­i Ä‘iá»ƒm bÃ¡n sang site Winmap Ä‘Ã£ lÆ°u (hoáº·c site truyá»n kÃ¨m trong body). */
app.post("/api/points/push", requireAuth, async (req, res) => {
  try {
    const { points, site } = req.body || {};
    if (!Array.isArray(points) || !points.length) {
      return res.status(400).json({ error: "Danh sÃ¡ch Ä‘iá»ƒm trá»‘ng" });
    }
    const saved = await getWinmapSite(req.user.id);
    const target = {
      url: (site && String(site).trim()) || saved.url,
      token: saved.token,
      pushConfig: saved.pushConfig
    };
    const result = await pushPointsExternal(points, target);
    if (result.failed > 0 && result.pushed === 0) {
      return res.status(502).json({ error: result.message || "Gá»­i tháº¥t báº¡i", ...result });
    }
    res.json({ ok: true, host: siteHost(target.url, saved.pushConfig?.urlMode), ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Lá»—i gá»­i Ä‘iá»ƒm" });
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
  // CÃ¹ng domain reverse-proxy: redirect tÆ°Æ¡ng Ä‘á»‘i Ä‘á»ƒ giá»¯ host Findmap hiá»‡n táº¡i.
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

/** Tin tá»©c / giá»›i thiá»‡u / CMS Ä‘Ã£ tÃ¡ch sang há»‡ news â€” chuyá»ƒn hÆ°á»›ng. */
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
// Landing assets: /landing/styles.css, /landing/script.js, /landing/assets/*
// Do NOT redirect /landing/* to news — that breaks CSS/JS on the homepage.
app.use(
  "/landing",
  express.static(landingDir, {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    }
  })
);

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
  "/ket-noi-jobs": "ket-noi-jobs.html",
  "/chinh-sach-quyen-rieng-tu": "privacy-policy.html",
  "/privacy-policy": "privacy-policy.html",
  "/quen-mat-khau": "quen-mat-khau.html",
  "/dat-lai-mat-khau": "dat-lai-mat-khau.html"
};

for (const [route, file] of Object.entries(webPages)) {
  app.get(route, (req, res) => sendWebPage(res, file));
}

/** Trang tÃ¬m Ä‘iá»ƒm â€” alias cÅ© â†’ "/" (má»™t URL duy nháº¥t). */
app.get("/app", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/${qs}`);
});

app.get("/", (req, res) => {
  if (hasSessionCookie(req)) {
    return sendWebPage(res, "index.html");
  }
  // CÃ¹ng domain: tráº£ HTML giá»›i thiá»‡u táº¡i "/" (khÃ´ng redirect â€” trÃ¡nh vÃ²ng láº·p)
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
  "/ket-noi-jobs.html": "/ket-noi-jobs",
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
      // TrÃ¡nh cache cá»©ng HTML/JS/CSS â€” prod hay giá»¯ báº£n cÅ© (panel GPS áº£nh 2)
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
    console.log(`Há»‡ tÃ¬m kiáº¿m: ${appOrigin}`);
    console.log(`Trang quáº£n trá»‹: ${appOrigin}/admin`);
    console.log(`ÄÄƒng nháº­p: ${appOrigin}/login`);
    console.log(`Há»‡ tin tá»©c / CMS: ${newsOrigin}`);
    console.log(`QuÃªn MK: ${appOrigin}/quen-mat-khau`);
    console.log(
      `Database: MySQL (${process.env.MYSQL_HOST || "localhost"}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || "timdiemban"})`
    );
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !retried) {
      console.warn(`Port ${PORT} Ä‘ang báº­n â€” Ä‘ang táº¯t process cÅ© rá»“i cháº¡y láº¡iâ€¦`);
      freePort(PORT);
      setTimeout(() => startServer(true), 600);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(`KhÃ´ng má»Ÿ Ä‘Æ°á»£c port ${PORT} (váº«n bá»‹ chiáº¿m).`);
      process.exit(1);
    }
    throw err;
  });
}

startServer();
