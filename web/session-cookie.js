(function () {
  const COOKIE_NAME = "findmap_session";
  const COOKIE_VALUE = "1";
  const MAX_AGE_SEC = 30 * 24 * 60 * 60;

  function setSessionCookie() {
    document.cookie = `${COOKIE_NAME}=${COOKIE_VALUE}; path=/; max-age=${MAX_AGE_SEC}; SameSite=Lax`;
  }

  function clearSessionCookie() {
    document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
  }

  window.FindmapSessionCookie = { setSessionCookie, clearSessionCookie };
})();
