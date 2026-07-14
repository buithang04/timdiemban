/**
 * cms-shell.js — highlight nav, user bar, logout
 */
(function () {
  const { api, redirectLogin, requireStaff } = window.CmsApi;

  function highlightNav() {
    const path = location.pathname.replace(/\/$/, "") || "/";
    document.querySelectorAll(".cms-nav a.cms-nav-item").forEach((a) => {
      const href = (a.getAttribute("href") || "").replace(/\/$/, "");
      a.classList.toggle("active", href === path);
    });
  }

  async function bootShell() {
    highlightNav();
    const user = await requireStaff();
    if (!user) return null;
    const emailEl = document.getElementById("cmsUserEmail");
    const roleEl = document.getElementById("cmsUserRole");
    if (emailEl) emailEl.textContent = user.email || "Staff";
    if (roleEl) roleEl.textContent = user.role === "admin" ? "Admin CMS" : "Editor đăng bài";

    const adminLink = document.getElementById("cmsLinkAdmin");
    if (adminLink) {
      try {
        const origins = await fetch("/api/config/origins").then((r) => r.json());
        const search = String(origins.searchOrigin || "").replace(/\/+$/, "");
        if (search) {
          adminLink.href = `${search}/admin`;
          adminLink.target = "_blank";
          adminLink.rel = "noopener";
        } else {
          adminLink.classList.add("hidden");
        }
      } catch {
        adminLink.classList.add("hidden");
      }
    }

    document.getElementById("cmsLogoutBtn")?.addEventListener("click", async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore */
      }
      redirectLogin();
    });
    return user;
  }

  window.CmsShell = { bootShell, highlightNav };
})();
