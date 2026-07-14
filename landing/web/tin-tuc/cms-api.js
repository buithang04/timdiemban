/**
 * cms-api.js — token + fetch + auth guard cho CMS / staff
 */
(function (global) {
  const TOKEN_KEY = "findmap_cms_token";
  const LEGACY_ADMIN_KEY = "findmap_cms_token_legacy";
  const LOGIN_URL = "/login";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(LEGACY_ADMIN_KEY) || "";
  }
  function setToken(t) {
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      sessionStorage.removeItem(LEGACY_ADMIN_KEY);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(LEGACY_ADMIN_KEY);
    }
  }
  function redirectLogin() {
    setToken("");
    location.replace(LOGIN_URL);
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
    if (!isForm && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401 || res.status === 403) {
      redirectLogin();
      throw new Error("Phiên đăng nhập hết hạn");
    }
    if (opts.raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    return data;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function slugify(input) {
    return String(input || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 180);
  }

  /**
   * Chuẩn hóa HTML copy từ WordPress:
   * [caption]...[/caption] → <figure>, bỏ artifact Google Sheets, v.v.
   */
  function normalizeWpHtml(html) {
    let s = String(html || "");
    if (!s) return "";

    // [caption id="..." align="aligncenter" width="768"]<img ... /> Text[/caption]
    s = s.replace(/\[caption([^\]]*)\]([\s\S]*?)\[\/caption\]/gi, (_, attrs, inner) => {
      const widthMatch = String(attrs).match(/\bwidth=["']?(\d+)/i);
      const alignMatch = String(attrs).match(/\balign=["']?([a-z0-9_-]+)/i);
      const width = widthMatch ? widthMatch[1] : "";
      const align = alignMatch ? alignMatch[1] : "alignnone";
      const imgMatch = inner.match(/<img\b[^>]*>/i);
      const img = imgMatch ? imgMatch[0] : "";
      let caption = inner
        .replace(/<img\b[^>]*>/i, "")
        .replace(/<\/?a\b[^>]*>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .trim();
      const style = width ? ` style="max-width:${width}px"` : "";
      const cap = caption
        ? `<figcaption class="wp-caption-text">${caption}</figcaption>`
        : "";
      return `<figure class="wp-caption ${align}"${style}>${img}${cap}</figure>`;
    });

    // Artifact dán từ Google Sheets
    s = s.replace(/<span[^>]*data-sheets-root[^>]*>([\s\S]*?)<\/span>/gi, "$1");
    s = s.replace(/\sdata-sheets-[a-z-]+="[^"]*"/gi, "");

    // Shortcode rỗng / còn sót
    s = s.replace(/\[\/?caption[^\]]*\]/gi, "");

    return s;
  }

  async function requireStaff(opts = {}) {
    if (!getToken()) {
      redirectLogin();
      return null;
    }
    try {
      const me = await api("/api/admin/me");
      const user = me.user;
      if (opts.requireAdmin && user.role !== "admin") {
        location.replace("/admin-post-article");
        return null;
      }
      if (user.role !== "admin" && user.role !== "editor") {
        location.replace("/");
        return null;
      }
      return user;
    } catch {
      redirectLogin();
      return null;
    }
  }

  global.CmsApi = {
    TOKEN_KEY,
    LOGIN_URL,
    getToken,
    setToken,
    redirectLogin,
    api,
    escapeHtml,
    slugify,
    normalizeWpHtml,
    requireStaff
  };
})(window);
