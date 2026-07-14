/**
 * Kết nối linh hoạt tới mọi domain trang kết quả.
 * - domain mới (vd. thang.timdiemban.vn): bấm popup → Kích hoạt / Cho phép mọi domain
 * - Lưu origin đã dùng; đăng ký content script bền
 * - Nếu đã cấp https://*/* → tự inject khi phát hiện trang Findmap
 */
const EXTRA_WEB_ORIGINS_KEY = "timdiemban_extra_web_origins";
const PREFERRED_WEB_ORIGIN_KEY = "timdiemban_preferred_web_origin";
const BROAD_HOST_KEY = "timdiemban_broad_host_access";
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

async function hasOriginPermission(origin) {
  const pattern = originPattern(origin);
  if (!pattern) return false;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await hasBroadHostAccess();
  } catch {
    return false;
  }
}

async function hasBroadHostAccess() {
  try {
    const granted = await chrome.permissions.contains({ origins: BROAD_ORIGINS });
    if (granted) {
      await chrome.storage.local.set({ [BROAD_HOST_KEY]: true });
      return true;
    }
    const data = await chrome.storage.local.get(BROAD_HOST_KEY);
    return !!data[BROAD_HOST_KEY] && granted;
  } catch {
    return false;
  }
}

async function requestOriginPermission(origin) {
  const pattern = originPattern(origin);
  if (!pattern) return false;
  if (await hasOriginPermission(origin)) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function requestBroadHostAccess() {
  if (await hasBroadHostAccess()) return true;
  try {
    const ok = await chrome.permissions.request({ origins: BROAD_ORIGINS });
    if (ok) await chrome.storage.local.set({ [BROAD_HOST_KEY]: true });
    return ok;
  } catch {
    return false;
  }
}

async function registerBridgeContentScript(origins) {
  if (!chrome.scripting?.registerContentScripts) return;
  const broad = await hasBroadHostAccess();
  const matches = broad
    ? [...BROAD_ORIGINS]
    : [...new Set(origins.map(originPattern).filter(Boolean))];
  if (!matches.length) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      {
        id: BRIDGE_SCRIPT_ID,
        js: ["web-bridge.js"],
        matches,
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
          document.getElementById("connStatus") ||
          document.querySelector('meta[name="findmap-app"]') ||
          (typeof window.TIMDIEMBAN_CONFIG === "object" && window.TIMDIEMBAN_CONFIG?.APP_ORIGIN)
        )
    });
    return !!result;
  } catch {
    return false;
  }
}

async function ensureBridgeOnTab(tab) {
  const origin = normalizeOrigin(tab?.url);
  if (!origin) return { ok: false, error: "Hãy mở tab trang web Findmap (http/https) rồi thử lại" };
  if (isMapsOrChromeUrl(tab.url)) {
    return { ok: false, error: "Đang ở Google Maps / tab hệ thống — mở tab trang tìm điểm bán rồi kích hoạt" };
  }

  const granted = await requestOriginPermission(origin);
  if (!granted) {
    return {
      ok: false,
      error: "Bạn từ chối quyền site này. Bấm lại và chọn Cho phép — hoặc dùng «Cho phép mọi domain»."
    };
  }

  await rememberWebOrigin(origin);
  const all = [...new Set([getAppOrigin(), ...(await getExtraWebOrigins()), origin])];
  await registerBridgeContentScript(all);

  const injected = await injectBridgeIntoTab(tab.id);
  if (!injected) {
    return {
      ok: false,
      error: "Không gắn được bridge — F5 trang rồi bấm lại Kích hoạt",
      origin
    };
  }

  return { ok: true, origin, broad: await hasBroadHostAccess() };
}

async function grantBroadAndResync() {
  const ok = await requestBroadHostAccess();
  if (!ok) return { ok: false, error: "Chưa cấp quyền mọi domain" };
  await syncRegisteredBridgeScripts();
  // Inject vào mọi tab Findmap đang mở
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
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
  const all = [...new Set([getAppOrigin(), ...(await getExtraWebOrigins())])];
  await registerBridgeContentScript(all);
}

async function inspectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "Không thấy tab đang mở" };
  const origin = normalizeOrigin(tab.url);
  const maps = isMapsOrChromeUrl(tab.url);
  let isFindmap = false;
  let permitted = false;
  if (origin && !maps) {
    permitted = await hasOriginPermission(origin);
    if (permitted || (await hasBroadHostAccess())) {
      isFindmap = await tabLooksLikeFindmapApp(tab.id);
    } else {
      // activeTab: vẫn thử nhận diện khi user vừa mở popup
      isFindmap = await tabLooksLikeFindmapApp(tab.id).catch(() => false);
    }
  }
  return {
    ok: true,
    tabId: tab.id,
    url: tab.url || "",
    origin,
    title: tab.title || "",
    isFindmap,
    permitted,
    broad: await hasBroadHostAccess(),
    preferred: await getPreferredWebOrigin(),
    extra: await getExtraWebOrigins()
  };
}

async function maybeAutoInjectBridge(tabId, url) {
  if (isMapsOrChromeUrl(url)) return;
  const origin = normalizeOrigin(url);
  if (!origin) return;

  const broad = await hasBroadHostAccess();
  const known = new Set([getAppOrigin(), ...(await getExtraWebOrigins())]);
  const knownSite = known.has(origin);
  const permitted = broad || knownSite || (await hasOriginPermission(origin));
  if (!permitted) return;

  if (!knownSite) {
    const looks = await tabLooksLikeFindmapApp(tabId);
    if (!looks) return;
    await rememberWebOrigin(origin);
  }

  await injectBridgeIntoTab(tabId);
}

chrome.runtime.onInstalled.addListener(() => {
  syncRegisteredBridgeScripts().catch(() => {});
});

chrome.permissions.onAdded.addListener((perms) => {
  const origins = perms?.origins || [];
  if (origins.some((o) => o === "https://*/*" || o === "http://*/*")) {
    chrome.storage.local.set({ [BROAD_HOST_KEY]: true }).catch(() => {});
    syncRegisteredBridgeScripts().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  maybeAutoInjectBridge(tabId, tab?.url || changeInfo.url).catch(() => {});
});
