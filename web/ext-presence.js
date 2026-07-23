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
    install: null,
    sidebarDownload: null,
    sidebarDownloadHint: null,
    headerDownload: null
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

  function updateSidebarDownload() {
    const url = getInstallUrl();
    for (const link of [els.sidebarDownload, els.headerDownload].filter(Boolean)) {
      if (url) {
        link.href = url;
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        link.removeAttribute("aria-disabled");
        link.classList.remove("is-unavailable");
      } else {
        link.removeAttribute("href");
        link.removeAttribute("target");
        link.setAttribute("aria-disabled", "true");
        link.classList.add("is-unavailable");
      }
    }
    if (url) {
      if (els.sidebarDownloadHint) {
        els.sidebarDownloadHint.textContent = state.bridgeOk
          ? "Mở trang tiện ích Chrome"
          : "Cài cho Google Chrome";
      }
      return;
    }

    if (els.sidebarDownloadHint) {
      els.sidebarDownloadHint.textContent = "Đường dẫn tải đang cập nhật";
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
    updateSidebarDownload();
    if (!state.checked) {
      showBanner("info", "Đang kiểm tra tiện ích Findmap…");
      return;
    }

    if (!state.bridgeOk) {
      showBanner("error", "Chưa phát hiện tiện ích Findmap.", { showInstall: true });
      return;
    }

    showBanner("ok", "Đã phát hiện và kết nối tiện ích Findmap.");
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
    els.sidebarDownload = document.getElementById("sidebarExtensionDownload");
    els.sidebarDownloadHint = document.getElementById("sidebarExtensionDownloadHint");
    els.headerDownload = document.getElementById("headerExtensionDownload");

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
