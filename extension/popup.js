(function () {
  "use strict";

  const FALLBACK_ORIGIN = "https://findmap.vn";
  const configuredOrigin = globalThis.TIMDIEMBAN_CONFIG?.APP_ORIGIN || FALLBACK_ORIGIN;
  const link = document.getElementById("openWebLink");
  const hint = document.getElementById("openWebHint");
  const status = document.getElementById("statusLine");
  const backgroundMode = document.querySelector(".background-mode");
  const backgroundModeText = document.getElementById("backgroundModeText");
  const enableBackgroundMode = document.getElementById("enableBackgroundMode");

  function normalizeOrigin(value) {
    const candidate = String(value || "").trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(candidate)) return FALLBACK_ORIGIN;
    try {
      return new URL(candidate).origin;
    } catch {
      return FALLBACK_ORIGIN;
    }
  }

  function setPreferred(value) {
    const preferred = normalizeOrigin(value || configuredOrigin);
    if (link) link.href = preferred;
    if (hint) hint.textContent = preferred.replace(/^https?:\/\//i, "");
  }

  function setStatus(message, warning = false) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-warning", warning);
  }

  async function hasBackgroundMode() {
    try {
      return await chrome.permissions.contains({ permissions: ["debugger"] });
    } catch {
      return false;
    }
  }

  function renderBackgroundMode(enabled, error = "") {
    backgroundMode?.classList.toggle("is-enabled", enabled);
    if (backgroundModeText) {
      backgroundModeText.textContent = enabled
        ? "Đã bật. Google Maps có thể tiếp tục xử lý ổn định khi nằm ở tab nền."
        : error || "Cho phép Findmap giữ Google Maps hoạt động khi bạn chuyển sang tab khác.";
    }
    if (enableBackgroundMode) {
      enableBackgroundMode.disabled = enabled;
      enableBackgroundMode.textContent = enabled ? "Đã bật quét nền ổn định" : "Bật chế độ này";
    }
  }

  async function refreshBackgroundMode() {
    renderBackgroundMode(await hasBackgroundMode());
  }

  setPreferred(configuredOrigin);
  refreshBackgroundMode();

  enableBackgroundMode?.addEventListener("click", async () => {
    enableBackgroundMode.disabled = true;
    enableBackgroundMode.textContent = "Đang xin quyền…";
    try {
      const granted = await chrome.permissions.request({ permissions: ["debugger"] });
      renderBackgroundMode(granted, granted ? "" : "Bạn chưa cấp quyền. Findmap vẫn hoạt động nhưng sẽ đưa tab Maps lên trước.");
      if (granted) {
        chrome.runtime.sendMessage({ action: "BACKGROUND_MODE_CHANGED", data: { enabled: true } }).catch(() => {});
      }
    } catch {
      renderBackgroundMode(false, "Không bật được quyền quét nền. Hãy thử lại sau.");
    }
  });

  chrome.runtime.sendMessage({ action: "GET_WEB_ORIGINS" }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    setPreferred(response.preferred || response.config || configuredOrigin);
  });

  chrome.runtime.sendMessage({ action: "CONNECT_WEB_SITE" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus("Tiện ích đã sẵn sàng. Mở Findmap để bắt đầu.");
      return;
    }
    if (response?.ok) {
      const connectedOrigin = normalizeOrigin(response.origin || configuredOrigin);
      setPreferred(connectedOrigin);
      setStatus(`Đã kết nối với ${new URL(connectedOrigin).host}.`);
      return;
    }
    setStatus("Tiện ích đã sẵn sàng. Mở Findmap để bắt đầu.");
  });

  link?.addEventListener("click", (event) => {
    event.preventDefault();
    const url = normalizeOrigin(link.href || configuredOrigin);
    chrome.tabs.create({ url }, () => {
      if (chrome.runtime.lastError) {
        setStatus("Không mở được Findmap. Hãy mở findmap.vn trong một tab mới.", true);
      }
    });
  });
})();
