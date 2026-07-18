(function () {
  const AUTH_KEY = "timdiemban_token";

  function links() {
    return document.querySelectorAll("[data-jobs-nav]");
  }

  function setLinked(linked) {
    links().forEach((link) => link.classList.toggle("hidden", !linked));
  }

  async function refresh(status) {
    if (status && typeof status.linked === "boolean") {
      setLinked(status.linked);
      return status;
    }

    const token = localStorage.getItem(AUTH_KEY) || "";
    if (!token) {
      setLinked(false);
      return { linked: false };
    }

    try {
      const response = await fetch("/api/integrations/jobs/status?verify=1", {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      setLinked(Boolean(response.ok && data.linked));
      return data;
    } catch {
      setLinked(false);
      return { linked: false };
    }
  }

  window.FindmapJobsNav = { refresh, setLinked };
  setLinked(false);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => refresh());
  else refresh();
})();
