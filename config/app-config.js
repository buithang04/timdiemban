/**
 * Tim Điểm Bán — cấu hình deploy (SỬA TẠI ĐÂY)
 *
 * APP_ORIGIN: URL gốc hệ tìm kiếm
 * NEWS_ORIGIN: URL hệ tin tức / giới thiệu / CMS (folder landing/)
 *
 * Sau khi đổi: chạy `npm start` (tự sync manifest extension) rồi reload extension Chrome.
 */
const TIMDIEMBAN_CONFIG = {
  APP_ORIGIN: "https://findmap.app.chatplus.io.vn",
  NEWS_ORIGIN: process.env.NEWS_ORIGIN || "http://localhost:3001",
  MAPS_AUTO_FOCUS_MINUTES: 2,
  MAPS_AUTO_REOPEN_MAX: 5
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = TIMDIEMBAN_CONFIG;
}
if (typeof globalThis !== "undefined") {
  globalThis.TIMDIEMBAN_CONFIG = TIMDIEMBAN_CONFIG;
}
