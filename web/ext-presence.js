/**
 * Phát hiện Extension Findmap qua bridge đã được content script cài vào trang.
 * Website chỉ quan tâm extension có kết nối hay không, không khóa theo phiên bản.
 */
(function () {
  const state = {
    bridgeOk: false,
    checked: false
  };

  const els = {
    banner: null,
    text: null,
    install: null
  };

  function getInstallUrl() {
    const cfg = globalThis.TIMDIEMBAN_CONFIG || {};
    return String(cfg.EXTENSION_INSTALL_URL || "").trim();
  }

  function hideBanner() {
    els.banner?.classList.add("hidden");
  }

  function updateInstallLink(show) {
    if (!els.install) return;
    const url = getInstallUrl();
    if (show && url) {
      els.install.href = url;
      els.install.classList.remove("hidden");
    } else {
      els.install.classList.add("hidden");
    }
  }

  function showBanner(kind, message, { showInstall = false } = {}) {
    if (!els.banner || !els.text) return;
    els.banner.className = `ext-version-banner ext-version-${kind}`;
    els.text.textContent = message;
    els.banner.classList.remove("hidden");
    updateInstallLink(showInstall);
  }

  function render() {
    if (!state.checked) {
      showBanner("info", "Đang kiểm tra Extension Findmap…");
      return;
    }

    if (!state.bridgeOk) {
      showBanner("error", "Chưa phát hiện Extension Findmap.", { showInstall: true });
      return;
    }

    showBanner("ok", "Đã cài và kết nối Extension Findmap.");
    setTimeout(() => {
      if (state.bridgeOk) hideBanner();
    }, 8000);
  }

  function onBridgeReady(payload) {
    state.checked = true;
    state.bridgeOk = Boolean(payload?.ok);
    render();
  }

  function onBridgeMissing() {
    state.checked = true;
    state.bridgeOk = false;
    render();
  }

  function init() {
    els.banner = document.getElementById("extVersionBanner");
    els.text = document.getElementById("extVersionBannerText");
    els.install = document.getElementById("extInstallLink");

    render();
    window.TimDiemBanSearch?.pingExtensionBridge?.();

    setTimeout(() => {
      if (!state.checked) onBridgeMissing();
    }, 4000);
  }

  window.TimDiemBanExtension = {
    init,
    onBridgeReady,
    onBridgeMissing,
    isInstalled: () => state.bridgeOk,
    getStatus: () => ({ ...state })
  };

  document.addEventListener("DOMContentLoaded", init);
})();
