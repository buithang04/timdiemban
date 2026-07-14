/**
 * AUTO-SYNC hint — server landing đọc NEWS/SEARCH từ file này + process.env.
 * Nguồn chính: config/app-config.js (root).
 */
const rootCfg = (() => {
  try {
    return require("../../config/app-config.js");
  } catch {
    return {};
  }
})();

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

const FINDMAP_NEWS_CONFIG = {
  NEWS_ORIGIN: env("NEWS_ORIGIN", rootCfg.NEWS_ORIGIN || "http://localhost:3001"),
  SEARCH_ORIGIN: env(
    "SEARCH_ORIGIN",
    rootCfg.SEARCH_ORIGIN || rootCfg.APP_ORIGIN || "http://localhost:3000"
  ),
  MYSQL_DATABASE: env("MYSQL_DATABASE", "findmap_news")
};

module.exports = FINDMAP_NEWS_CONFIG;
if (typeof globalThis !== "undefined") {
  globalThis.FINDMAP_NEWS_CONFIG = FINDMAP_NEWS_CONFIG;
}
