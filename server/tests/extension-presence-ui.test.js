const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");

test("website chỉ phát hiện extension, không so sánh phiên bản", () => {
  const presence = read("web", "ext-presence.js");
  const html = read("web", "index.html");

  assert.match(presence, /isInstalled/);
  assert.match(presence, /bridgeOk/);
  assert.match(html, /src="\/ext-presence\.js(?:\?[^" ]*)?"/);
  assert.doesNotMatch(
    presence,
    /requiredVersion|installedVersion|compareSemver|isUpToDate|\/api\/ext-version|chrome:\/\/extensions/i
  );
  assert.doesNotMatch(html, /src="\/ext-version\.js"/);
});

test("tìm kiếm chỉ chặn khi chưa phát hiện extension", () => {
  const search = read("web", "search.js");
  const app = read("web", "app.js");

  assert.match(search, /TimDiemBanExtension\?\.isInstalled/);
  assert.match(app, /Đã phát hiện và kết nối tiện ích Findmap/);
  assert.match(app, /Chưa phát hiện tiện ích Findmap/);
  assert.doesNotMatch(search, /isUpToDate|chưa cập nhật|chrome:\/\/extensions/i);
  assert.doesNotMatch(app, /isUpToDate|cần reload|chrome:\/\/extensions|p\.version/i);
});

test("server không còn công bố phiên bản extension bắt buộc", () => {
  const server = read("server", "server.js");

  assert.doesNotMatch(server, /getExtensionManifestVersion|extManifestPath|\/api\/ext-version/);
});
