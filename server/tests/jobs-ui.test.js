const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webDir = path.join(__dirname, "..", "..", "web");

test("nút gửi dữ liệu nằm trên toolbar bảng, không còn ở sidebar", () => {
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  const toolbarStart = html.indexOf('<div class="wm-results-toolbar">');
  const toolbarEnd = html.indexOf('<div id="jobsSyncSummary"');
  const toolbar = html.slice(toolbarStart, toolbarEnd);
  const sidebar = html.slice(0, html.indexOf("<!-- Main app -->"));

  assert.match(toolbar, /id="sendSiteBtn"/);
  assert.match(toolbar, /id="syncJobsBtn"/);
  assert.doesNotMatch(sidebar, /id="sendSiteBtn"|id="syncJobsBtn"/);
});

test("mọi menu Kết nối Jobs mặc định ẩn và do jobs-nav quản lý", () => {
  for (const file of ["index.html", "ket-noi-jobs.html", "nap-diem.html", "cau-hinh-site.html"]) {
    const html = fs.readFileSync(path.join(webDir, file), "utf8");
    const anchor = html.match(/<a href="\/ket-noi-jobs"[^>]*>/)?.[0] || "";
    assert.match(anchor, /\bhidden\b/, file);
    assert.match(anchor, /data-jobs-nav/, file);
    assert.match(html, /<script src="\/jobs-nav\.js"><\/script>/, file);
  }
});
