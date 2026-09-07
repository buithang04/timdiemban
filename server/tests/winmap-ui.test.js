const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const webDir = path.join(rootDir, "web");
const serverJs = path.join(rootDir, "server", "server.js");

test("màn kết nối Winmap dùng request từ fragment và không có ô nhập token thủ công", () => {
  const html = fs.readFileSync(path.join(webDir, "ket-noi-winmap.html"), "utf8");

  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
  assert.match(html, /findmap_winmap_pending_request/);
  assert.match(html, /\/login\?redirect=%2Fket-noi-winmap/);
  assert.match(html, /id="acceptWinmapBtn"/);
  const anchor = html.match(/<a href="\/ket-noi-winmap"[^>]*>/)?.[0] || "";
  assert.match(anchor, /\bhidden\b/);
  assert.match(anchor, /data-winmap-nav/);
  assert.match(html, /<script src="\/winmap-integration\.js"><\/script>/);
  assert.doesNotMatch(html, /Bearer token|winmapToken|api chay/i);
});

test("menu Kết nối Winmap ẩn mặc định trên các màn chính và do winmap-nav quản lý", () => {
  for (const file of ["index.html", "ket-noi-jobs.html", "nap-diem.html", "cau-hinh-site.html", "ket-noi-winmap.html"]) {
    const html = fs.readFileSync(path.join(webDir, file), "utf8");
    const anchor = html.match(/<a href="\/ket-noi-winmap"[^>]*>/)?.[0] || "";
    assert.match(anchor, /\bhidden\b/, file);
    assert.match(anchor, /data-winmap-nav/, file);
    assert.match(html, /<script src="\/winmap-nav\.js"><\/script>/, file);
  }
});

test("server có route trang và API kết nối Winmap", () => {
  const source = fs.readFileSync(serverJs, "utf8");
  assert.match(source, /"\/ket-noi-winmap": "ket-noi-winmap\.html"/);
  assert.match(source, /app\.post\("\/api\/integrations\/winmap\/request-preview"/);
  assert.match(source, /app\.post\("\/api\/integrations\/winmap\/connect"/);
  assert.match(source, /app\.delete\("\/api\/integrations\/winmap\/disconnect"/);
});
