(function () {
  // Chỉ gắn bridge trên trang Findmap (tránh làm phiền mọi site)
  function isFindmapPage() {
    try {
      return !!(
        document.body?.dataset?.findmapApp === "1" ||
        document.getElementById("searchForm") ||
        document.getElementById("loginForm") ||
        document.getElementById("connStatus") ||
        document.querySelector('meta[name="findmap-app"]')
      );
    } catch {
      return false;
    }
  }
  if (!isFindmapPage()) return;

  if (window.__timDiemBanBridgeLoaded) return;
  window.__timDiemBanBridgeLoaded = true;

  function forwardToPage(type, payload) {
    window.postMessage({ source: "timdiemban-ext", type, payload }, window.location.origin);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "TIMDIEMBAN_DATA") {
      forwardToPage(message.type, message.payload);
    }
    if (message.action === "SEARCH_LOG") {
      forwardToPage("log", { line: message.line });
    }
  });

  function pingBackground(cb) {
    try {
      chrome.runtime.sendMessage({ action: "PING_BG" }, (resp) => {
        const err = chrome.runtime.lastError;
        cb(err ? { ok: false, error: err.message } : resp || { ok: true });
      });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  }

  pingBackground((resp) => {
    forwardToPage("bridge_ready", resp);
  });

  chrome.runtime.sendMessage({ action: "GET_SESSION" }, (resp) => {
    if (resp?.token && resp?.user) {
      try {
        localStorage.setItem("timdiemban_token", resp.token);
      } catch {}
      forwardToPage("session", resp);
    }
  });

  // Khi page active lại — kiểm tra xem có kết quả pending chưa được gửi
  function checkPendingComplete() {
    try {
      chrome.storage.local.get("pendingComplete", (data) => {
        if (chrome.runtime.lastError) return;
        if (data?.pendingComplete) {
          forwardToPage("complete", data.pendingComplete);
          chrome.storage.local.remove("pendingComplete");
        }
      });
    } catch {}
  }

  // Khi page active lại — khôi phục kết quả đã lưu khi tab ở nền
  function checkPendingSearchSync() {
    try {
      chrome.storage.local.get("pendingSearchSync", (data) => {
        if (chrome.runtime.lastError) return;
        const snap = data?.pendingSearchSync;
        if (snap?.results?.length) {
          forwardToPage("sync", {
            results: snap.results,
            searchParams: snap.searchParams,
            mergedCount: snap.mergedCount,
            text: `Đồng bộ lại — ${snap.results.length} quán`
          });
          chrome.storage.local.remove("pendingSearchSync");
        }
      });
    } catch {}
  }

  function onPageVisible() {
    checkPendingComplete();
    try {
      chrome.runtime.sendMessage({ action: "GET_SEARCH_STATUS" }, (statusResp) => {
        if (chrome.runtime.lastError) return;
        const active = !!(statusResp?.running || statusResp?.stalled);
        if (!active) checkPendingSearchSync();
        chrome.runtime.sendMessage(
          { action: "REQUEST_SEARCH_SYNC", data: { reason: active ? "visibility" : "visibility_idle" } },
          () => {
            if (chrome.runtime.lastError) return;
          }
        );
        chrome.runtime.sendMessage({ action: "GET_SEARCH_STATUS" }, (resp) => {
          const err = chrome.runtime.lastError;
          forwardToPage("search_status", err ? { running: false } : resp || { running: false });
        });
      });
    } catch {}
  }

  checkPendingComplete();
  try {
    chrome.runtime.sendMessage({ action: "GET_SEARCH_STATUS" }, (statusResp) => {
      if (chrome.runtime.lastError) return;
      if (!(statusResp?.running || statusResp?.stalled)) checkPendingSearchSync();
    });
  } catch {}
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onPageVisible();
  });
  window.addEventListener("focus", () => onPageVisible());
  window.addEventListener("pageshow", () => onPageVisible());

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "timdiemban-web") return;

    const { type, payload } = event.data;

    if (type === "PING_EXT") {
      pingBackground((resp) => forwardToPage("bridge_ready", resp));
      return;
    }

    if (type === "LOGIN") {
      chrome.runtime.sendMessage({ action: "SAVE_SESSION", data: payload });
      return;
    }
    if (type === "LOGOUT") {
      chrome.runtime.sendMessage({ action: "SAVE_SESSION", data: { token: "", user: null } });
      try {
        localStorage.removeItem("timdiemban_token");
      } catch {}
      return;
    }

    if (type === "GET_MAPS_CENTER") {
      chrome.runtime.sendMessage({ action: "GET_MAPS_CENTER" }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("maps_center", err ? { error: err.message } : resp || {});
      });
      return;
    }

    if (type === "START_SEARCH") {
      chrome.runtime.sendMessage({ action: "START_SEARCH", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          forwardToPage("search_ack", { success: false, error: err.message });
        } else {
          forwardToPage("search_ack", resp || { success: true });
        }
      });
    }

    if (type === "CANCEL_SEARCH") {
      chrome.runtime.sendMessage({ action: "CANCEL_SEARCH", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("cancel_ack", err ? { success: false, error: err.message } : resp || { success: true });
      });
    }

    if (type === "ABANDON_SEARCH") {
      chrome.runtime.sendMessage({ action: "ABANDON_SEARCH", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("abandon_ack", err ? { success: false, error: err.message } : resp || { success: true });
      });
    }

    if (type === "REQUEST_SEARCH_SYNC") {
      chrome.runtime.sendMessage({ action: "REQUEST_SEARCH_SYNC", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("search_sync_ack", err ? { success: false, error: err.message } : resp || { success: true });
      });
    }

    if (type === "GET_SEARCH_STATUS") {
      chrome.runtime.sendMessage({ action: "GET_SEARCH_STATUS" }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("search_status", err ? { running: false, error: err.message } : resp || { running: false });
      });
    }

    if (type === "SET_MAPS_AUTO_FOCUS") {
      chrome.runtime.sendMessage({ action: "SET_MAPS_AUTO_FOCUS", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("maps_auto_focus_ack", err ? { success: false, error: err.message } : resp || { success: true });
      });
    }

    if (type === "SET_MAPS_AUTO_REOPEN") {
      chrome.runtime.sendMessage({ action: "SET_MAPS_AUTO_REOPEN", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("maps_auto_reopen_ack", err ? { success: false, error: err.message } : resp || { success: true });
      });
    }

    if (type === "RESUME_SEARCH") {
      chrome.runtime.sendMessage({ action: "RESUME_SEARCH" }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("resume_ack", err ? { success: false, error: err.message } : resp || { success: false });
      });
    }

    if (type === "START_RESCAN") {
      chrome.runtime.sendMessage({ action: "START_RESCAN", data: payload }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("rescan_ack", err ? { success: false, error: err.message } : resp || { success: true });
      });
    }

    if (type === "GET_RESCAN_STATUS") {
      chrome.runtime.sendMessage({ action: "GET_RESCAN_STATUS" }, (resp) => {
        const err = chrome.runtime.lastError;
        forwardToPage("rescan_status", err ? { running: false } : resp || { running: false });
      });
    }
  });
})();
