/**
 * Chỉ nhớ origin Findmap. Bridge gắn qua manifest content_scripts —
 * không registerContentScripts / không executeScript (tránh "fetching the script").
 */
const EXTRA_WEB_ORIGINS_KEY = "timdiemban_extra_web_origins";
const PREFERRED_WEB_ORIGIN_KEY = "timdiemban_preferred_web_origin";
const BRIDGE_SCRIPT_ID = "timdiemban-web-bridge";

function normalizeOrigin(urlOrOrigin) {
  try {
    const u = new URL(String(urlOrOrigin || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch {
    return "";
  }
}

function isMapsOrChromeUrl(url) {
  const s = String(url || "");
  return (
    !s ||
    s.startsWith("chrome:") ||
    s.startsWith("chrome-extension:") ||
    s.startsWith("edge:") ||
    s.startsWith("about:") ||
    /google\.[^/]+\/maps/i.test(s)
  );
}

async function getExtraWebOrigins() {
  try {
    const data = await chrome.storage.local.get(EXTRA_WEB_ORIGINS_KEY);
    const list = Array.isArray(data[EXTRA_WEB_ORIGINS_KEY]) ? data[EXTRA_WEB_ORIGINS_KEY] : [];
    return list.map(normalizeOrigin).filter(Boolean);
  } catch {
    return [];
  }
}

async function rememberWebOrigin(origin) {
  const o = normalizeOrigin(origin);
  if (!o) return [];
  const current = await getExtraWebOrigins();
  if (!current.includes(o)) current.push(o);
  await chrome.storage.local.set({
    [EXTRA_WEB_ORIGINS_KEY]: current,
    [PREFERRED_WEB_ORIGIN_KEY]: o
  });
  return current;
}

async function getPreferredWebOrigin() {
  try {
    const data = await chrome.storage.local.get(PREFERRED_WEB_ORIGIN_KEY);
    return normalizeOrigin(data[PREFERRED_WEB_ORIGIN_KEY]) || getAppOrigin();
  } catch {
    return getAppOrigin();
  }
}

/** Gỡ sạch mọi content script đăng ký động còn sót. */
async function cleanupStaleRegisteredScripts() {
  if (!chrome.scripting?.getRegisteredContentScripts) return;
  try {
    const all = await chrome.scripting.getRegisteredContentScripts();
    const ids = (all || [])
      .filter(
        (s) =>
          s.id === BRIDGE_SCRIPT_ID ||
          String(s.id || "").startsWith("timdiemban-bridge-") ||
          (s.js || []).includes("web-bridge.js")
      )
      .map((s) => s.id);
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch {}
}

async function tabLooksLikeFindmapApp(tabId) {
  if (!tabId) return false;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        !!(
          document.body?.dataset?.findmapApp === "1" ||
          document.getElementById("searchForm") ||
          document.getElementById("loginForm") ||
          document.getElementById("connStatus") ||
          document.querySelector('meta[name="findmap-app"]') ||
          (typeof window.TIMDIEMBAN_CONFIG === "object" && window.TIMDIEMBAN_CONFIG)
        )
    });
    return !!result;
  } catch {
    return false;
  }
}

async function pingBridgeOnTab(tabId) {
  if (!tabId) return false;
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: "PING_BRIDGE" });
    return !!pong?.ok;
  } catch {
    return false;
  }
}

async function ensureBridgeOnTab(tab) {
  const origin = normalizeOrigin(tab?.url);
  if (!origin) return { ok: false, error: "Không thể kết nối trên trang hiện tại." };
  if (isMapsOrChromeUrl(tab.url)) {
    return { ok: false, error: "Trang hiện tại không phải Findmap." };
  }
  await rememberWebOrigin(origin);
  if (await pingBridgeOnTab(tab.id)) {
    return { ok: true, origin, auto: true };
  }
  return {
    ok: false,
    origin,
    error: "Chưa kết nối được với Findmap. Hãy tải lại trang Findmap rồi thử lại."
  };
}

async function syncRegisteredBridgeScripts() {
  await cleanupStaleRegisteredScripts();
}

async function inspectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "Không tìm thấy tab đang mở." };
  const origin = normalizeOrigin(tab.url);
  const maps = isMapsOrChromeUrl(tab.url);
  let isFindmap = false;
  if (origin && !maps) {
    isFindmap = await tabLooksLikeFindmapApp(tab.id).catch(() => false);
  }
  return {
    ok: true,
    tabId: tab.id,
    url: tab.url || "",
    origin,
    title: tab.title || "",
    isFindmap,
    permitted: true,
    preferred: await getPreferredWebOrigin(),
    extra: await getExtraWebOrigins(),
    silent: true
  };
}

cleanupStaleRegisteredScripts().catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  cleanupStaleRegisteredScripts().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  cleanupStaleRegisteredScripts().catch(() => {});
});
