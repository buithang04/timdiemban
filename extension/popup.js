(function () {
  "use strict";

  const FALLBACK_ORIGIN = "https://findmap.vn";
  const configuredOrigin = globalThis.TIMDIEMBAN_CONFIG?.APP_ORIGIN || FALLBACK_ORIGIN;
  const link = document.getElementById("openWebLink");
  const hint = document.getElementById("openWebHint");
  const status = document.getElementById("statusLine");

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

  setPreferred(configuredOrigin);

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
