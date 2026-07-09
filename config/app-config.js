/**
 * Tim Điểm Bán — cấu hình deploy (SỬA TẠI ĐÂY)
 *
 * APP_ORIGIN: URL gốc trang kết quả
 *   - Dev:  http://localhost:3000
 *   - Prod: https://your-domain.com
 *
 * Sau khi đổi: chạy `npm start` (tự sync manifest extension) rồi reload extension Chrome.
 */
const TIMDIEMBAN_CONFIG = {
  APP_ORIGIN: "https://findmap.app.chatplus.io.vn",
  MAPS_AUTO_FOCUS_MINUTES: 2,
  MAPS_AUTO_REOPEN_MAX: 5
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = TIMDIEMBAN_CONFIG;
}
if (typeof globalThis !== "undefined") {
  globalThis.TIMDIEMBAN_CONFIG = TIMDIEMBAN_CONFIG;
}
