const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");

test("giao diện quét nhanh mô tả đúng pipeline hai tab và mặc định tắt", () => {
  const html = read("web", "index.html");

  assert.match(html, /id="searchQuickScan"/);
  assert.doesNotMatch(html, /id="searchQuickScan"[^>]*\bchecked\b/);
  assert.match(html, /Quét nhanh \(2 tab\)/);
  assert.match(html, /tab 1 cuộn từng khu vực để lấy danh sách URL/);
  assert.match(html, /tab 2 liên tục mở các URL đã có để đọc chi tiết/);
  assert.match(html, /Khi tắt, hệ thống dùng 1 tab/);
  assert.doesNotMatch(html, /searchFastMode/);
});

test("START_SEARCH gửi quickScan độc lập và không bật fastMode giảm chất lượng", () => {
  const search = read("web", "search.js");

  assert.match(search, /quickScan:\s*!!els\.quickScan\?\.checked/);
  assert.match(search, /postToExt\("START_SEARCH",\s*searchParams\)/);
  assert.match(search, /Quét nhanh dùng 2 tab: tab 1 lấy danh sách URL, tab 2 liên tục đọc chi tiết địa điểm/);
  assert.match(search, /Quét thường dùng 1 tab: lấy xong danh sách URL của từng khu vực rồi mới đọc chi tiết/);
  assert.match(search, /Khi tab 1 đang lấy danh sách, hãy giữ tab đó ở phía trước; tab 2 vẫn đọc chi tiết ở nền/);
  assert.match(search, /Đang mở 2 tab Google Maps — tab 1 lấy URL, tab 2 đọc chi tiết/);
  assert.doesNotMatch(search, /searchFastMode/);
  assert.doesNotMatch(search, /\bfastMode\s*:/);
});
