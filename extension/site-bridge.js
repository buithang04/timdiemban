/**
 * AUTO: gắn bridge trên mọi domain Findmap — không cần bấm popup.
 * Cần host_permissions http://*/* + https://*/* (xin lúc cài/reload extension).
 */
const EXTRA_WEB_ORIGINS_KEY = "timdiemban_extra_web_origins";
const PREFERRED_WEB_ORIGIN_KEY = "timdiemban_preferred_web_origin";
const BRIDGE_SCRIPT_ID = "timdiemban-web-bridge";
const BROAD_ORIGINS = ["http://*/*", "https://*/*"];

function normalizeOrigin(urlOrOrigin) {
  try {
    const u = new URL(String(urlOrOrigin || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch {
    return "";
  }
}

function originPattern(origin) {
  const o = normalizeOrigin(origin);
  return o ? `${o}/*` : "";
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

async function hasBroadHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: BROAD_ORIGINS });
  } catch {
    // host_permissions bắt buộc trong manifest cũng thỏa
    return true;
  }
}

async function hasOriginPermission(origin) {
  const pattern = originPattern(origin);
  if (!pattern) return false;
  try {
    if (await chrome.permissions.contains({ origins: BROAD_ORIGINS })) return true;
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return true;
  }
}

async function requestOriginPermission(origin) {
  if (await hasOriginPermission(origin)) return true;
  const pattern = originPattern(origin);
  if (!pattern) return false;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function requestBroadHostAccess() {
  if (await hasBroadHostAccess()) return true;
  try {
    return await chrome.permissions.request({ origins: BROAD_ORIGINS });
  } catch {
    return false;
  }
}

async function registerBridgeContentScript() {
  if (!chrome.scripting?.registerContentScripts) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      {
        id: BRIDGE_SCRIPT_ID,
        js: ["web-bridge.js"],
        matches: BROAD_ORIGINS,
        runAt: "document_idle",
        persistAcrossSessions: true
      }
    ]);
  } catch (err) {
    console.warn("[findmap] registerContentScripts:", err?.message || err);
  }
}

async function injectBridgeIntoTab(tabId) {
  if (!tabId) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["web-bridge.js"]
    });
    return true;
  } catch (err) {
    console.warn("[findmap] inject bridge:", err?.message || err);
    return false;
  }
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

async function ensureBridgeOnTab(tab) {
  const origin = normalizeOrigin(tab?.url);
  if (!origin) return { ok: false, error: "Không có tab http(s)" };
  if (isMapsOrChromeUrl(tab.url)) {
    return { ok: false, error: "Tab Maps/hệ thống — bỏ qua" };
  }

  await rememberWebOrigin(origin);
  await registerBridgeContentScript();
  const injected = await injectBridgeIntoTab(tab.id);
  return injected
    ? { ok: true, origin, auto: true }
    : { ok: false, error: "Không inject được bridge", origin };
}

async function grantBroadAndResync() {
  const ok = await requestBroadHostAccess();
  if (!ok) return { ok: false, error: "Chưa có quyền mọi domain — Reload extension và chấp nhận quyền" };
  await registerBridgeContentScript();
  const tabs = await chrome.tabs.query({ url: BROAD_ORIGINS });
  let connected = 0;
  for (const tab of tabs) {
    if (isMapsOrChromeUrl(tab.url)) continue;
    if (await tabLooksLikeFindmapApp(tab.id)) {
      if (await injectBridgeIntoTab(tab.id)) {
        await rememberWebOrigin(tab.url);
        connected += 1;
      }
    }
  }
  return { ok: true, connected, broad: true };
}

async function syncRegisteredBridgeScripts() {
  await registerBridgeContentScript();
}

async function inspectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "Không thấy tab" };
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
    broad: await hasBroadHostAccess(),
    preferred: await getPreferredWebOrigin(),
    extra: await getExtraWebOrigins(),
    silent: true
  };
}

/** Luôn chạy ngầm: thấy trang Findmap → gắn bridge */
async function maybeAutoInjectBridge(tabId, url) {
  if (isMapsOrChromeUrl(url)) return;
  const origin = normalizeOrigin(url);
  if (!origin) return;

  const known = new Set([getAppOrigin(), ...(await getExtraWebOrigins())]);
  if (known.has(origin)) {
    await injectBridgeIntoTab(tabId);
    return;
  }

  const looks = await tabLooksLikeFindmapApp(tabId);
  if (!looks) return;
  await rememberWebOrigin(origin);
  await injectBridgeIntoTab(tabId);
}

chrome.runtime.onInstalled.addListener(() => {
  syncRegisteredBridgeScripts().catch(() => {});
  // Gắn vào các tab Findmap đang mở
  chrome.tabs.query({ url: BROAD_ORIGINS }).then(async (tabs) => {
    for (const tab of tabs) {
      if (!tab?.id || isMapsOrChromeUrl(tab.url)) continue;
      try {
        if (await tabLooksLikeFindmapApp(tab.id)) {
          await rememberWebOrigin(tab.url);
          await injectBridgeIntoTab(tab.id);
        }
      } catch {}
    }
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  syncRegisteredBridgeScripts().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  maybeAutoInjectBridge(tabId, tab?.url || changeInfo.url).catch(() => {});
});
