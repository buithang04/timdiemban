(function () {
  const { api } = window.CmsApi;
  const $ = (id) => document.getElementById(id);

  async function init() {
    const user = await window.CmsShell.bootShell();
    if (!user) return;

    const data = await api("/api/admin/cms/seo-settings");
    $("seoSiteName").value = data.seoSiteName || "";
    $("seoDefaultDesc").value = data.seoDefaultDescription || "";
    $("gscProperty").value = data.gscPropertyUrl || "";
    $("gscMeta").value = data.gscVerificationMeta || "";
    const hint = $("pagespeedKeyHint");
    if (hint) {
      hint.textContent = data.hasPagespeedApiKey
        ? "Đã có API key (không hiện lại vì bảo mật). Dán key mới để thay."
        : "Chưa cấu hình key — có thể vẫn gọi PSI với quota IP (nên thêm key).";
    }

    $("seoSettingsForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("seoSettingsMsg");
      try {
        const keyInput = ($("pagespeedApiKey")?.value || "").trim();
        const body = {
          seoSiteName: $("seoSiteName").value,
          seoDefaultDescription: $("seoDefaultDesc").value,
          gscPropertyUrl: $("gscProperty").value,
          gscVerificationMeta: $("gscMeta").value
        };
        if (keyInput) {
          body.pagespeedApiKey = keyInput;
        } else {
          body.keepPagespeedApiKey = true;
        }
        await api("/api/admin/cms/seo-settings", {
          method: "POST",
          body: JSON.stringify(body)
        });
        if ($("pagespeedApiKey")) $("pagespeedApiKey").value = "";
        if (hint && keyInput) hint.textContent = "Đã có API key (không hiện lại vì bảo mật). Dán key mới để thay.";
        msg.textContent = "Đã lưu cấu hình SEO / GSC";
        msg.className = "cms-msg ok";
      } catch (err) {
        msg.textContent = err.message;
        msg.className = "cms-msg err";
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
