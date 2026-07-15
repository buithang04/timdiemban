/**
 * Tim Điểm Bán — cấu hình deploy (SỬA TẠI ĐÂY)
 *
 * APP_ORIGIN  = URL hệ tìm kiếm (login user, admin điểm, extension)
 * NEWS_ORIGIN = URL landing / tin tức / CMS
 *
 * Dev ví dụ:
 *   APP_ORIGIN:  "http://localhost:3000"
 *   NEWS_ORIGIN: "http://localhost:3001"
 *
 * Prod (cùng domain reverse-proxy hoặc tách subdomain):
 *   APP_ORIGIN:  "https://findmap.vn"
 *   NEWS_ORIGIN: "https://findmap.vn"  // hoặc cùng APP_ORIGIN
 *
 * Sau khi đổi: `cd server && npm start` (prestart sync) hoặc `node scripts/sync-app-config.js`
 */
function env(name) {
  try {
    if (typeof process !== "undefined" && process.env && process.env[name]) {
      return String(process.env[name]).trim();
    }
  } catch {
    /* browser */
  }
  return "";
}

const defaultApp = "https://findmap.vn";
const appOrigin = env("APP_ORIGIN") || defaultApp;
const isLocalApp = /localhost|127\.0\.0\.1/i.test(appOrigin);
const defaultNews = isLocalApp ? "http://localhost:3001" : appOrigin;

const TIMDIEMBAN_CONFIG = {
  APP_ORIGIN: appOrigin,
  NEWS_ORIGIN: env("NEWS_ORIGIN") || defaultNews,
  MAPS_AUTO_FOCUS_MINUTES: 2,
  MAPS_AUTO_REOPEN_MAX: 5,
  /** Link cài Extension Chrome — cập nhật khi có URL store/zip */
  EXTENSION_INSTALL_URL: env("EXTENSION_INSTALL_URL") || ""
};

/** Alias rõ nghĩa — SEARCH = hệ tìm kiếm */
TIMDIEMBAN_CONFIG.SEARCH_ORIGIN = env("SEARCH_ORIGIN") || TIMDIEMBAN_CONFIG.APP_ORIGIN;

if (typeof module !== "undefined" && module.exports) {
  module.exports = TIMDIEMBAN_CONFIG;
}
if (typeof globalThis !== "undefined") {
  globalThis.TIMDIEMBAN_CONFIG = TIMDIEMBAN_CONFIG;
}
