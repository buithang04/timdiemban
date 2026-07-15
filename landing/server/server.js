/**
 * Findmap News server — tin tức + CMS + trang giới thiệu
 * Database: findmap_news (tách khỏi timdiemban)
 */
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

const newsConfig = require("../config/app-config");
const rootAppConfig = require(path.join(__dirname, "..", "..", "config", "app-config.js"));
const dbModule = require("./db");
const auth = require("./auth");
const { createCmsRouter, buildSitemapXml, cms } = require("./cms-routes");

const { getSetting, setSetting } = dbModule;
const PORT = Number(process.env.NEWS_PORT || process.env.PORT || 3001);
const appOrigin = String(
  process.env.NEWS_ORIGIN || newsConfig.NEWS_ORIGIN || `http://localhost:${PORT}`
).replace(/\/+$/, "");
const searchOrigin = String(
  process.env.SEARCH_ORIGIN || newsConfig.SEARCH_ORIGIN || "http://localhost:3000"
).replace(/\/+$/, "");

async function initDatabase() {
  await dbModule.initDb();
}
initDatabase().catch((err) => {
  console.error("[DB] Lỗi khởi tạo:", err.message);
  console.error("Kiểm tra MySQL / MYSQL_* trong landing/server/.env");
  process.exit(1);
});

const app = express();
app.disable("x-powered-by");
app.use(
  cors({
    origin: true,
    credentials: true
  })
);

const HTML_ALLOW_KEYS = new Set(["content_html", "contentHtml", "html", "body_html"]);
app.use(express.json({ limit: "6mb" }));
app.use((req, _res, next) => {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string" && !HTML_ALLOW_KEYS.has(key)) {
        req.body[key] = req.body[key].replace(/[<>]/g, "");
      }
    }
  }
  next();
});

function getToken(req) {
  const h = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  return String(req.headers["x-auth-token"] || "").trim();
}

async function requireCms(req, res, next) {
  try {
    const staff = await auth.getStaffFromToken(getToken(req));
    if (!staff) return res.status(401).json({ error: "Unauthorized" });
    req.user = staff;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireCmsAdmin(req, res, next) {
  try {
    const admin = await auth.getAdminFromToken(getToken(req));
    if (!admin) return res.status(403).json({ error: "Chỉ admin CMS" });
    req.user = admin;
    next();
  } catch (err) {
    next(err);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, system: "findmap-news", origin: appOrigin });
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const result = await auth.loginStaff(req.body?.email, req.body?.password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Đăng nhập thất bại" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    await auth.logoutToken(getToken(req));
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.get("/api/auth/me", async (req, res) => {
  const staff = await auth.getStaffFromToken(getToken(req));
  if (!staff) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: staff });
});

/** CMS client (cms-api.js) gọi /api/admin/me */
app.get("/api/admin/me", async (req, res) => {
  const staff = await auth.getStaffFromToken(getToken(req));
  if (!staff) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: staff });
});

app.get("/api/admin/editors", requireCmsAdmin, async (_req, res) => {
  res.json({ editors: await auth.listEditors() });
});

app.post("/api/admin/editors", requireCmsAdmin, async (req, res) => {
  try {
    const editor = await auth.createEditor(
      req.body?.email,
      req.body?.password,
      req.body?.fullName || req.body?.full_name
    );
    res.json({ editor });
  } catch (err) {
    res.status(400).json({ error: err.message || "Không tạo được editor" });
  }
});

app.patch("/api/admin/editors/:id", requireCmsAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (req.body?.password) {
      await auth.resetEditorPassword(id, req.body.password);
    }
    if (typeof req.body?.isActive === "boolean" || typeof req.body?.active === "boolean") {
      const active = typeof req.body.isActive === "boolean" ? req.body.isActive : req.body.active;
      await auth.setEditorActive(id, active);
    }
    const editors = await auth.listEditors();
    res.json({ editors, editor: editors.find((e) => e.id === id) || null });
  } catch (err) {
    res.status(400).json({ error: err.message || "Cập nhật thất bại" });
  }
});

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

