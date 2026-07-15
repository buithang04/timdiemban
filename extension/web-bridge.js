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

  let extId = null;
  try {
    extId = chrome?.runtime?.id || null;
  } catch {
    extId = null;
  }
  if (!extId) return;

  // Dùng dataset DOM (chia sẻ được giữa các bản inject/orphan)
  // để listener cũ tự im lặng — không gọi chrome API nữa.
  const GEN_KEY = "findmapBridgeGen";
  const root = document.documentElement;
  const myGen = (Number(root.dataset[GEN_KEY] || 0) || 0) + 1;
  root.dataset[GEN_KEY] = String(myGen);
  root.dataset.findmapBridgeId = extId;

  function isCurrentBridge() {
    try {
      return Number(root.dataset[GEN_KEY]) === myGen;
    } catch {
      return false;
    }
  }

  function isExtensionAlive() {
    if (!isCurrentBridge()) return false;
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id === extId);
    } catch {
      return false;
    }
  }

  function forwardToPage(type, payload) {
    try {
      window.postMessage({ source: "timdiemban-ext", type, payload }, window.location.origin);
    } catch {}
  }

  function markContextDead(reason) {
    if (!isCurrentBridge()) return;
    forwardToPage("bridge_ready", {
      ok: false,
      dead: true,
      error: reason || "Extension đã reload — đang kết nối lại…"
    });
  }

  function sendBg(message, cb) {
    if (!isExtensionAlive()) {
      if (isCurrentBridge()) markContextDead();
      if (typeof cb === "function") {
        try {
          cb(null, { message: "Extension context invalidated." });
        } catch {}
      }
      return;
    }

    const finish = (resp, err) => {
      if (!isCurrentBridge()) return;
      if (err && /context invalidated|extension context/i.test(String(err?.message || err))) {
        markContextDead(err.message || String(err));
      }
      if (typeof cb !== "function") return;
      try {
        cb(resp, err || null);
      } catch {}
    };

    try {
      const maybePromise = chrome.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (resp) => finish(resp, null),
          (err) => finish(null, err || { message: "sendMessage failed" })
        );
        return;
      }
      chrome.runtime.sendMessage(message, (resp) => {
        let err = null;
        try {
          err = chrome.runtime.lastError || null;
        } catch (e) {
          err = e;
        }
        finish(resp, err);
      });
    } catch (e) {
      finish(null, e);
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!isExtensionAlive()) return;
      if (message?.action === "TIMDIEMBAN_DATA") {
        forwardToPage(message.type, message.payload);
      }
      if (message?.action === "SEARCH_LOG") {
        forwardToPage("log", { line: message.line });
      }
    });
  } catch {
    markContextDead();
    return;
  }

  function pingBackground(cb) {
    sendBg({ action: "PING_BG" }, (resp, err) => {
      cb(err ? { ok: false, dead: true, error: err.message || String(err) } : resp || { ok: true });
    });
  }

  pingBackground((resp) => forwardToPage("bridge_ready", resp));

  sendBg({ action: "GET_SESSION" }, (resp) => {
    if (resp?.token && resp?.user) {
      try {
        localStorage.setItem("timdiemban_token", resp.token);
      } catch {}
      forwardToPage("session", resp);
    }
  });

  function storageGet(keys, cb) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.get(keys, (data) => {
        try {
          if (chrome.runtime.lastError) return;
        } catch {
          markContextDead();
          return;
        }
        if (!isCurrentBridge()) return;
        cb(data);
      });
    } catch {
      markContextDead();
    }
  }

  function storageRemove(keys) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.remove(keys);
    } catch {}
  }

  function checkPendingComplete() {
    storageGet("pendingComplete", (data) => {
      if (data?.pendingComplete) {
        forwardToPage("complete", data.pendingComplete);
        storageRemove("pendingComplete");
      }
    });
  }

  function checkPendingSearchSync() {
    storageGet("pendingSearchSync", (data) => {
      const snap = data?.pendingSearchSync;
      if (snap?.results?.length) {
        forwardToPage("sync", {
          results: snap.results,
          searchParams: snap.searchParams,
          mergedCount: snap.mergedCount,
          text: `Đồng bộ lại — ${snap.results.length} quán`
        });
        storageRemove("pendingSearchSync");
      }
    });
  }

  function onPageVisible() {
    if (!isExtensionAlive()) return;
    checkPendingComplete();
    sendBg({ action: "GET_SEARCH_STATUS" }, (statusResp, err) => {
      if (err) return;
      const active = !!(statusResp?.running || statusResp?.stalled);
      if (!active) checkPendingSearchSync();
      sendBg(
        { action: "REQUEST_SEARCH_SYNC", data: { reason: active ? "visibility" : "visibility_idle" } },
        () => {}
      );
      sendBg({ action: "GET_SEARCH_STATUS" }, (resp, err2) => {
        forwardToPage("search_status", err2 ? { running: false } : resp || { running: false });
      });
    });
  }

  checkPendingComplete();
  sendBg({ action: "GET_SEARCH_STATUS" }, (statusResp, err) => {
    if (err) return;
    if (!(statusResp?.running || statusResp?.stalled)) checkPendingSearchSync();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onPageVisible();
  });
  window.addEventListener("focus", () => onPageVisible());
  window.addEventListener("pageshow", () => onPageVisible());

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "timdiemban-web") return;
    // Bản bridge mới hơn đã gắn — im lặng, không đụng chrome API
    if (!isCurrentBridge()) return;
    if (!isExtensionAlive()) {
      markContextDead();
      return;
    }

    const { type, payload } = event.data;

    if (type === "PING_EXT") {
      pingBackground((resp) => forwardToPage("bridge_ready", resp));
      return;
    }

    if (type === "LOGIN") {
      sendBg({ action: "SAVE_SESSION", data: payload });
      return;
    }
    if (type === "LOGOUT") {
      sendBg({ action: "SAVE_SESSION", data: { token: "", user: null } });
      try {
        localStorage.removeItem("timdiemban_token");
      } catch {}
      return;
    }

    if (type === "GET_MAPS_CENTER") {
      sendBg({ action: "GET_MAPS_CENTER" }, (resp, err) => {
        forwardToPage("maps_center", err ? { error: err.message || String(err) } : resp || {});
      });
      return;
    }

    if (type === "START_SEARCH") {
      sendBg({ action: "START_SEARCH", data: payload }, (resp, err) => {
        if (err) {
          forwardToPage("search_ack", { success: false, error: err.message || String(err) });
        } else {
          forwardToPage("search_ack", resp || { success: true });
        }
      });
      return;
    }

    if (type === "CANCEL_SEARCH") {
      sendBg({ action: "CANCEL_SEARCH", data: payload }, (resp, err) => {
        forwardToPage(
          "cancel_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: true }
        );
      });
      return;
    }

    if (type === "ABANDON_SEARCH") {
      sendBg({ action: "ABANDON_SEARCH", data: payload }, (resp, err) => {
        forwardToPage(
          "abandon_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: true }
        );
      });
      return;
    }

    if (type === "REQUEST_SEARCH_SYNC") {
      sendBg({ action: "REQUEST_SEARCH_SYNC", data: payload }, (resp, err) => {
        forwardToPage(
          "search_sync_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: true }
        );
      });
      return;
    }

    if (type === "GET_SEARCH_STATUS") {
      sendBg({ action: "GET_SEARCH_STATUS" }, (resp, err) => {
        forwardToPage(
          "search_status",
          err ? { running: false, error: err.message || String(err) } : resp || { running: false }
        );
      });
      return;
    }

    if (type === "SET_MAPS_AUTO_FOCUS") {
      sendBg({ action: "SET_MAPS_AUTO_FOCUS", data: payload }, (resp, err) => {
        forwardToPage(
          "maps_auto_focus_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: true }
        );
      });
      return;
    }

    if (type === "SET_MAPS_AUTO_REOPEN") {
      sendBg({ action: "SET_MAPS_AUTO_REOPEN", data: payload }, (resp, err) => {
        forwardToPage(
          "maps_auto_reopen_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: true }
        );
      });
      return;
    }

    if (type === "RESUME_SEARCH") {
      sendBg({ action: "RESUME_SEARCH" }, (resp, err) => {
        forwardToPage(
          "resume_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: false }
        );
      });
      return;
    }

    if (type === "START_RESCAN") {
      sendBg({ action: "START_RESCAN", data: payload }, (resp, err) => {
        forwardToPage(
          "rescan_ack",
          err ? { success: false, error: err.message || String(err) } : resp || { success: true }
        );
      });
      return;
    }

    if (type === "GET_RESCAN_STATUS") {
      sendBg({ action: "GET_RESCAN_STATUS" }, (resp, err) => {
        forwardToPage("rescan_status", err ? { running: false } : resp || { running: false });
      });
    }
  });
})();
