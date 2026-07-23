const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const manifest = JSON.parse(read("extension", "manifest.json"));

function readSetLiteral(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\((\\[[\\s\\S]*?\\])\\);`));
  assert.ok(match, `không tìm thấy allowlist ${name}`);
  return Function(`"use strict"; return (${match[1]});`)();
}

test("manifest mô tả đúng sản phẩm và có metadata phát hành đầy đủ", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Findmap – Tìm điểm bán");
  assert.equal(manifest.short_name, "Findmap");
  assert.equal(manifest.homepage_url, "https://findmap.vn");
  assert.match(manifest.action?.default_title || "", /Findmap/i);

  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.trim().length > 0, "description không được để trống");
  assert.ok(
    manifest.description.length <= 132,
    `description dài ${manifest.description.length} ký tự, vượt giới hạn 132 của Chrome`
  );
  assert.match(manifest.description, /Google Maps/i);
  assert.match(manifest.description, /điểm bán/i);
  assert.match(manifest.description, /đồng bộ/i);
  assert.equal(
    manifest.permissions.includes("geolocation"),
    false,
    "GPS thuộc website Findmap; extension không được xin quyền vị trí khi không sử dụng"
  );
  assert.equal(manifest.permissions.includes("activeTab"), false);
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal((manifest.optional_permissions || []).includes("debugger"), false);
  assert.ok(Number(manifest.minimum_chrome_version) >= 120);
  for (const pattern of manifest.host_permissions || []) {
    assert.doesNotMatch(pattern, /^(?:https?|\*):\/\/\*\//, `host permission quá rộng: ${pattern}`);
  }
  assert.equal(
    (manifest.host_permissions || []).includes("https://app.findmap.vn/*"),
    false,
    "app.findmap.vn thuộc hệ thống khác và không được extension tin cậy"
  );
  assert.equal(
    (manifest.content_scripts || []).some((script) =>
      (script.matches || []).includes("https://app.findmap.vn/*")
    ),
    false
  );
});

test("đồng bộ cấu hình không xóa metadata mô tả của extension", () => {
  const syncConfig = read("scripts", "sync-app-config.js");

  assert.doesNotMatch(
    syncConfig,
    /delete\s+manifest(?:\.description|\[\s*["']description["']\s*\])/,
    "sync-app-config.js không được xóa manifest.description"
  );
});

test("popup tuân thủ CSP Manifest V3 và dùng đúng asset hiện hành", () => {
  const html = read("extension", "popup.html");
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  assert.match(html, /<html\b[^>]*\blang=["']vi["']/i);
  assert.match(html, /<title>\s*Findmap\s*[–-]\s*Tìm điểm bán\s*<\/title>/i);
  assert.match(
    html,
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'](?:\.\/)?popup\.css["']/i
  );
  assert.ok(scriptTags.length > 0, "popup phải nạp JavaScript ngoài");
  for (const [, attrs, body] of scriptTags) {
    assert.match(attrs, /\bsrc\s*=\s*["'][^"']+["']/i, "popup không được chứa inline script");
    assert.equal(body.trim(), "", "popup không được chứa nội dung JavaScript inline");
  }
  assert.ok(
    scriptTags.some(([, attrs]) => /\bsrc=["'](?:\.\/)?popup\.js["']/i.test(attrs)),
    "popup phải nạp popup.js"
  );
  assert.match(html, /\brole=["']status["']/i);
  assert.match(html, /\baria-live=["']polite["']/i);
  assert.doesNotMatch(html, /<style\b/i, "CSS của popup phải được quản lý trong popup.css");
  assert.doesNotMatch(html, /mọi domain|Mở trang kết quả|Chạy ngầm/i);
});

test("popup mô tả đúng kết nối Findmap và không còn logic giao diện cũ", () => {
  const html = read("extension", "popup.html");
  const popup = read("extension", "popup.js");

  assert.match(popup, /GET_WEB_ORIGINS/);
  assert.match(popup, /CONNECT_WEB_SITE/);
  assert.match(html, /Đang kiểm tra kết nối với Findmap/i);
  assert.match(popup, /Tiện ích đã sẵn sàng/i);
  assert.match(popup, /Đã kết nối với/i);
  assert.match(html, /Google Maps riêng ở nền/i);
  assert.match(html, /làm việc ở tab khác/i);
  assert.doesNotMatch(popup, /permissions\.request|BACKGROUND_MODE_CHANGED/);
  assert.doesNotMatch(html, /id="enableBackgroundMode"/);
  assert.doesNotMatch(popup, /searchForm|loginPanel|loginPassword|startBtn/);
  assert.doesNotMatch(popup, /Chạy ngầm|["'`]OK["'`]|mọi domain/i);
});

