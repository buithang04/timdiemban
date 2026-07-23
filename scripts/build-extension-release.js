/** Build a Chrome Web Store ZIP from the extension source without dev-only hosts. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const sourceDir = path.join(root, "extension");
const distDir = path.join(root, "dist");
const sourceManifest = JSON.parse(
  fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8")
);
const version = sourceManifest.version;
const releaseName = `findmap-extension-${version}`;
const releaseDir = path.join(distDir, releaseName);
const zipPath = path.join(distDir, `${releaseName}.zip`);
const allowedReleasePermissions = new Set(["storage", "scripting", "alarms", "power"]);
const allowedReleaseHosts = new Set([
  "https://www.google.com/maps/*",
  "https://findmap.vn/*",
  "https://www.findmap.vn/*"
]);

const releaseFiles = [
  "app-config.js",
  "background.js",
  "content.js",
  "grid.js",
  "icons",
  "lifecycle.js",
  "manifest.json",
  "place-fields.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "run-lease.js",
  "site-bridge.js",
  "web-bridge.js",
  "web-config.js"
];

function isDevelopmentOrigin(pattern) {
  return /:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i.test(String(pattern || ""));
}

function assertSafeReleaseManifest(manifest) {
  if (manifest.manifest_version !== 3) throw new Error("Release phải dùng Manifest V3.");
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ""))) {
    throw new Error("Version extension phải có dạng x.y.z.");
  }
  if (String(manifest.description || "").length > 132) {
    throw new Error("Description vượt giới hạn 132 ký tự của Chrome Web Store.");
  }
  if (
    (manifest.permissions || []).includes("debugger") ||
    (manifest.optional_permissions || []).includes("debugger")
  ) {
    throw new Error('Bản phát hành không được yêu cầu quyền "debugger".');
  }

  for (const permission of [
    ...(manifest.permissions || []),
    ...(manifest.optional_permissions || [])
  ]) {
    if (!allowedReleasePermissions.has(permission)) {
      throw new Error(`Quyền chưa được duyệt cho bản release: ${permission}`);
    }
  }

  const broadPatterns = new Set(["<all_urls>", "http://*/*", "https://*/*", "*://*/*"]);
  for (const pattern of manifest.host_permissions || []) {
    if (
      broadPatterns.has(pattern) ||
      isDevelopmentOrigin(pattern) ||
      !allowedReleaseHosts.has(pattern)
    ) {
      throw new Error(`Host permission không được phép trong bản release: ${pattern}`);
    }
  }
  for (const script of manifest.content_scripts || []) {
    for (const pattern of script.matches || []) {
      if (
        broadPatterns.has(pattern) ||
        isDevelopmentOrigin(pattern) ||
        !allowedReleaseHosts.has(pattern)
      ) {
        throw new Error(`Content-script match không được phép trong bản release: ${pattern}`);
      }
    }
    for (const file of script.js || []) {
      if (!fs.existsSync(path.join(releaseDir, file))) {
        throw new Error(`Thiếu content-script trong gói release: ${file}`);
      }
    }
  }
}

function assertNoRemoteCode(directory) {
  const forbidden = [
    [/<script\b[^>]*\bsrc=["']https?:\/\//i, "remote script"],
    [/\bimportScripts\s*\(\s*["']https?:\/\//i, "remote importScripts"],
    [/\bimport\s*\(\s*["']https?:\/\//i, "remote dynamic import"],
    [/\.src\s*=\s*["']https?:\/\//i, "remote script source"],
    [
      /WebAssembly\.(?:instantiateStreaming|compileStreaming)\s*\(\s*fetch\s*\(\s*["']https?:\/\//i,
      "remote WebAssembly"
    ],
    [/\beval\s*\(|\bnew\s+Function\s*\(/, "dynamic code"]
  ];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!/\.(?:js|html)$/i.test(entry.name)) continue;
      const source = fs.readFileSync(fullPath, "utf8");
      for (const [pattern, label] of forbidden) {
        if (!pattern.test(source)) continue;
        throw new Error(`${label} không được phép: ${path.relative(directory, fullPath)}`);
      }
    }
  }
}

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true });
if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
fs.mkdirSync(releaseDir, { recursive: true });

for (const item of releaseFiles) {
  const source = path.join(sourceDir, item);
  if (!fs.existsSync(source)) throw new Error(`Thiếu file extension: ${item}`);
  fs.cpSync(source, path.join(releaseDir, item), { recursive: true });
}

const releaseManifestPath = path.join(releaseDir, "manifest.json");
const releaseManifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
releaseManifest.host_permissions = (releaseManifest.host_permissions || []).filter(
  (pattern) => !isDevelopmentOrigin(pattern)
);
for (const script of releaseManifest.content_scripts || []) {
  script.matches = (script.matches || []).filter((pattern) => !isDevelopmentOrigin(pattern));
}
fs.writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

assertSafeReleaseManifest(releaseManifest);
assertNoRemoteCode(releaseDir);

try {
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: releaseDir, stdio: "inherit" });
} catch (error) {
  throw new Error(`Không tạo được ZIP. Kiểm tra lệnh zip trên máy: ${error.message}`);
}

console.log(`[extension-release] Folder: ${releaseDir}`);
console.log(`[extension-release] ZIP:    ${zipPath}`);
console.log(`[extension-release] Hosts:  ${releaseManifest.host_permissions.join(", ")}`);