function sameSearchNewsHost() {
  try {
    return new URL(searchOrigin).host === new URL(appOrigin).host;
  } catch {
    return searchOrigin.replace(/\/+$/, "") === appOrigin.replace(/\/+$/, "");
  }
}

app.get("/api/config/origins", (req, res) => {
  const page = requestPublicOrigin(req);
  if (page && sameSearchNewsHost()) {
    return res.json({ newsOrigin: page, searchOrigin: page });
  }
  res.json({ newsOrigin: appOrigin, searchOrigin });
});

app.use(
  createCmsRouter({
    requireCms,
    getSetting,
    setSetting,
    appOrigin
  })
);

app.get("/sitemap.xml", async (req, res) => {
  try {
    const origin =
      String(appOrigin || "").replace(/\/+$/, "") ||
      `${req.protocol}://${req.get("host")}`;
    const xml = await buildSitemapXml(origin);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("application/xml").send(xml);
  } catch {
    res.status(500).send("Sitemap error");
  }
});

app.get("/robots.txt", (req, res) => {
  const origin =
    String(appOrigin || "").replace(/\/+$/, "") ||
    `${req.protocol}://${req.get("host")}`;
  const body = [
    "User-agent: *",
    "Allow: /",
    "Allow: /tin-tuc",
    "Allow: /media/",
    "Disallow: /login",
    "Disallow: /admin-post-",
    "Disallow: /preview-bai-viet",
    "Disallow: /api/",
    `Sitemap: ${origin}/sitemap.xml`,
    ""
  ].join("\n");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("text/plain; charset=utf-8").send(body);
});

const rootDir = path.join(__dirname, "..");
const webDir = path.join(rootDir, "web");
const tinTucDir = path.join(webDir, "tin-tuc");
/** Assets trang giới thiệu nằm ngay root folder landing/ */
const publicLandingDir = rootDir;

