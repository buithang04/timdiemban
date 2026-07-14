/**
 * Kiểm tra extension Chrome đã cập nhật bản mới nhất (theo manifest trong repo).
 */
(function () {
  const DISMISS_KEY = "timdiemban_ext_banner_dismiss";

  const state = {
    requiredVersion: null,
    installedVersion: null,
    bridgeOk: false,
    checked: false
  };

  const els = {
    banner: null,
    text: null,
    dismiss: null
  };

  function parseSemver(v) {
    const parts = String(v || "0.0.0")
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  }

  function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    return pa.patch - pb.patch;
  }

  function isUpToDate() {
    if (!state.requiredVersion || !state.installedVersion) return null;
    return compareSemver(state.installedVersion, state.requiredVersion) >= 0;
  }

  function isDismissed() {
    try {
      const d = JSON.parse(sessionStorage.getItem(DISMISS_KEY) || "null");
      if (!d || d.version !== state.requiredVersion) return false;
      return Date.now() - d.at < 6 * 60 * 60 * 1000;
    } catch {
      return false;
    }
  }

  function dismissBanner() {
    try {
      sessionStorage.setItem(
        DISMISS_KEY,
        JSON.stringify({ version: state.requiredVersion, at: Date.now() })
      );
    } catch {}
    hideBanner();
  }

  function hideBanner() {
    els.banner?.classList.add("hidden");
  }

  function showBanner(kind, message, { dismissible = false } = {}) {
    if (!els.banner || !els.text) return;
    if (kind === "ok" && isDismissed()) {
      hideBanner();
      return;
    }
    els.banner.className = `ext-version-banner ext-version-${kind}`;
    els.text.textContent = message;
    els.banner.classList.remove("hidden");
    if (els.dismiss) {
      els.dismiss.classList.toggle("hidden", !dismissible);
    }
  }

  function render() {
    state.checked = true;
    const req = state.requiredVersion;

    if (!req) {
      showBanner("warn", "Không đọc được phiên bản extension từ server — kiểm tra npm start.");
      return;
    }

    if (!state.bridgeOk) {
      showBanner(
        "error",
        `Chưa thấy extension (cần v${req}). Mở icon findmap trên Chrome → «Kích hoạt trên trang này» (hoặc «Cho phép mọi domain» nếu hay đổi host) → F5. Cài/Reload tại chrome://extensions.`
      );
      return;
    }

    if (!state.installedVersion) {
      showBanner(
        "warn",
        `Extension đã kết nối nhưng chưa báo phiên bản. Reload extension tại chrome://extensions (cần v${req}).`
      );
      return;
    }

    const cmp = compareSemver(state.installedVersion, req);
    if (cmp < 0) {
      showBanner(
        "error",
        `Extension chưa cập nhật: đang dùng v${state.installedVersion}, cần v${req}. Mở chrome://extensions → findmap → Reload.`
      );
      return;
    }

    if (cmp > 0) {
      showBanner(
        "warn",
        `Extension v${state.installedVersion} mới hơn web (v${req}). Cập nhật lại file extension trong repo nếu cần đồng bộ.`,
        { dismissible: true }
      );
      return;
    }

    showBanner(
      "ok",
      `Extension v${state.installedVersion} — đã cập nhật mới nhất.`,
      { dismissible: true }
    );
    setTimeout(() => {
      if (isUpToDate() === true) hideBanner();
    }, 8000);
  }

  async function loadRequiredVersion() {
    try {
      const res = await fetch("/api/ext-version");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.requiredVersion = data.version || null;
    } catch {
      state.requiredVersion = null;
    }
    return state.requiredVersion;
  }

  function onBridgeReady(payload) {
    state.bridgeOk = Boolean(payload?.ok);
    state.installedVersion = payload?.version || null;
    render();
  }

  function onBridgeMissing() {
    state.bridgeOk = false;
    state.installedVersion = null;
    render();
  }

  function init() {
    els.banner = document.getElementById("extVersionBanner");
    els.text = document.getElementById("extVersionBannerText");
    els.dismiss = document.getElementById("extVersionDismiss");
    els.dismiss?.addEventListener("click", dismissBanner);

    showBanner("info", "Đang kiểm tra phiên bản extension…");

    loadRequiredVersion().then(() => {
      render();
      window.TimDiemBanSearch?.pingExtensionBridge?.();
    });

    setTimeout(() => {
      if (!state.bridgeOk) onBridgeMissing();
    }, 4000);
  }

  window.TimDiemBanExtVersion = {
    init,
    onBridgeReady,
    onBridgeMissing,
    isUpToDate,
    getStatus: () => ({ ...state, upToDate: isUpToDate() }),
    compareSemver
  };

  document.addEventListener("DOMContentLoaded", init);
})();
