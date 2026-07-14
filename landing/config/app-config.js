/**
 * Findmap Landing / CMS — cấu hình (SỬA TẠI ĐÂY)
 *
 * NEWS_ORIGIN: URL hệ thống tin tức + giới thiệu + CMS (folder landing/)
 * SEARCH_ORIGIN: URL hệ thống tìm kiếm Findmap
 */
const FINDMAP_NEWS_CONFIG = {
  NEWS_ORIGIN: process.env.NEWS_ORIGIN || "http://localhost:3001",
  SEARCH_ORIGIN: process.env.SEARCH_ORIGIN || "http://localhost:3000",
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || "findmap_news"
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = FINDMAP_NEWS_CONFIG;
}
if (typeof globalThis !== "undefined") {
  globalThis.FINDMAP_NEWS_CONFIG = FINDMAP_NEWS_CONFIG;
}
