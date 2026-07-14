/** Cookie đánh dấu phiên đăng nhập — nginx dùng để route `/` sang hệ tìm kiếm. */
const COOKIE_NAME = "findmap_session";
const COOKIE_VALUE = "1";
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function parseCookies(req) {
  const raw = String(req?.headers?.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function hasSessionCookie(req) {
  return parseCookies(req)[COOKIE_NAME] === COOKIE_VALUE;
}

function browserSetSessionCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=${COOKIE_VALUE}; path=/; max-age=${MAX_AGE_SEC}; SameSite=Lax`;
}

function browserClearSessionCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
}

module.exports = {
  COOKIE_NAME,
  COOKIE_VALUE,
  MAX_AGE_SEC,
  parseCookies,
  hasSessionCookie,
  browserSetSessionCookie,
  browserClearSessionCookie
};
