/**
 * Bridge tối giản: chỉ chuyển postMessage ↔ background.
 * Không gọi chrome API khi visibility/focus (nguồn "context invalidated").
 */
(function () {
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

  let extId = "";
  try {
    extId = String(chrome.runtime.id || "");
  } catch {
    return;
  }
  if (!extId) return;

  const root = document.documentElement;
  const myGen = (Number(root.dataset.findmapBridgeGen || 0) || 0) + 1;
  root.dataset.findmapBridgeGen = String(myGen);

  let dead = false;

  function alive() {
    if (dead) return false;
    try {
      if (Number(root.dataset.findmapBridgeGen) !== myGen) {
        dead = true;
        return false;
      }
      return String(chrome.runtime.id || "") === extId;
    } catch {
      dead = true;
      return false;
    }
  }

  function toPage(type, payload) {
    try {
      window.postMessage({ source: "timdiemban-ext", type, payload }, window.location.origin);
    } catch {}
  }

  function kill() {
    if (dead) return;
    dead = true;
    toPage("bridge_ready", {
      ok: false,
      dead: true,
      error: "Kết nối với tiện ích đã bị gián đoạn. Hãy tải lại trang Findmap."
    });
  }

  /** Promise-only, luôn .catch — không để Uncaught. */
  function bg(message) {
    if (!alive()) {
      kill();
      return Promise.resolve(null);
    }
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.then === "function") {
        return p.catch((err) => {
          const msg = String(err?.message || err || "");
          if (/context invalidated|extension context|receiving end does not exist/i.test(msg)) {
            kill(msg);
          }
          return null;
        });
      }
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(message, (resp) => {
            try {
              const err = chrome.runtime.lastError;
              if (err) {
                if (/context invalidated|extension context/i.test(err.message || "")) kill(err.message);
                resolve(null);
                return;
              }
              resolve(resp);
            } catch (e) {
              kill(e?.message);
              resolve(null);
            }
          });
        } catch (e) {
          kill(e?.message);
          resolve(null);
        }
      });
    } catch (e) {
      kill(e?.message);
      return Promise.resolve(null);
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!alive()) return;
      try {
        if (message?.action === "PING_BRIDGE") {
          sendResponse({ ok: true });
          return true;
        }
        if (message?.action === "TIMDIEMBAN_DATA") {
          toPage(message.type, message.payload);
        }
        if (message?.action === "SEARCH_LOG") {
          toPage("log", { line: message.line });
        }
      } catch {
        kill();
      }
    });
  } catch {
    return;
  }

  // Chỉ lắng message từ trang — không visibility/focus/pageshow
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "timdiemban-web") return;
    if (!alive()) {
      kill();
      return;
    }

    const { type, payload } = event.data;

    const reply = (action, pageType, fallback) => {
      bg({ action, data: payload }).then((resp) => {
        try {
          if (resp == null) {
            toPage(pageType, {
              success: false,
              running: false,
              error: "Mất kết nối với tiện ích. Hãy tải lại trang Findmap."
            });
            return;
          }
          toPage(pageType, resp || fallback);
        } catch {}
      });
    };

    try {
      if (type === "PING_EXT") {
        bg({ action: "PING_BG" }).then((resp) => {
          toPage("bridge_ready", resp || { ok: false, dead: true });
        });
        return;
      }
      if (type === "LOGIN") {
        bg({ action: "SAVE_SESSION", data: payload });
        return;
      }
      if (type === "LOGOUT") {
        bg({ action: "SAVE_SESSION", data: { token: "", user: null } });
        try {
          localStorage.removeItem("timdiemban_token");
        } catch {}
        return;
      }
      if (type === "GET_MAPS_CENTER") {
        reply("GET_MAPS_CENTER", "maps_center", {});
        return;
      }
      if (type === "START_SEARCH") {
        reply("START_SEARCH", "search_ack", { success: true });
        return;
      }
      if (type === "CANCEL_SEARCH") {
        reply("CANCEL_SEARCH", "cancel_ack", { success: true });
        return;
      }
      if (type === "ABANDON_SEARCH") {
        reply("ABANDON_SEARCH", "abandon_ack", { success: true });
        return;
      }
      if (type === "REQUEST_SEARCH_SYNC") {
        reply("REQUEST_SEARCH_SYNC", "search_sync_ack", { success: true });
        return;
      }
      if (type === "GET_SEARCH_STATUS") {
        reply("GET_SEARCH_STATUS", "search_status", { running: false });
        return;
      }
      if (type === "SET_MAPS_AUTO_FOCUS") {
        reply("SET_MAPS_AUTO_FOCUS", "maps_auto_focus_ack", { success: true });
        return;
      }
      if (type === "SET_MAPS_AUTO_REOPEN") {
        reply("SET_MAPS_AUTO_REOPEN", "maps_auto_reopen_ack", { success: true });
        return;
      }
      if (type === "RESUME_SEARCH") {
        reply("RESUME_SEARCH", "resume_ack", { success: false });
        return;
      }
      if (type === "START_RESCAN") {
        reply("START_RESCAN", "rescan_ack", { success: true });
        return;
      }
      if (type === "GET_RESCAN_STATUS") {
        reply("GET_RESCAN_STATUS", "rescan_status", { running: false });
      }
    } catch {
      kill();
    }
  });

  // Ping 1 lần lúc load — không storage / không visibility
  bg({ action: "PING_BG" }).then((resp) => {
    if (resp) toPage("bridge_ready", resp);
    else if (!dead) toPage("bridge_ready", { ok: false, dead: true });
  });

  bg({ action: "GET_SESSION" }).then((resp) => {
    if (resp?.token && resp?.user) {
      try {
        localStorage.setItem("timdiemban_token", resp.token);
      } catch {}
      toPage("session", resp);
    }
  });
})();