test("overlay Maps dùng hướng dẫn người dùng, không hiển thị phiên bản nội bộ", () => {
  const content = read("extension", "content.js");
  const background = read("extension", "background.js");

  assert.match(content, /Findmap đang quét Google Maps/i);
  assert.match(content, /Không đóng hoặc tải lại tab Google Maps/i);
  assert.match(content, /không phản hồi trong 5 phút/i);
  assert.doesNotMatch(content, /Đang tìm kiếm tự động|rời tab được/i);
  assert.doesNotMatch(content, /Ctrl\+Shift\+D\s*=\s*ẩn\/hiện overlay\s*·\s*F12/i);
  assert.doesNotMatch(content, /v\$\{CONTENT_VERSION\}/);
  assert.doesNotMatch(background, /v\$\{REQUIRED_CONTENT_VERSION\}\s*·/);
});

test("thông báo kết nối không còn chỉ dẫn kỹ thuật hoặc gây hiểu sai", () => {
  const sources = {
    "extension/background.js": read("extension", "background.js"),
    "extension/site-bridge.js": read("extension", "site-bridge.js"),
    "extension/web-bridge.js": read("extension", "web-bridge.js"),
    "web/app.js": read("web", "app.js")
  };
  const stalePatterns = [
    /reload extension|F5 trang|Extension disconnected/i,
    /Bridge chưa gắn|Chưa có quyền mọi domain|Không thấy tab/i,
    /cho phép popup\/tab mới|content script trên Maps/i
  ];

  for (const [file, source] of Object.entries(sources)) {
    for (const pattern of stalePatterns) {
      assert.equal(pattern.test(source), false, `${file} còn copy lỗi thời: ${pattern}`);
    }
  }
});

test("chỉ nhớ origin sau khi bridge Findmap đã xác thực", () => {
  const bridge = read("extension", "site-bridge.js");
  const start = bridge.indexOf("async function ensureBridgeOnTab");
  const end = bridge.indexOf("async function syncRegisteredBridgeScripts", start);
  const source = bridge.slice(start, end);
  const pingAt = source.indexOf("await pingBridgeOnTab(tab.id)");
  const rememberAt = source.indexOf("await rememberWebOrigin(origin)");

  assert.ok(pingAt >= 0, "phải ping bridge Findmap");
  assert.ok(rememberAt > pingAt, "không được nhớ origin trước khi bridge xác thực");
});

test("background khóa lệnh nhạy cảm theo đúng origin Findmap", () => {
  const background = read("extension", "background.js");
  const webConfig = read("extension", "web-config.js");

  assert.match(background, /const PRIVILEGED_WEB_ACTIONS = new Set/);
  for (const action of [
    "START_SEARCH",
    "CANCEL_SEARCH",
    "PAUSE_SEARCH",
    "RESUME_SEARCH",
    "START_RESCAN",
    "GET_SESSION",
    "SAVE_SESSION"
  ]) {
    assert.match(background, new RegExp(`["']${action}["']`));
  }
  assert.match(background, /sender\.id !== chrome\.runtime\.id/);
  assert.match(background, /getConfiguredWebOrigins\(\)\.includes\(origin\)/);
  assert.doesNotMatch(webConfig, /app\.findmap\.vn/);
  assert.match(
    background,
    /PRIVILEGED_WEB_ACTIONS\.has\(message\?\.action\)\s*&&\s*!isTrustedFindmapSender\(sender\)/
  );
});

test("build release khóa đúng allowlist quyền và production hosts", () => {
  const build = read("scripts", "build-extension-release.js");

  assert.deepEqual(readSetLiteral(build, "allowedReleasePermissions"), [
    "storage",
    "scripting",
    "alarms",
    "power"
  ]);
  assert.deepEqual(readSetLiteral(build, "allowedReleaseHosts"), [
    "https://www.google.com/maps/*",
    "https://findmap.vn/*",
    "https://www.findmap.vn/*"
  ]);
  assert.match(build, /!allowedReleasePermissions\.has\(permission\)/);
  assert.match(build, /!allowedReleaseHosts\.has\(pattern\)/);
  assert.match(build, /importScripts/);
  assert.match(build, /remote dynamic import/);
  assert.match(build, /remote WebAssembly/);
});

test("release cho phép giữ hệ thống thức có phạm vi và vẫn chặn quyền mạnh", () => {
  const build = read("scripts", "build-extension-release.js");

  assert.equal(manifest.permissions.includes("power"), true);
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal(manifest.permissions.includes("offscreen"), false);
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
  assert.match(build, /allowedReleasePermissions[\s\S]*["']power["']/);
});
