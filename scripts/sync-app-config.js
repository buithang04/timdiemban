/**
 * Đồng bộ config/app-config.js → extension + web + manifest.json
 * Chạy tự động trước npm start, hoặc: node scripts/sync-app-config.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcConfig = path.join(root, "config", "app-config.js");
const cfg = require(srcConfig);

function originToHostPattern(origin) {
  const u = new URL(origin.replace(/\/$/, ""));
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
    return `${u.protocol}//${u.host}/*`;
  }
  return `${u.protocol}//${u.hostname}/*`;
}

function collectWebUrlPatterns(origin) {
  const base = String(origin || "").replace(/\/$/, "");
  if (!base) return [];
  const patterns = new Set([originToHostPattern(base)]);
  if (base.includes("localhost")) {
    patterns.add(originToHostPattern(base.replace("localhost", "127.0.0.1")));
  } else if (base.includes("127.0.0.1")) {
    patterns.add(originToHostPattern(base.replace("127.0.0.1", "localhost")));
  }
  // Luôn cho phép dev local (kể cả khi APP_ORIGIN đang là production)
  patterns.add("http://localhost:3000/*");
  patterns.add("http://127.0.0.1:3000/*");
  return [...patterns];
}

function syncCopies() {
  const raw = fs.readFileSync(srcConfig, "utf8");
  for (const dest of [
    path.join(root, "extension", "app-config.js"),
    path.join(root, "web", "app-config.js")
  ]) {
    fs.writeFileSync(dest, raw, "utf8");
    console.log("[sync-config] →", path.relative(root, dest));
  }
}

function syncManifest() {
  const manifestPath = path.join(root, "extension", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const patterns = collectWebUrlPatterns(cfg.APP_ORIGIN);

  manifest.host_permissions = [
    "https://www.google.com/maps/*",
    ...patterns
  ];

  const bridge = manifest.content_scripts.find((s) =>
    (s.js || []).includes("web-bridge.js")
  );
  if (bridge) {
    bridge.matches = patterns;
  }

  manifest.description = `Cào dữ liệu Google Maps — điều khiển từ ${cfg.APP_ORIGIN.replace(/\/$/, "")}`;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("[sync-config] manifest host_permissions:", patterns.join(", "));
}

syncCopies();
syncManifest();
console.log("[sync-config] APP_ORIGIN =", cfg.APP_ORIGIN);