function sendTinTucPage(res, file) {
  res.sendFile(path.join(tinTucDir, file));
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicLandingDir, "index.html"));
});
app.get("/gioi-thieu", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/${qs}`);
});

app.get("/tin-tuc", (_req, res) => sendTinTucPage(res, "tin-tuc.html"));
app.get("/admin-post-article", (_req, res) => sendTinTucPage(res, "admin-post-article.html"));
app.get("/admin-post-editor", (_req, res) => sendTinTucPage(res, "admin-post-editor.html"));
app.get("/admin-post-categories", (_req, res) => sendTinTucPage(res, "admin-post-categories.html"));
app.get("/admin-post-seo", (_req, res) => sendTinTucPage(res, "admin-post-seo.html"));
app.get("/admin-post-trash", (_req, res) => sendTinTucPage(res, "admin-post-trash.html"));
app.get("/admin-post-media", (_req, res) => sendTinTucPage(res, "admin-post-media.html"));
app.get("/preview-bai-viet", (_req, res) => sendTinTucPage(res, "preview-bai-viet.html"));
app.get("/login", (_req, res) => res.sendFile(path.join(webDir, "login.html")));
app.get("/login-admin-post", (_req, res) => res.sendFile(path.join(webDir, "login.html")));

app.use("/media", express.static(path.join(webDir, "media"), { index: false, fallthrough: true, maxAge: "7d" }));
app.use("/tin-tuc", express.static(tinTucDir, { index: false, fallthrough: true }));
app.use("/landing", express.static(publicLandingDir));
app.use("/assets", express.static(path.join(webDir, "assets")));

/** Config browser — theo Host đang mở (path tương đối), không cứng findmap.vn. */
app.get("/app-config.js", (req, res) => {
  const page = requestPublicOrigin(req);
  const search = page && sameSearchNewsHost() ? page : searchOrigin;
  const news = page && sameSearchNewsHost() ? page : appOrigin;
  const body = `/**
 * Runtime app-config — theo Host request (giữ app.findmap.vn / findmap.vn).
 */
function __findmapPageOrigin(fallback) {
  try {
    if (typeof location !== "undefined" && /^https?:$/i.test(location.protocol || "")) {
      return location.origin;
    }
  } catch {}
  return String(fallback || "").replace(/\\/+$/, "");
}
const TIMDIEMBAN_CONFIG = {
  APP_ORIGIN: __findmapPageOrigin(${JSON.stringify(search)}),
  NEWS_ORIGIN: __findmapPageOrigin(${JSON.stringify(news)}),
  SEARCH_ORIGIN: __findmapPageOrigin(${JSON.stringify(search)}),
  MAPS_AUTO_FOCUS_MINUTES: 2,
  MAPS_AUTO_REOPEN_MAX: 5,
  EXTENSION_INSTALL_URL: ${JSON.stringify(String(process.env.EXTENSION_INSTALL_URL || rootAppConfig.EXTENSION_INSTALL_URL || ""))}
};
if (typeof globalThis !== "undefined") {
  globalThis.TIMDIEMBAN_CONFIG = TIMDIEMBAN_CONFIG;
}
`;
  res.setHeader("Cache-Control", "no-store");
  res.type("application/javascript").send(body);
});

app.get("/tin-tuc/:slug", async (req, res, next) => {
  try {
    const resolved = await cms.resolvePostPath(`/tin-tuc/${req.params.slug}`, { publicOnly: false });
    if (resolved?.redirect) return res.redirect(301, resolved.canonicalPath);
    return sendTinTucPage(res, "bai-viet.html");
  } catch (err) {
    next(err);
  }
});

const legacyRedirects = {
  "/cms": "/admin-post-article",
  "/cms.html": "/admin-post-article",
  "/login.html": "/login",
  "/login-admin-post.html": "/login-admin-post",
  "/admin-post-article.html": "/admin-post-article",
  "/admin-post-editor.html": "/admin-post-editor",
  "/admin-post-categories.html": "/admin-post-categories",
  "/admin-post-seo.html": "/admin-post-seo",
  "/admin-post-trash.html": "/admin-post-trash",
  "/admin-post-media.html": "/admin-post-media",
  "/preview-bai-viet.html": "/preview-bai-viet"
};
for (const [from, to] of Object.entries(legacyRedirects)) {
  app.get(from, (req, res) => {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(301, to + qs);
  });
}

app.get(["/:slug", "/:prefix/:slug", "/:prefix/:mid/:slug"], async (req, res, next) => {
  try {
    const pathname = req.path.replace(/\/+$/, "") || "/";
    if (pathname === "/" || pathname.startsWith("/api") || pathname.startsWith("/assets")) {
      return next();
    }
    const resolved = await cms.resolvePostPath(pathname, { publicOnly: false });
    if (!resolved) return next();
    if (resolved.redirect) return res.redirect(301, resolved.canonicalPath);
    return sendTinTucPage(res, "bai-viet.html");
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

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
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
    return pids.size > 0;
  }
  return false;
}

function startServer(retried = false) {
  const server = app.listen(PORT, () => {
    console.log(`Findmap Landing / News: ${appOrigin}`);
    console.log(`Giới thiệu: ${appOrigin}/`);
    console.log(`Tin tức: ${appOrigin}/tin-tuc`);
    console.log(`CMS: ${appOrigin}/admin-post-article`);
    console.log(`Đăng nhập CMS: ${appOrigin}/login-admin-post`);
    console.log(`Hệ tìm kiếm: ${searchOrigin}`);
    console.log(
      `Database: MySQL (${process.env.MYSQL_HOST || "localhost"}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || "findmap_news"})`
    );
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !retried) {
      console.warn(`Port ${PORT} đang bận — đang tắt process cũ…`);
      freePort(PORT);
      setTimeout(() => startServer(true), 600);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(`Không mở được port ${PORT}`);
      process.exit(1);
    }
    throw err;
  });
}

startServer();
