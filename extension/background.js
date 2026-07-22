importScripts(
  "app-config.js",
  "web-config.js",
  "site-bridge.js",
  "lifecycle.js",
  "run-lease.js",
  "place-fields.js",
  "grid.js"
);

/** URL search Maps — cạnh ô cố định (m), chỉ đổi tâm @lat,lng */
function buildMapsUrl(keyword, lat, lng, viewportM) {
  const encoded = encodeURIComponent(keyword);
  const m = Math.round(viewportM || 2500);
  return `https://www.google.com/maps/search/${encoded}/@${lat},${lng},${m}m/data=!3m2!1e3!4b1?entry=ttu`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scrapeState = {
  running: false,
  runId: "",
  mapsTabId: null,
  mapsWindowId: null,
  webTabId: null,
  searchParams: null,
  gridPoints: [],
  gridIndex: 0,
  totalCells: 0,
  cellSizeKm: 2,
  viewportM: 2500,
  mergedPlaces: new Map(),
  completedCells: new Set(),
  phase: "grid",
  cellGeneration: 0,
  _expectMapsNavigation: false,
  _programmaticMapsNavUntil: 0,
  _mapsCellWorkActive: false,
  _mapsUserReloadCount: 0
};

const RunLease = globalThis.TimDiemBanRunLease;

function getActiveCellLease() {
  if (!scrapeState.running || !scrapeState.runId || scrapeState.cellGeneration < 1) return null;
  return {
    runId: scrapeState.runId,
    cellGeneration: scrapeState.cellGeneration
  };
}

function acceptsActiveCellMessage(message, sender) {
  return RunLease.acceptsMessage(
    getActiveCellLease(),
    message,
    sender?.tab?.id,
    scrapeState.mapsTabId
  );
}

let currentSearch = null;
let isAborting = false;
let pointsFinalized = false;
let lastScrapeProgressAt = 0;
let stallRecoveryBusy = false;
let mapsReloadRecoverBusy = false;
let mapsReloadTimer = null;
let syncDebounceTimer = null;
const MAPS_AUTO_FOCUS_ALARM = "timdiemban_maps_focus";
let mapsCellWorkDepth = 0;
let mapsTabInactiveSince = 0;
let mapsTabLossBusy = false;

/** Ngân sách thời gian tối đa cho một ô (pha cuộn + pha lấy chi tiết) */
const CELL_SCRAPE_TIMEOUT_MS = 600000;

const SCRAPE_CHECKPOINT_KEY = "scrapeCheckpoint";
const RESCAN_CHECKPOINT_KEY = "rescanCheckpoint";
const PENDING_SYNC_KEY = "pendingSearchSync";
const DurableLifecycle = globalThis.TimDiemBanLifecycle;
const DURABLE_WORK_ALARM = DurableLifecycle.WATCHDOG_ALARM;
const DURABLE_WORK_PERIOD_MINUTES = DurableLifecycle.WATCHDOG_PERIOD_MINUTES;
const WEB_DATA_TYPES = new Set(["item", "sync", "items_batch", "progress", "complete", "start"]);

let serviceBootComplete = false;
let serviceBootPromise = null;
let durableRecoveryBusy = false;

let persistSyncTimer = null;
let persistCheckpointTimer = null;
let lastWebPushAt = 0;
let webPushTick = 0;
/** Số quán đã gửy snapshot đầy đủ về trang kết quả */
let lastSyncedMergedCount = 0;
let lastForceSyncAt = 0;
let lastKeepaliveSyncAt = 0;
let pushSyncBusy = false;
let pushSyncQueued = null;
let reconcilePending = false;
let itemDeliveryCheckTimer = null;

function toDurableSearchParams(params) {
  if (!params || typeof params !== "object") return params;
  const durable = { ...params };
  delete durable.authToken;
  return durable;
}

function scheduleItemDeliveryCheck() {
  if (itemDeliveryCheckTimer) return;
  itemDeliveryCheckTimer = setTimeout(() => {
    itemDeliveryCheckTimer = null;
    if (!scrapeState.running) return;
    reconcileWebCountWithExtension("item_check").catch(() => {});
  }, 800);
}

async function readWebTabStats(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () =>
        typeof window.__timDiemBanGetStats === "function" ? window.__timDiemBanGetStats() : null
    });
    return result || null;
  } catch {
    return null;
  }
}

async function verifyWebReceived(tabId, minCount, searchId) {
  await sleep(120);
  const stats = await readWebTabStats(tabId);
  if (!stats) return { ok: false, stats: null, reason: "no_stats" };
  // searchId lệch khi trang chưa nhận start — không coi là OK
  if (searchId && stats.searchId && stats.searchId !== searchId) {
    return { ok: false, stats, reason: "search_id_mismatch" };
  }
  const webCount = Number(stats.count ?? 0);
  const applied = Number(stats.lastSyncApplied ?? webCount);
  const incoming = Number(stats.lastSyncIncoming ?? 0);
  if (minCount != null) {
    const need = Number(minCount);
    // Đủ dòng trên bảng, hoặc vừa nhận đủ snapshot (incoming) dù còn đang render
    if (webCount >= need || applied >= need || incoming >= need) {
      return { ok: true, stats, webCount };
    }
    return { ok: false, stats, reason: "count_short", webCount, applied, incoming, minCount: need };
  }
  return { ok: true, stats, webCount };
}

// ——— Trạng thái Quét lại (Rescan) ———
const rescanState = {
  running: false,
  mapsTabId: null,
  mapsWindowId: null,
  webUrl: null,
  done: 0,
  total: 0,
  placeIndex: 0,
  places: null,
  params: null,
  searchParams: null,
  mapsAutoReopen: false,
  _reopenCount: 0,
  _handlingTabLoss: false,
  _awaitingReopen: false
};

function pingMapsTabWake(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof window.__timDiemBanWake === "function") window.__timDiemBanWake();
        else document.dispatchEvent(new CustomEvent("timdiemban-wake", { bubbles: true }));
      }
    })
    .catch(() => {});
  chrome.tabs.sendMessage(tabId, { action: "KEEPALIVE_TICK" }).catch(() => {});
}

// ——— Chế độ quét nền (Maps Background Boost) ———
// Tab nằm nền bị Chrome ngừng render: requestAnimationFrame/IntersectionObserver
// của Google Maps không chạy nên danh sách kết quả không tải thêm. Gắn
// chrome.debugger vào tab Maps để:
//   1. Emulation.setFocusEmulationEnabled — trang luôn coi như đang được focus.
//   2. Page.startScreencast (khung hình tí hon) — buộc compositor render đều đặn
//      dù tab ẩn, nhờ đó rAF/IntersectionObserver của Maps tiếp tục chạy.
//   3. Runtime.evaluate userGesture — mở khóa autoplay cho AudioContext chống
//      throttle trong content script.
// Người dùng chỉ cần giữ tab Maps mở, không cần đứng ở tab đó. Nếu không gắn
// được (DevTools đang mở, người dùng bấm Hủy trên thanh gỡ lỗi…) thì quay về
// hành vi cũ: đưa tab Maps lên trước.
const mapsBoost = {
  tabId: null,
  attached: false,
  unavailable: false,
  lastAssertAt: 0,
  lastAttachFailAt: 0
};

function isMapsBoostSupported() {
  return typeof chrome.debugger?.attach === "function";
}

async function hasMapsBoostPermission() {
  if (!isMapsBoostSupported()) return false;
  try {
    return await chrome.permissions.contains({ permissions: ["debugger"] });
  } catch {
    return false;
  }
}

async function sendBoostCommand(method, params) {
  if (!mapsBoost.attached || mapsBoost.tabId == null) return;
  await chrome.debugger.sendCommand({ tabId: mapsBoost.tabId }, method, params || {});
}

/** Phát (lại) các lệnh giữ tab nền hoạt động — an toàn khi gọi lặp. */
async function assertMapsBoostState() {
  await sendBoostCommand("Page.enable").catch(() => {});
  await sendBoostCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await sendBoostCommand("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await sendBoostCommand("Page.startScreencast", {
    format: "jpeg",
    quality: 10,
    maxWidth: 96,
    maxHeight: 96,
    everyNthFrame: 4
  }).catch(() => {});
  await sendBoostCommand("Runtime.evaluate", {
    expression: "document.dispatchEvent(new CustomEvent('timdiemban-audio-unlock'))",
    userGesture: true
  }).catch(() => {});
  mapsBoost.lastAssertAt = Date.now();
}

async function enableMapsBoost(tabId) {
  if (!isMapsBoostSupported() || mapsBoost.unavailable || !Number.isInteger(tabId)) return false;
  if (!(await hasMapsBoostPermission())) return false;
  if (mapsBoost.attached && mapsBoost.tabId === tabId) return true;
  if (Date.now() - mapsBoost.lastAttachFailAt < 10000) return false;
  if (mapsBoost.attached) await disableMapsBoost();
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    // DevTools hoặc công cụ khác đang chiếm tab — quét theo cách cũ.
    mapsBoost.lastAttachFailAt = Date.now();
    console.warn("enableMapsBoost:", err?.message || err);
    return false;
  }
  mapsBoost.tabId = tabId;
  mapsBoost.attached = true;
  await assertMapsBoostState();
  return true;
}

/** Gọi sau điều hướng/định kỳ: gắn lại nếu rớt, phát lại lệnh nếu đã lâu. */
async function ensureMapsBoost(tabId) {
  // Chặn tick/điều hướng đang bay gắn lại debugger sau khi đã dừng quét.
  if (!scrapeState.running && !rescanState.running) return false;
  if (!isMapsBoostSupported() || mapsBoost.unavailable || !Number.isInteger(tabId)) return false;
  if (!mapsBoost.attached || mapsBoost.tabId !== tabId) return enableMapsBoost(tabId);
  if (Date.now() - mapsBoost.lastAssertAt > 5000) await assertMapsBoostState();
  return true;
}

async function disableMapsBoost() {
  const tabId = mapsBoost.tabId;
  mapsBoost.attached = false;
  mapsBoost.tabId = null;
  if (tabId == null || !isMapsBoostSupported()) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.stopScreencast");
  } catch {}
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

function maybeReleaseMapsBoost() {
  if (scrapeState.running || rescanState.running) return;
  mapsBoost.unavailable = false;
  mapsBoost.lastAttachFailAt = 0;
  disableMapsBoost().catch(() => {});
}

if (isMapsBoostSupported()) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Page.screencastFrame" || source.tabId !== mapsBoost.tabId) return;
    chrome.debugger
      .sendCommand({ tabId: source.tabId }, "Page.screencastFrameAck", {
        sessionId: params.sessionId
      })
      .catch(() => {});
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== mapsBoost.tabId) return;
    mapsBoost.attached = false;
    mapsBoost.tabId = null;
    if (reason === "canceled_by_user") {
      // Người dùng bấm Hủy trên thanh gỡ lỗi — không gắn lại trong lượt này.
      mapsBoost.unavailable = true;
      if (scrapeState.running) {
        notifyProgress(
          calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.2),
          "Chế độ quét nền đã tắt. Hãy đưa tab Google Maps lên trước để quét ổn định."
        );
      }
    }
  });
}

function isValidWindowId(windowId) {
  return Number.isInteger(windowId) && windowId >= 0;
}

async function getTabWindowId(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return isValidWindowId(tab?.windowId) ? tab.windowId : null;
  } catch {
    return null;
  }
}

async function activateTabAndWindow(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true, autoDiscardable: false });
  if (isValidWindowId(tab?.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return tab;
}

async function createMapsTab(url, preferredWindowId, { active = false } = {}) {
  const createOptions = { url, active };
  if (isValidWindowId(preferredWindowId)) createOptions.windowId = preferredWindowId;

  let tab;
  try {
    tab = await chrome.tabs.create(createOptions);
  } catch (err) {
    // Trang Findmap có thể vừa chuyển/đóng cửa sổ trong lúc kiểm tra tài khoản.
    if (!isValidWindowId(preferredWindowId)) throw err;
    tab = await chrome.tabs.create({ url, active });
  }

  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

/**
 * Mỗi phiên sở hữu một tab Maps riêng. Mặc định mở ở nền kèm chế độ quét nền
 * để người dùng tiếp tục làm việc ở tab khác; nếu không gắn được thì đưa tab
 * lên trước như trước đây. mapsAutoFocus chỉ điều khiển việc kéo người dùng
 * quay lại định kỳ sau đó.
 */
async function openMapsScrapeTab(url) {
  const preferredWindowId = await getTabWindowId(scrapeState.webTabId);
  const tab = await createMapsTab(url, preferredWindowId, { active: false });
  scrapeState.mapsWindowId = tab.windowId;
  const boosted = await enableMapsBoost(tab.id);
  if (!boosted) await activateTabAndWindow(tab.id);
  return tab;
}

async function scrapeKeepAliveTick() {
  if (!scrapeState.running) {
    stopScrapeKeepAlive();
    return;
  }
  chrome.runtime.getPlatformInfo(() => {});
  if (scrapeState.mapsTabId) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(scrapeState.mapsTabId);
    } catch {}

    if (tab) {
      await chrome.tabs.update(scrapeState.mapsTabId, { autoDiscardable: false }).catch(() => {});
      const boosted = await ensureMapsBoost(scrapeState.mapsTabId).catch(() => false);
      if (!tab.active && !boosted) {
        if (!mapsTabInactiveSince) mapsTabInactiveSince = Date.now();
        const inactiveMs = Date.now() - mapsTabInactiveSince;

        if (inactiveMs >= 12000 && !scrapeState._bgWarnSent) {
          scrapeState._bgWarnSent = true;
          notifyProgress(
            calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.2),
            "Tab Google Maps đang ở nền. Nếu tiến độ không thay đổi, hãy đưa tab đó lên trước."
          );
        }
      } else {
        mapsTabInactiveSince = 0;
        scrapeState._bgWarnSent = false;
      }
    }

    pingMapsTabWake(scrapeState.mapsTabId);
  }

  if (scrapeState.webTabId) {
    try {
      await chrome.tabs.update(scrapeState.webTabId, { autoDiscardable: false });
    } catch {}
  }

  webPushTick += 1;
  const mergedCount = getFinalResultsList().length;
  const now = Date.now();
  const behind = mergedCount > lastSyncedMergedCount;
  // Lệch càng lớn → sync nền càng dày (3s), bình thường 6s
  const keepaliveMs = behind && mergedCount - lastSyncedMergedCount >= 10 ? 3000 : 6000;
  if (mergedCount > 0 && now - lastKeepaliveSyncAt >= keepaliveMs) {
    lastKeepaliveSyncAt = now;
    if (behind) {
      ensureWebSyncedToResults("Đang bổ sung kết quả còn thiếu về Findmap…", true).catch(() => {});
    }
    reconcileWebCountWithExtension("keepalive").catch(() => {});
  }

  persistScrapeCheckpoint().catch(() => {});
  maybeRecoverStalledScrape().catch(() => {});
}

async function focusMapsTabForSearch() {
  // Chỉ nhảy cửa sổ khi user bật "Tự chuyển sang tab Google Maps"
  if (!isMapsAutoFocusEnabled()) return;
  if (!scrapeState.running || !scrapeState.mapsTabId) return;
  try {
    const tab = await chrome.tabs.get(scrapeState.mapsTabId);
    if (!tab) return;
    const wasActive = tab.active;
    await activateTabAndWindow(scrapeState.mapsTabId);
    mapsTabInactiveSince = 0;
    scrapeState._bgWarnSent = false;
    if (!wasActive) {
      notifyProgress(
        calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.2),
        "Đã tự chuyển sang tab Google Maps — giữ tab này mở để quét ổn định."
      );
    }
  } catch (err) {
    console.warn("focusMapsTabForSearch:", err.message);
  }
}

function isMapsAutoFocusEnabled() {
  return scrapeState.searchParams?.mapsAutoFocus === true;
}

function syncMapsAutoFocusAlarm() {
  if (scrapeState.running && isMapsAutoFocusEnabled()) {
    startMapsAutoFocus();
  } else {
    stopMapsAutoFocus();
  }
}

function startMapsAutoFocus() {
  stopMapsAutoFocus();
  chrome.alarms.create(MAPS_AUTO_FOCUS_ALARM, { periodInMinutes: getMapsAutoFocusMinutes() });
}

function stopMapsAutoFocus() {
  chrome.alarms.clear(MAPS_AUTO_FOCUS_ALARM);
}

async function ensureDurableWorkAlarm() {
  try {
    const current = await chrome.alarms.get(DURABLE_WORK_ALARM);
    if (current?.periodInMinutes === DURABLE_WORK_PERIOD_MINUTES) return;
  } catch {}
  chrome.alarms.create(DURABLE_WORK_ALARM, {
    delayInMinutes: DURABLE_WORK_PERIOD_MINUTES,
    periodInMinutes: DURABLE_WORK_PERIOD_MINUTES
  });
}

async function clearDurableWorkAlarmIfIdle() {
  if (scrapeState.running || rescanState.running) return;
  try {
    const [scrapeCheckpoint, rescanCheckpoint] = await Promise.all([
      getScrapeCheckpoint(),
      getRescanCheckpoint()
    ]);
    if (
      DurableLifecycle.isRecoverableScrapeCheckpoint(scrapeCheckpoint) ||
      DurableLifecycle.isRecoverableRescanCheckpoint(rescanCheckpoint)
    ) {
      await ensureDurableWorkAlarm();
      return;
    }
  } catch {}
  chrome.alarms.clear(DURABLE_WORK_ALARM);
}

function startScrapeKeepAlive() {
  scrapeKeepAliveTick().catch(() => {});
  ensureDurableWorkAlarm().catch(() => {});
  syncMapsAutoFocusAlarm();
}

function stopScrapeKeepAlive() {
  stopMapsAutoFocus();
  clearDurableWorkAlarmIfIdle().catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DURABLE_WORK_ALARM) {
    recoverDurableWork("watchdog_alarm")
      .then(async () => {
        if (scrapeState.running) await scrapeKeepAliveTick();
        if (rescanState.running) await persistRescanCheckpoint();
        await clearDurableWorkAlarmIfIdle();
      })
      .catch((err) => console.warn("durable watchdog:", err?.message || err));
  }
  if (alarm.name === MAPS_AUTO_FOCUS_ALARM) {
    ensureServiceReady("maps_auto_focus_alarm")
      .then(() => {
        if (scrapeState.running && isMapsAutoFocusEnabled()) return focusMapsTabForSearch();
      })
      .catch(() => {});
  }
});

function getWebUrlLabel(webUrl) {
  try {
    return new URL(String(webUrl || getAppOrigin())).host;
  } catch {
    return getAppOriginLabel();
  }
}

function updateMapsShield(progressText, percent) {
  if (!scrapeState.mapsTabId) return;
  const data = {
    webUrl: currentSearch?.webUrl || scrapeState.searchParams?.webUrl,
    webLabel: getWebUrlLabel(currentSearch?.webUrl || scrapeState.searchParams?.webUrl)
  };
  if (progressText) data.text = String(progressText).slice(0, 140);
  if (percent != null) data.percent = percent;
  if (!data.text && data.percent == null) return;
  chrome.tabs
    .sendMessage(scrapeState.mapsTabId, { action: "SCRAPE_SHIELD_UPDATE", data })
    .catch(() => {
      // Overlay mất / script cũ — reinject rồi thử lại
      ensureMapsContentReady(scrapeState.mapsTabId)
        .then(() =>
          chrome.tabs.sendMessage(scrapeState.mapsTabId, {
            action: "SCRAPE_SHIELD_UPDATE",
            data
          })
        )
        .catch(() => {});
    });
}

let reconcileBusy = false;
let reconcileTimer = null;

/** Ép số quán web = extension — gọi sau mỗi item / khi phát hiện lệch */
async function reconcileWebCountWithExtension(reason = "reconcile") {
  if (!scrapeState.running || !scrapeState.searchParams?.webUrl) return true;
  const extCount = getFinalResultsList().length;
  if (!extCount) return true;

  const run = async () => {
    if (reconcileBusy) {
      reconcilePending = true;
      return false;
    }
    reconcileBusy = true;
    try {
      const tab = scrapeState.webTabId
        ? await chrome.tabs.get(scrapeState.webTabId).catch(() => null)
        : await findWebTab(scrapeState.searchParams.webUrl);
      if (!tab?.id) {
        return false;
      }
      scrapeState.webTabId = tab.id;

      let stats = await readWebTabStats(tab.id);
      let webCount = stats?.count ?? 0;

      if (webCount >= extCount) {
        lastSyncedMergedCount = extCount;
        return true;
      }

      const pct = calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.35);
      await pushSyncSnapshotToWeb(`Đang đồng bộ ${extCount} điểm bán về Findmap (${webCount} đã nhận)`, pct);

      stats = await readWebTabStats(tab.id);
      webCount = stats?.count ?? 0;

      if (webCount >= extCount) {
        lastSyncedMergedCount = extCount;
        return true;
      }
      return false;
    } finally {
      reconcileBusy = false;
      if (reconcilePending) {
        reconcilePending = false;
        setTimeout(() => run(), 400);
      }
    }
  };

  if (reason === "immediate") return run();
  return new Promise((resolve) => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      run().then(resolve);
    }, 250);
  });
}

function buildProgressText(cell, cellIndex, totalCells, extra = {}) {
  const step = cellIndex + 1;
  const label = cell?.cellLabel || cell?.cellId || `Khu vực ${step}`;
  const parts = [`Khu vực ${step}/${totalCells} · ${label}`];
  if (extra.action) parts.push(extra.action);
  if (extra.newCount != null) parts.push(`${extra.newCount} điểm mới`);
  if (extra.skipped != null) parts.push(`Bỏ qua ${extra.skipped} kết quả trùng`);
  if (extra.total != null) parts.push(`Tổng ${extra.total} điểm bán`);
  return parts.join(" · ");
}

function calcProgressPercent(cellIndex, totalCells, inCellRatio = 0) {
  if (!totalCells) return 0;
  const ratio = Math.max(0, Math.min(1, Number(inCellRatio) || 0));
  const idx = Math.max(0, Number(cellIndex) || 0);
  const doneCells = (idx / totalCells) * 70;
  const withinSpan = Math.max(8, 70 / totalCells);
  const within = ratio * withinSpan;
  return Math.min(95, Math.max(0, Math.round(doneCells + within)));
}

async function apiFetch(webUrl, path, options = {}) {
  const base = String(webUrl || "").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Không thể kết nối máy chủ Findmap (mã ${res.status}). Vui lòng thử lại.`);
  }
  return data;
}

async function checkAuthAndPoints(webUrl, authToken) {
  if (!authToken) {
    throw new Error(`Vui lòng đăng nhập Findmap tại ${getAppOriginLabel()} trước khi tìm kiếm.`);
  }
  const { user } = await apiFetch(webUrl, "/api/auth/me", {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if ((user.points || 0) <= 0) {
    throw new Error("Tài khoản đã hết điểm. Mỗi kết quả có số điện thoại sử dụng 1 điểm. Vui lòng nạp thêm điểm để tiếp tục.");
  }
  return user;
}

function countResultsWithPhone(list) {
  return list.filter((p) => normalizePhone(p?.phone).length >= 9).length;
}

function limitResultsByPhonePoints(list, allowedPhoneCount) {
  const withPhone = [];
  const withoutPhone = [];
  for (const p of list) {
    if (normalizePhone(p?.phone).length >= 9) withPhone.push(p);
    else withoutPhone.push(p);
  }
  return [...withPhone.slice(0, allowedPhoneCount), ...withoutPhone];
}

async function chargeSearchResults(webUrl, authToken, phoneCount) {
  return apiFetch(webUrl, "/api/search/charge", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ phoneCount })
  });
}

function getFinalResultsList() {
  const params = scrapeState.searchParams;
  if (!params) return [];
  const list = dedupePlaces(Array.from(scrapeState.mergedPlaces.values()));
  const annotated = annotatePlacesRadius(list, params.lat, params.lng, params.radius);
  annotated.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  return annotated;
}

function scheduleSyncSnapshot(text, percent, immediate = false) {
  if (!scrapeState.running) return;
  const run = () => {
    pushSyncSnapshotToWeb(text, percent).catch((err) =>
      console.warn("pushSyncSnapshotToWeb:", err.message)
    );
  };
  if (immediate) {
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }
    run();
    return;
  }
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    syncDebounceTimer = null;
    run();
  }, immediate ? 200 : 900);
}

async function tabHasIngestHandler(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => typeof window.__timDiemBanIngestSync === "function"
    });
    return !!result;
  } catch {
    return false;
  }
}

async function findWebTab(webUrl) {
  const candidates = resolveWebUrlCandidates(webUrl);
  try {
    const preferred = await getPreferredWebOrigin();
    if (preferred && !candidates.includes(preferred)) candidates.unshift(preferred);
    for (const extra of await getExtraWebOrigins()) {
      if (!candidates.includes(extra)) candidates.push(extra);
    }
  } catch {}
  const tryTabs = [];

  if (scrapeState.webTabId) {
    try {
      const pinned = await chrome.tabs.get(scrapeState.webTabId);
      if (pinned?.id) tryTabs.push(pinned);
    } catch {}
  }

  for (const origin of candidates) {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    for (const t of tabs) {
      if (!tryTabs.some((x) => x.id === t.id)) tryTabs.push(t);
    }
  }

  if (!tryTabs.length) {
    let hostRes = [];
    try {
      hostRes = [
        new RegExp(new URL(getAppOrigin()).hostname.replace(/\./g, "\\."), "i"),
        ...(await getExtraWebOrigins()).map(
          (o) => new RegExp(new URL(o).hostname.replace(/\./g, "\\."), "i")
        )
      ];
    } catch {}
    if (hostRes.length) {
      const all = await chrome.tabs.query({});
      for (const t of all) {
        if (
          t.url &&
          hostRes.some((re) => re.test(t.url)) &&
          !tryTabs.some((x) => x.id === t.id)
        ) {
          tryTabs.push(t);
        }
      }
    }
  }

  // Ưu tiên tab có handler app.js (trang kết quả thật)
  for (const tab of tryTabs) {
    if (await tabHasIngestHandler(tab.id)) return tab;
  }
  return tryTabs[0] || null;
}

async function reloadWebTabAndWait(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Trang kết quả mất quá nhiều thời gian để tải lại. Vui lòng thử lại."));
    }, 15000);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId);
  });
}

async function waitTabComplete(tabId, timeoutMs = 20000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "complete") return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Google Maps tải quá lâu"));
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

const EXT_QUEUE_KEY = "timdiemban_ext_queue";

/** Gửi thẳng vào handler trang — trả về true chỉ khi ingest vào bảng thành công */
async function deliverDataToWebTab(tabId, type, payload) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (data, queueKey) => {
        let delivered = false;
        if (typeof window.__timDiemBanIngestSync === "function") {
          try {
            window.__timDiemBanIngestSync(data.type, data.payload);
            delivered = true;
            if (
              data.type === "complete" &&
              typeof window.__timDiemBanHandlePayload === "function"
            ) {
              window.__timDiemBanHandlePayload(data.type, data.payload);
            }
          } catch (e) {
            console.warn("TimDiemBan ingestSync:", e);
            delivered = false;
          }
        }
        if (!delivered) {
          try {
            const q = JSON.parse(localStorage.getItem(queueKey) || "[]");
            q.push({ type: data.type, payload: data.payload, at: Date.now() });
            while (q.length > 800) q.shift();
            localStorage.setItem(queueKey, JSON.stringify(q));
          } catch {}
          try {
            window.postMessage(
              { source: "timdiemban-ext", type: data.type, payload: data.payload },
              window.location.origin
            );
            delivered = true;
          } catch {}
        }
        return { delivered };
      },
      args: [{ type, payload }, EXT_QUEUE_KEY]
    });
    return !!(result && result.delivered);
  } catch (err) {
    console.warn("deliverDataToWebTab:", err?.message || err);
    return false;
  }
}

let itemSyncBackoffUntil = 0;
let itemsSinceLastForceSync = 0;

/** Gửi từng quán — chỉ full-sync khi gửi thất bại thật; lệch số thì reconcile có nhịp */
function sendItemToWeb(webUrl, result, searchParams) {
  const mergedCount = getFinalResultsList().length;
  return sendToWebPage(webUrl, "item", {
    result,
    searchParams: currentSearch || searchParams,
    mergedCount
  }).then(async (ok) => {
    itemsSinceLastForceSync += 1;
    // Mỗi 3 quán hoặc khi gửi lỗi → ép snapshot đầy đủ (tránh lệch tích lũy)
    const now = Date.now();
    if (!ok || itemsSinceLastForceSync >= 3) {
      if (now >= itemSyncBackoffUntil) {
        itemSyncBackoffUntil = now + 800;
        itemsSinceLastForceSync = 0;
        await pushSyncSnapshotToWeb(
          ok
            ? `Đang cập nhật ${mergedCount} điểm bán về Findmap`
            : "Đang gửi lại kết quả chưa được Findmap xác nhận…",
          0
        );
      }
    }
    scheduleItemDeliveryCheck();
    return ok;
  });
}

function schedulePersistSearchSync() {
  if (persistSyncTimer) return;
  persistSyncTimer = setTimeout(async () => {
    persistSyncTimer = null;
    if (!scrapeState.searchParams) return;
    const results = getFinalResultsList();
    if (!results.length) return;
    try {
      await chrome.storage.local.set({
        [PENDING_SYNC_KEY]: {
          results,
          searchParams: toDurableSearchParams(currentSearch || scrapeState.searchParams),
          mergedCount: results.length,
          at: Date.now()
        }
      });
    } catch {}
  }, 200);
}

/** Luôn bật: lưu snapshot extension + checkpoint — tránh mất dữ liệu khi tab nền */
function scheduleLiveSearchBackup(includeCheckpoint = true) {
  schedulePersistSearchSync();
  if (!includeCheckpoint) return;
  if (persistCheckpointTimer) return;
  persistCheckpointTimer = setTimeout(() => {
    persistCheckpointTimer = null;
    persistScrapeCheckpoint().catch(() => {});
  }, 1000);
}

async function clearPendingSearchSync() {
  try {
    await chrome.storage.local.remove(PENDING_SYNC_KEY);
  } catch {}
}

async function sendToWebPage(webUrl, type, payload, options = {}) {
  const { abortOnFail = false } = options;
  const tab = await findWebTab(webUrl);
  if (!tab) {
    if (type === "item" || type === "sync" || type === "items_batch" || type === "complete") {
      scheduleLiveSearchBackup(true);
    }
    if (scrapeState.running && abortOnFail) {
      await abortSearch(
        "TAB_WEB_CLOSED",
        "Trang kết quả đã bị tắt. Vui lòng mở lại trang web và chạy lại tìm kiếm."
      );
    }
    return false;
  }

  if (tab.status === "loading") {
    await waitTabComplete(tab.id, 20000).catch(() => {});
    await sleep(200);
  }

  scrapeState.webTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});

  const message = { action: "TIMDIEMBAN_DATA", type, payload };
  let ok = false;
  let deliveredToIngest = false;

  if (WEB_DATA_TYPES.has(type)) {
    try {
      deliveredToIngest = await deliverDataToWebTab(tab.id, type, payload);
      ok = deliveredToIngest;
    } catch {
      ok = false;
      deliveredToIngest = false;
    }
  }

  // Fallback bridge chỉ khi chưa ingest được vào bảng
  if (!ok) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      ok = true;
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["web-bridge.js"]
        });
        await sleep(150);
        await chrome.tabs.sendMessage(tab.id, message);
        ok = true;
      } catch {
        ok = false;
      }
    }
  }

  const searchId = payload?.searchParams?.searchId || currentSearch?.searchId;
  const expectCount =
    type === "sync"
      ? payload?.mergedCount ?? payload?.results?.length
      : type === "item"
        ? payload?.mergedCount
        : type === "complete"
          ? payload?.total ?? payload?.results?.length
          : null;

  // Chỉ sync/complete mới bắt buộc khớp số dòng.
  // Item: KHÔNG fail vì web còn thiếu tổng — nếu fail sẽ spam sync và lệch càng lớn.
  if (ok && tab.id && expectCount != null && (type === "sync" || type === "complete")) {
    let verified = false;
    for (let v = 0; v < 4 && !verified; v++) {
      const check = await verifyWebReceived(tab.id, expectCount, searchId);
      if (check.ok) {
        verified = true;
        break;
      }
      if (!deliveredToIngest || v > 0) {
        try {
          deliveredToIngest = await deliverDataToWebTab(tab.id, type, payload);
        } catch {}
      }
      await sleep(150 * (v + 1));
    }
    if (!verified) ok = false;
  } else if (ok && tab.id && type === "item") {
    // Chỉ đánh dấu lệch để bù snapshot — không coi item đã ingest là thất bại
    const check = await verifyWebReceived(tab.id, null, searchId);
    const webCount = check.stats?.count ?? 0;
    if (expectCount != null && webCount < expectCount) {
      scheduleItemDeliveryCheck();
    }
  }

  if (ok) {
    lastWebPushAt = Date.now();
    if (type === "item" || type === "sync" || type === "items_batch") {
      scheduleLiveSearchBackup(true);
    }
    if (type === "complete") await clearPendingSearchSync();
    return true;
  }

  if (type === "item" || type === "sync" || type === "items_batch") {
    scheduleLiveSearchBackup(true);
  }

  if (scrapeState.running && abortOnFail) {
    await abortSearch(
      "TAB_WEB_CLOSED",
      "Trang kết quả đã bị tắt. Vui lòng mở lại trang web và chạy lại tìm kiếm."
    );
  }
  return false;
}

async function pushSyncSnapshotToWeb(text, percent) {
  if (!currentSearch?.webUrl || !scrapeState.searchParams) return false;

  // Đang bận: chỉ giữ snapshot MỚI NHẤT (luôn lấy getFinalResultsList khi chạy)
  if (pushSyncBusy) {
    pushSyncQueued = { text, percent, at: Date.now() };
    return false;
  }

  pushSyncBusy = true;
  let okFinal = false;
  try {
    // Lặp: gửi snapshot hiện tại; nếu có queue mới trong lúc gửi thì gửi tiếp
    for (let round = 0; round < 4; round++) {
      const results = getFinalResultsList();
      if (!results.length) break;

      const payload = {
        results,
        searchParams: currentSearch,
        text: text || `Đang đồng bộ ${results.length} điểm bán về Findmap`,
        percent: percent ?? 0,
        mergedCount: results.length
      };

      let ok = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        ok = await sendToWebPage(currentSearch.webUrl, "sync", payload);
        if (ok) {
          const tab = scrapeState.webTabId
            ? await chrome.tabs.get(scrapeState.webTabId).catch(() => null)
            : await findWebTab(currentSearch.webUrl);
          if (tab?.id) {
            const check = await verifyWebReceived(
              tab.id,
              results.length,
              currentSearch.searchId
            );
            if (check.ok) {
              lastSyncedMergedCount = results.length;
              lastForceSyncAt = Date.now();
              okFinal = true;
              break;
            }
            ok = false;
          } else {
            lastSyncedMergedCount = results.length;
            lastForceSyncAt = Date.now();
            okFinal = true;
            break;
          }
        }
        await sleep(150 * (attempt + 1));
      }

      // Có snapshot mới hơn trong lúc sync → gửi tiếp vòng sau
      if (pushSyncQueued) {
        const q = pushSyncQueued;
        pushSyncQueued = null;
        text = q.text || text;
        percent = q.percent ?? percent;
        continue;
      }

      if (okFinal) break;
      if (!ok) await sleep(200);
    }
    return okFinal;
  } finally {
    pushSyncBusy = false;
    if (pushSyncQueued) {
      const q = pushSyncQueued;
      pushSyncQueued = null;
      if (Date.now() - q.at < 60000) {
        setTimeout(() => pushSyncSnapshotToWeb(q.text, q.percent), 100);
      }
    }
  }
}

/** Đẩy snapshot đầy đủ khi extension có nhiều quán hơn lần sync trước */
async function ensureWebSyncedToResults(reason, force = false) {
  if (!scrapeState.searchParams?.webUrl) return false;
  const results = getFinalResultsList();
  const count = results.length;
  if (!count) return false;
  const stale = count > lastSyncedMergedCount;
  if (!force && !stale) return false;
  if (force && Date.now() - lastForceSyncAt < 600) return false;
  scheduleLiveSearchBackup(true);
  const pct = calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.35);
  const text =
    reason ||
    (stale
      ? `Đang bổ sung ${count - lastSyncedMergedCount} điểm còn thiếu về Findmap`
      : `Đang đồng bộ ${count} điểm bán về Findmap`);
  return pushSyncSnapshotToWeb(text, pct);
}

function notifyPopup(error) {
  chrome.runtime.sendMessage({ action: "SEARCH_ERROR", error }).catch(() => {});
}

/**
 * Log chẩn đoán từ background — đi cùng luồng với SCRAPE_LOG của content.js
 * nên hiện ở cả Console, popup và trang kết quả.
 */
function bgLog(line) {
  const text = `[BG] ${line}`;
  console.log("TimDiemBan:", text);
  chrome.runtime.sendMessage({ action: "SEARCH_LOG", line: text }).catch(() => {});
  if (currentSearch?.webUrl) {
    sendToWebPage(currentSearch.webUrl, "log", { line: text }).catch(() => {});
  }
}

function notifyProgress(percent, text) {
  lastScrapeProgressAt = Date.now();
  chrome.runtime.sendMessage({ action: "SEARCH_PROGRESS", percent, text }).catch(() => {});
  // Luôn đẩy overlay Maps — tránh UI kẹt text cũ trong khi vẫn scrape/gửi kết quả
  updateMapsShield(text, percent);
  if (currentSearch?.webUrl) {
    return sendToWebPage(currentSearch.webUrl, "progress", {
      percent,
      text,
      mergedCount: getFinalResultsList().length,
      searchParams: currentSearch
    }).catch(() => false);
  }
  return Promise.resolve(false);
}

async function waitForMapsTabReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!scrapeState.running) return false;
    if (scrapeState.mapsTabId) {
      try {
        const tab = await chrome.tabs.get(scrapeState.mapsTabId);
        if (tab?.status === "complete") return true;
      } catch {
        return false;
      }
    }
    await sleep(250);
  }
  return Boolean(scrapeState.mapsTabId);
}

function mergePlaces(newPlaces) {
  const params = scrapeState.searchParams;
  if (!params) return;
  const existingList = Array.from(scrapeState.mergedPlaces.values());
  const cell = scrapeState.gridPoints[scrapeState.gridIndex] || {};
  const mapLat = cell.lat ?? params.lat;
  const mapLng = cell.lng ?? params.lng;

  for (const raw of newPlaces) {
    if (!raw || !isValidPlaceName(raw.name)) continue;
    let place = sanitizePlace(raw, params.lat, params.lng, params.radius, mapLat, mapLng);
    if (!place) {
      place = sanitizeFromList(raw, params.lat, params.lng, params.radius, mapLat, mapLng, true);
    }
    if (!place) continue;
    if (place._cellDist == null && cell.distFromCenter != null) {
      place._cellDist = cell.distFromCenter;
    }
    const dup = existingList.find((e) => isNearDuplicate(e, place));
    if (dup) mergePlaceRecord(dup, place);
    else existingList.push(place);
  }

  const deduped = dedupePlaces(existingList);
  scrapeState.mergedPlaces = placesToMap(deduped);
}

function upsertMergedPlace(place) {
  const params = scrapeState.searchParams;
  if (!params || !place || !isValidPlaceName(place.name)) return null;
  const cell = scrapeState.gridPoints[scrapeState.gridIndex] || {};
  const mapLat = cell.lat ?? params.lat;
  const mapLng = cell.lng ?? params.lng;

  const existingList = Array.from(scrapeState.mergedPlaces.values());
  let record = existingList.find((e) => isNearDuplicate(e, place));

  if (record) {
    mergePlaceRecord(record, place);
  } else {
    let sanitized =
      sanitizePlace(place, params.lat, params.lng, params.radius, mapLat, mapLng) ||
      sanitizeFromList(place, params.lat, params.lng, params.radius, mapLat, mapLng, true);
    record = sanitized || { ...place };
    existingList.push(record);
  }

  const deduped = dedupePlaces(existingList);
  scrapeState.mergedPlaces = placesToMap(deduped);
  return (
    scrapeState.mergedPlaces.get(getDedupeKey(record)) ||
    [...scrapeState.mergedPlaces.values()].find((e) => isNearDuplicate(e, record)) ||
    record
  );
}

async function persistScrapeCheckpoint() {
  if (!scrapeState.searchParams) return;
  const running = scrapeState.running || scrapeState.mergedPlaces.size > 0;
  if (!running) return;
  const durableSearchParams = toDurableSearchParams(scrapeState.searchParams);
  try {
    await chrome.storage.local.set({
      [SCRAPE_CHECKPOINT_KEY]: {
        version: DurableLifecycle.CHECKPOINT_VERSION,
        running: scrapeState.running,
        runId: scrapeState.runId,
        cellGeneration: scrapeState.cellGeneration,
        lastHeartbeat: Date.now(),
        savedAt: Date.now(),
        lastProgressAt: lastScrapeProgressAt || Date.now(),
        gridIndex: scrapeState.gridIndex,
        totalCells: scrapeState.totalCells,
        completedCells: [...scrapeState.completedCells],
        phase: scrapeState.phase,
        searchParams: durableSearchParams,
        cellSizeKm: scrapeState.cellSizeKm,
        viewportM: scrapeState.viewportM,
        gridPoints: scrapeState.gridPoints,
        mergedPlaces: Array.from(scrapeState.mergedPlaces.values()),
        retriedCells: [...(scrapeState._retriedCells || [])],
        mapsReopenCount: Number(scrapeState._mapsReopenCount || 0),
        mapsUserReloadCount: Number(scrapeState._mapsUserReloadCount || 0),
        webTabId: scrapeState.webTabId,
        mapsTabId: scrapeState.mapsTabId,
        mapsWindowId: scrapeState.mapsWindowId
      },
      activeSearch: durableSearchParams
    });
  } catch (err) {
    console.warn("persistScrapeCheckpoint:", err.message);
  }
}

function restoreScrapeStateFromCheckpoint(cp) {
  if (!cp?.searchParams) return false;
  scrapeState.searchParams = cp.searchParams;
  scrapeState.runId = String(cp.runId || cp.searchParams.searchId || "");
  scrapeState.cellGeneration = Number(cp.cellGeneration || 0);
  scrapeState.webTabId = cp.webTabId ?? null;
  scrapeState.mapsTabId = cp.mapsTabId ?? null;
  scrapeState.mapsWindowId = cp.mapsWindowId ?? null;
  scrapeState.gridPoints = cp.gridPoints || [];
  scrapeState.gridIndex = cp.gridIndex || 0;
  scrapeState.totalCells = cp.totalCells || 0;
  scrapeState.cellSizeKm = cp.cellSizeKm;
  scrapeState.viewportM = cp.viewportM;
  scrapeState.phase = cp.phase || "grid";
  scrapeState.completedCells = new Set(cp.completedCells || []);
  scrapeState.mergedPlaces = placesToMap(cp.mergedPlaces || []);
  scrapeState._retriedCells = new Set(cp.retriedCells || []);
  scrapeState._mapsReopenCount = Number(cp.mapsReopenCount || 0);
  scrapeState._mapsUserReloadCount = Number(cp.mapsUserReloadCount || 0);
  currentSearch = { ...cp.searchParams, gridCells: cp.totalCells };
  lastScrapeProgressAt = cp.lastProgressAt || cp.lastHeartbeat || Date.now();
  return true;
}

async function clearScrapeCheckpoint() {
  try {
    await chrome.storage.local.remove([SCRAPE_CHECKPOINT_KEY]);
  } catch {}
}

async function getScrapeCheckpoint() {
  const data = await chrome.storage.local.get(SCRAPE_CHECKPOINT_KEY);
  return data[SCRAPE_CHECKPOINT_KEY] || null;
}

async function maybeRecoverStalledScrape() {
  if (!scrapeState.running || isAborting || stallRecoveryBusy) return;
  const idleMs = Date.now() - (lastScrapeProgressAt || 0);
  if (idleMs < 120000) return;

  stallRecoveryBusy = true;
  try {
    const tabId = scrapeState.mapsTabId;
    if (!tabId) return;

    bgLog(`STALL WATCHDOG kích hoạt · idle ${Math.round(idleMs / 1000)}s · ô hiện tại ${scrapeState.gridIndex + 1}`);

    notifyProgress(
      calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.3),
      `Tiến độ chưa thay đổi trong ${Math.round(idleMs / 1000)} giây. Findmap đang kết nối lại với Google Maps…`
    );

    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    pingMapsTabWake(tabId);
    const ready = await ensureMapsContentReady(tabId);
    if (!ready) return;

    lastScrapeProgressAt = Date.now();
    if (idleMs >= 300000 && scrapeState.phase === "grid") {
      const idx = scrapeState.gridIndex;
      // Thử lại vùng 1 lần trước khi bỏ qua — tránh mất cả cụm kết quả
      if (!scrapeState._retriedCells) scrapeState._retriedCells = new Set();
      if (!scrapeState._retriedCells.has(idx) && !scrapeState.completedCells.has(idx)) {
        scrapeState._retriedCells.add(idx);
        notifyPopup(`Khu vực ${idx + 1} chưa phản hồi. Findmap đang thử lại…`);
        const staleLease = getActiveCellLease();
        if (staleLease) {
          await chrome.tabs
            .sendMessage(tabId, { action: "SCRAPE_ABORT", data: staleLease })
            .catch(() => {});
        }
        await runGridCell(idx);
        return;
      }
      if (!scrapeState.completedCells.has(idx)) {
        scrapeState.completedCells.add(idx);
        notifyPopup(`Khu vực ${idx + 1} không phản hồi sau khi thử lại. Findmap sẽ chuyển sang khu vực tiếp theo.`);
      }
      const next = idx + 1;
      if (next < scrapeState.totalCells) {
        scrapeState.gridIndex = next;
        await runGridCell(next);
      } else if (scrapeState.mergedPlaces.size > 0) {
        await handleScrapeComplete({
          searchParams: scrapeState.searchParams,
          partial: true,
          partialReason: "Một số khu vực không phản hồi nên lượt tìm kiếm kết thúc sớm"
        });
      }
    }
  } finally {
    stallRecoveryBusy = false;
  }
}

async function tryResumeFromCheckpoint({ allowReopen = false } = {}) {
  const cp = await getScrapeCheckpoint();
  if (!DurableLifecycle.isRecoverableScrapeCheckpoint(cp) || scrapeState.running) return false;

  restoreScrapeStateFromCheckpoint(cp);
  scrapeState.running = true;
  startScrapeKeepAlive();

  let mapsAlive = false;
  if (cp.mapsTabId) {
    try {
      await chrome.tabs.get(cp.mapsTabId);
      mapsAlive = true;
    } catch {
      scrapeState.mapsTabId = null;
    }
  }

  if (!mapsAlive) {
    const canReopen = allowReopen || isMapsAutoReopenEnabled(scrapeState.searchParams);
    if (canReopen) {
      const reopened = await reopenMapsTabForSearch();
      if (reopened) return true;
    }
    scrapeState.running = false;
    stopScrapeKeepAlive();
    await ensureDurableWorkAlarm();
    return false;
  }

  const next = DurableLifecycle.nextPendingCell(cp);
  if (next >= cp.totalCells) {
    if (scrapeState.mergedPlaces.size > 0) {
      await handleScrapeComplete({
        searchParams: scrapeState.searchParams,
        partial: true,
        partialReason: "Findmap đã khôi phục phiên quét sau khi các khu vực hoàn tất"
      });
      return true;
    }
    scrapeState.running = false;
    stopScrapeKeepAlive();
    return false;
  }

  scrapeState.gridIndex = next;
  await ensureMapsBoost(scrapeState.mapsTabId).catch(() => false);
  notifyPopup(`Tiếp tục tìm kiếm từ khu vực ${next + 1}/${cp.totalCells}…`);
  runGridCell(next).catch(async (err) => {
    if (scrapeState.running || scrapeState.mergedPlaces.size > 0) {
      await abortSearch("RECOVER_FAILED", err?.message || String(err));
    }
  });
  return true;
}

async function finalizeFromCheckpoint(reason) {
  const cp = await getScrapeCheckpoint();
  if (!cp) return { success: false, error: "Không có tìm kiếm để kết thúc" };

  restoreScrapeStateFromCheckpoint(cp);
  scrapeState.running = false;
  scrapeState.runId = "";
  disableMapsBoost().catch(() => {});

  if (scrapeState.mapsTabId) {
    try {
      await chrome.tabs.sendMessage(scrapeState.mapsTabId, {
        action: "SCRAPE_ABORT",
        data: getActiveCellLease()
      });
    } catch {}
  }

  if (scrapeState.mergedPlaces.size > 0) {
    const count = scrapeState.mergedPlaces.size;
    await handleScrapeComplete({
      searchParams: scrapeState.searchParams,
      partial: true,
      partialReason: reason || "Dừng tìm kiếm — lưu kết quả đã tìm"
    });
    return { success: true, charged: true, count };
  }

  try {
    if (scrapeState.searchParams?.webUrl) {
      await sendToWebPage(scrapeState.searchParams.webUrl, "error", {
        error: reason || "Tìm kiếm đã dừng",
        partial: false
      });
    }
  } finally {
    await closeMapsTabSafely();
    resetScrapeState();
  }
  return { success: true, charged: false, count: 0 };
}

async function abortSearch(code, message, { chargePartial = true } = {}) {
  if (isAborting) return;
  const hasWork =
    scrapeState.running ||
    scrapeState.mergedPlaces.size > 0 ||
    scrapeState.searchParams;
  if (!hasWork) return;

  isAborting = true;
  scrapeState.running = false;
  // Ngừng quét là hết cần chế độ quét nền — gỡ debugger ngay, không đợi sync cuối.
  disableMapsBoost().catch(() => {});

  try {
    if (scrapeState.mapsTabId) {
      try {
        await chrome.tabs.sendMessage(scrapeState.mapsTabId, { action: "SCRAPE_ABORT" });
      } catch {}
    }

    notifyPopup(message);

    const hasResults = scrapeState.mergedPlaces.size > 0;
    if (chargePartial && hasResults && scrapeState.searchParams && !pointsFinalized) {
      await handleScrapeComplete({
        searchParams: scrapeState.searchParams,
        partial: true,
        partialReason: message,
        partialCode: code
      });
    } else if (scrapeState.searchParams?.webUrl) {
      await sendToWebPage(scrapeState.searchParams.webUrl, "error", {
        error: message,
        code,
        partial: !!hasResults
      });
      await closeMapsTabSafely();
      resetScrapeState();
    } else {
      resetScrapeState();
    }
  } catch (err) {
    // Sync cuối lỗi giữa chừng cũng không được để tab/debugger kẹt lại.
    console.warn("abortSearch:", err?.message || err);
    await closeMapsTabSafely();
    resetScrapeState();
  } finally {
    isAborting = false;
  }
}

async function cancelActiveSearch(reason) {
  if (scrapeState.running || scrapeState.searchParams) {
    await abortSearch("USER_CANCEL", reason || "Người dùng dừng tìm kiếm", { chargePartial: true });
    return { success: true };
  }
  return finalizeFromCheckpoint(reason || "Người dùng dừng tìm kiếm");
}

async function abandonActiveSearch() {
  if (scrapeState.running || scrapeState.searchParams) {
    scrapeState.running = false;
    disableMapsBoost().catch(() => {});
    if (scrapeState.mapsTabId) {
      try {
        await chrome.tabs.sendMessage(scrapeState.mapsTabId, {
          action: "SCRAPE_ABORT",
          data: getActiveCellLease()
        });
      } catch {}
    }
    await closeMapsTabSafely();
    resetScrapeState();
    return { success: true };
  }

  const cp = await getScrapeCheckpoint();
  if (cp?.mapsTabId) {
    try {
      await chrome.tabs.remove(cp.mapsTabId);
    } catch {}
  }
  await clearScrapeCheckpoint();
  try {
    await chrome.storage.local.remove(["activeSearch", "pendingComplete"]);
  } catch {}
  return { success: true };
}

async function ensureReadyForNewSearch() {
  if (scrapeState.running) {
    throw new Error("Đang có tìm kiếm chạy. Bấm 'Dừng quét điểm bán' hoặc đợi hoàn tất.");
  }

  // Đóng tab Maps còn sót (tránh mở nhiều tab khi tìm tuần tự nhiều từ khóa)
  if (scrapeState.mapsTabId) {
    await closeMapsTabSafely();
  }

  const cp = await getScrapeCheckpoint();
  if (cp?.mapsTabId) {
    try {
      await chrome.tabs.get(cp.mapsTabId);
      await chrome.tabs.remove(cp.mapsTabId).catch(() => {});
    } catch {}
  }

  if (!cp?.running) {
    if (cp && !scrapeState.searchParams) {
      await clearScrapeCheckpoint();
    }
    try {
      await chrome.storage.local.remove(["activeSearch", "pendingComplete", PENDING_SYNC_KEY]);
    } catch {}
    return;
  }

  // Checkpoint còn "running" nhưng Maps đã chết → dọn sạch, cho phép tìm tiếp
  await clearScrapeCheckpoint();
  try {
    await chrome.storage.local.remove(["activeSearch", "pendingComplete", PENDING_SYNC_KEY]);
  } catch {}
}

async function pushSearchSyncToWeb(reason) {
  if (!scrapeState.searchParams?.webUrl) {
    const cp = await getScrapeCheckpoint();
    if (cp?.searchParams) restoreScrapeStateFromCheckpoint(cp);
  }
  if (!scrapeState.searchParams?.webUrl) return false;

  return ensureWebSyncedToResults(
    reason || `Đang đồng bộ ${scrapeState.mergedPlaces.size} điểm bán về Findmap`,
    true
  );
}

async function getSearchStatus() {
  const cp = await getScrapeCheckpoint();
  const running = scrapeState.running;
  const checkpointRunning = !!cp?.running;
  const mergedCount =
    getFinalResultsList().length || (cp?.mergedPlaces?.length ?? 0);
  const totalCells = scrapeState.totalCells || cp?.totalCells || 0;
  const gridIndex = scrapeState.gridIndex ?? cp?.gridIndex ?? 0;
  const lastBeat = cp?.lastHeartbeat || 0;

  // Checkpoint có mapsTabId ≠ tab còn sống — kiểm tra trước khi báo bận
  let liveMapsTabId = scrapeState.mapsTabId || null;
  if (!liveMapsTabId && cp?.mapsTabId) {
    try {
      await chrome.tabs.get(cp.mapsTabId);
      liveMapsTabId = cp.mapsTabId;
    } catch {
      liveMapsTabId = null;
    }
  } else if (liveMapsTabId) {
    try {
      await chrome.tabs.get(liveMapsTabId);
    } catch {
      liveMapsTabId = null;
      scrapeState.mapsTabId = null;
    }
  }

  const checkpointBusy = checkpointRunning && (!!liveMapsTabId || Date.now() - lastBeat < 120000);
  const stalled =
    !running &&
    checkpointRunning &&
    mergedCount > 0 &&
    Date.now() - lastBeat > 60000;

  return {
    // Không OR checkpoint mồ côi (tab Maps đã đóng) — để chuỗi nhiều từ khóa chạy tiếp
    running: running || checkpointBusy,
    stalled,
    phase: scrapeState.phase || cp?.phase || "grid",
    gridIndex,
    totalCells,
    mergedCount,
    searchId: scrapeState.searchParams?.searchId || cp?.searchParams?.searchId || null,
    mapsTabId: liveMapsTabId,
    lastHeartbeat: lastBeat,
    lastProgressAt: lastScrapeProgressAt || cp?.lastProgressAt || lastBeat,
    canCancel: running || checkpointBusy || mergedCount > 0,
    canResume: !running && DurableLifecycle.isRecoverableScrapeCheckpoint(cp),
    mapsAutoFocus: scrapeState.searchParams?.mapsAutoFocus === true || cp?.searchParams?.mapsAutoFocus === true,
    mapsAutoReopen:
      scrapeState.searchParams?.mapsAutoReopen === true || cp?.searchParams?.mapsAutoReopen === true
  };
}

async function resetScrapeState() {
  stopScrapeKeepAlive();
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
  scrapeState.running = false;
  scrapeState.runId = "";
  scrapeState.mapsTabId = null;
  scrapeState.mapsWindowId = null;
  scrapeState.webTabId = null;
  scrapeState.searchParams = null;
  scrapeState.gridPoints = [];
  scrapeState.gridIndex = 0;
  scrapeState.totalCells = 0;
  scrapeState.mergedPlaces = new Map();
  scrapeState.completedCells = new Set();
  scrapeState.phase = "grid";
  scrapeState.cellGeneration = 0;
  scrapeState._retriedCells = new Set();
  scrapeState._mapsReopenCount = 0;
  scrapeState._mapsUserReloadCount = 0;
  scrapeState._mapsCellWorkActive = false;
  scrapeState._programmaticMapsNavUntil = 0;
  scrapeState._expectMapsNavigation = false;
  mapsCellWorkDepth = 0;
  mapsTabInactiveSince = 0;
  scrapeState._bgWarnSent = false;
  currentSearch = null;
  pointsFinalized = false;
  lastScrapeProgressAt = 0;
  stallRecoveryBusy = false;
  mapsReloadRecoverBusy = false;
  if (mapsReloadTimer) {
    clearTimeout(mapsReloadTimer);
    mapsReloadTimer = null;
  }
  try {
    await chrome.storage.local.remove(["activeSearch"]);
  } catch {}
  await clearPendingSearchSync().catch(() => {});
  // Await xóa checkpoint — tránh web nghĩ vẫn đang chạy rồi không sang từ khóa tiếp
  await clearScrapeCheckpoint().catch(() => {});
  maybeReleaseMapsBoost();
  await clearDurableWorkAlarmIfIdle();
}

function isMapsAutoReopenEnabled(params) {
  return params?.mapsAutoReopen === true;
}

function isRescanAutoReopenEnabled() {
  return (
    rescanState.mapsAutoReopen === true ||
    rescanState.params?.mapsAutoReopen === true ||
    rescanState.searchParams?.mapsAutoReopen === true
  );
}

async function reopenMapsTabForSearch() {
  if (!scrapeState.running || !scrapeState.searchParams) return false;

  const idx = scrapeState.gridIndex;
  const cell = scrapeState.gridPoints[idx];
  if (!cell) return false;

  const params = scrapeState.searchParams;
  const url = buildMapsUrl(params.keyword, cell.lat, cell.lng, scrapeState.viewportM);

  scrapeState._expectMapsNavigation = true;
  markMapsControlledActivity(120000);
  let tab;
  try {
    tab = await openMapsScrapeTab(url);
  } catch (err) {
    console.warn("reopenMapsTabForSearch:", err.message);
    return false;
  } finally {
    scrapeState._expectMapsNavigation = false;
  }

  scrapeState.mapsTabId = tab.id;
  scrapeState.mapsWindowId = tab.windowId;
  // Giữ nguyên focus theo openMapsScrapeTab — không ép active:true
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitTabComplete(tab.id);
  await sleep(1200);

  const ready = await ensureMapsContentReady(tab.id);
  if (!ready) return false;

  lastScrapeProgressAt = Date.now();
  notifyProgress(
    calcProgressPercent(idx, scrapeState.totalCells, 0.2),
    `Đã mở lại Google Maps · Tiếp tục khu vực ${idx + 1}/${scrapeState.totalCells}`
  );

  const resumeAt = scrapeState.completedCells.has(idx) ? idx + 1 : idx;
  if (resumeAt >= scrapeState.totalCells) {
    if (scrapeState.mergedPlaces.size > 0) {
      await handleScrapeComplete({
        searchParams: scrapeState.searchParams,
        partial: true,
        partialReason: "Tab Maps bị đóng sau khi quét xong các vùng"
      });
    }
    return true;
  }

  scrapeState.cellGeneration = (scrapeState.cellGeneration || 0) + 1;
  runGridCell(resumeAt).catch(async (err) => {
    if ((scrapeState.running || scrapeState.mergedPlaces.size > 0) && !pointsFinalized) {
      await abortSearch("RECOVER_FAILED", err?.message || String(err), { chargePartial: true });
    }
  });
  return true;
}

async function handleSearchMapsTabLost() {
  if (mapsTabLossBusy || isAborting || !scrapeState.running) return;
  if (scrapeState.mapsTabId == null) return;

  mapsTabLossBusy = true;
  scrapeState.mapsTabId = null;
  scrapeState.mapsWindowId = null;
  await persistScrapeCheckpoint();

  try {
    const params = scrapeState.searchParams;
    if (isMapsAutoReopenEnabled(params)) {
      const count = (scrapeState._mapsReopenCount || 0) + 1;
      scrapeState._mapsReopenCount = count;
      const maxReopen = getMapsAutoReopenMax();
      if (count > maxReopen) {
        await abortSearch(
          "MAPS_REOPEN_LIMIT",
          `Tab Google Maps bị đóng quá nhiều lần (${maxReopen}) — lưu kết quả đã tìm.`,
          { chargePartial: true }
        );
        return;
      }
      notifyProgress(
        calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.1),
        `Tab Google Maps đã bị đóng. Đang mở lại · Lần ${count}/${maxReopen}…`
      );
      const ok = await reopenMapsTabForSearch();
      if (!ok) {
        await abortSearch(
          "MAPS_REOPEN_FAILED",
          "Tab Google Maps đã bị đóng — không mở lại được. Lưu kết quả đã tìm.",
          { chargePartial: true }
        );
      }
    } else {
      await abortSearch(
        "TAB_MAPS_CLOSED",
        "Tab Google Maps đã bị đóng. Kết quả đã tìm được lưu lại.",
        { chargePartial: true }
      );
    }
  } finally {
    mapsTabLossBusy = false;
  }
}

async function persistRescanCheckpoint() {
  if (!rescanState.running || !Array.isArray(rescanState.places) || !rescanState.places.length) return;
  const now = Date.now();
  const durableParams = { ...(rescanState.params || {}) };
  delete durableParams.authToken;
  delete durableParams.places;
  try {
    await chrome.storage.local.set({
      [RESCAN_CHECKPOINT_KEY]: {
        version: DurableLifecycle.CHECKPOINT_VERSION,
        running: true,
        savedAt: now,
        lastHeartbeat: now,
        webUrl: rescanState.webUrl,
        done: rescanState.done,
        total: rescanState.total,
        placeIndex: rescanState.placeIndex,
        places: rescanState.places,
        params: durableParams,
        searchParams: toDurableSearchParams(rescanState.searchParams),
        mapsAutoReopen: isRescanAutoReopenEnabled(),
        reopenCount: Number(rescanState._reopenCount || 0),
        mapsTabId: rescanState.mapsTabId,
        mapsWindowId: rescanState.mapsWindowId
      }
    });
    await ensureDurableWorkAlarm();
  } catch (err) {
    console.warn("persistRescanCheckpoint:", err?.message || err);
  }
}

async function getRescanCheckpoint() {
  const data = await chrome.storage.local.get(RESCAN_CHECKPOINT_KEY);
  return data[RESCAN_CHECKPOINT_KEY] || null;
}

async function clearRescanCheckpoint() {
  try {
    await chrome.storage.local.remove(RESCAN_CHECKPOINT_KEY);
  } catch {}
}

function restoreRescanStateFromCheckpoint(checkpoint) {
  if (!DurableLifecycle.isRecoverableRescanCheckpoint(checkpoint)) return false;
  rescanState.running = true;
  rescanState.webUrl = checkpoint.webUrl;
  rescanState.done = Number(checkpoint.done || 0);
  rescanState.total = Number(checkpoint.total || checkpoint.places.length);
  rescanState.placeIndex = Number(checkpoint.placeIndex || 0);
  rescanState.places = checkpoint.places;
  rescanState.params = checkpoint.params || {};
  rescanState.searchParams = checkpoint.searchParams || {};
  rescanState.mapsAutoReopen = checkpoint.mapsAutoReopen === true;
  rescanState._reopenCount = Number(checkpoint.reopenCount || 0);
  rescanState.mapsTabId = checkpoint.mapsTabId ?? null;
  rescanState.mapsWindowId = checkpoint.mapsWindowId ?? null;
  return true;
}

async function tryResumeRescanFromCheckpoint({ allowReopen = false } = {}) {
  if (scrapeState.running || rescanState.running) return false;
  const checkpoint = await getRescanCheckpoint();
  if (!restoreRescanStateFromCheckpoint(checkpoint)) return false;

  await ensureDurableWorkAlarm();
  let mapsAlive = false;
  if (rescanState.mapsTabId) {
    try {
      await chrome.tabs.get(rescanState.mapsTabId);
      mapsAlive = true;
    } catch {
      rescanState.mapsTabId = null;
      rescanState.mapsWindowId = null;
    }
  }

  if (!mapsAlive && (allowReopen || isRescanAutoReopenEnabled())) {
    mapsAlive = await openRescanMapsTab();
  }
  if (!mapsAlive) {
    rescanState.running = false;
    await ensureDurableWorkAlarm();
    return false;
  }

  await ensureMapsBoost(rescanState.mapsTabId).catch(() => false);
  await sendToWebPage(rescanState.webUrl, "rescan_progress", {
    done: rescanState.done,
    total: rescanState.total,
    percent: rescanState.total ? Math.round((rescanState.done / rescanState.total) * 100) : 0,
    name: "",
    info: "Findmap đã khôi phục phiên quét lại sau khi Chrome đánh thức tiện ích."
  }).catch(() => {});

  runRescanPlacesLoop()
    .then(() => finishRescanNormal())
    .catch((err) => abortRescan(err?.message || "Không khôi phục được quét lại", "RESCAN_RECOVER_FAILED"));
  return true;
}

function resetRescanState() {
  rescanState.running = false;
  rescanState.mapsTabId = null;
  rescanState.mapsWindowId = null;
  rescanState.webUrl = null;
  rescanState.done = 0;
  rescanState.total = 0;
  rescanState.placeIndex = 0;
  rescanState.places = null;
  rescanState.params = null;
  rescanState.searchParams = null;
  rescanState.mapsAutoReopen = false;
  rescanState._reopenCount = 0;
  rescanState._handlingTabLoss = false;
  rescanState._awaitingReopen = false;
  maybeReleaseMapsBoost();
}

async function abortRescan(message, code = "TAB_MAPS_CLOSED") {
  if (!rescanState.running && !rescanState.webUrl) return;
  const webUrl = rescanState.webUrl;
  const done = rescanState.done;
  const total = rescanState.total;
  rescanState.running = false;

  if (rescanState.mapsTabId) {
    try {
      await chrome.tabs.remove(rescanState.mapsTabId);
    } catch {}
  }

  if (webUrl) {
    await sendToWebPage(webUrl, "rescan_complete", {
      done,
      total,
      error: message,
      code,
      partial: done > 0
    }).catch(() => {});
  }
  await clearRescanCheckpoint();
  resetRescanState();
  await clearDurableWorkAlarmIfIdle();
}

async function openRescanMapsTab() {
  const webTab = await findWebTab(rescanState.webUrl).catch(() => null);
  const tab = await createMapsTab(
    "https://www.google.com/maps/",
    isValidWindowId(webTab?.windowId) ? webTab.windowId : null,
    { active: false }
  );
  rescanState.mapsTabId = tab.id;
  rescanState.mapsWindowId = tab.windowId;
  const boosted = await enableMapsBoost(tab.id);
  if (!boosted) await activateTabAndWindow(tab.id);
  await waitTabComplete(tab.id);
  await sleep(800);
  const ready = await ensureMapsContentReady(tab.id);
  await persistRescanCheckpoint();
  return ready;
}

async function handleRescanMapsTabLost() {
  if (rescanState._handlingTabLoss || !rescanState.running) return;
  if (rescanState.mapsTabId == null) return;

  rescanState._handlingTabLoss = true;
  rescanState.mapsTabId = null;
  rescanState.mapsWindowId = null;
  await persistRescanCheckpoint();

  try {
    if (isRescanAutoReopenEnabled()) {
      const count = (rescanState._reopenCount || 0) + 1;
      rescanState._reopenCount = count;
      const maxReopen = getMapsAutoReopenMax();
      if (count > maxReopen) {
        await abortRescan(
          `Tab Google Maps bị đóng quá nhiều lần (${maxReopen}) — dừng quét lại (${rescanState.done}/${rescanState.total} xong).`,
          "MAPS_REOPEN_LIMIT"
        );
        return;
      }
      await sendToWebPage(rescanState.webUrl, "rescan_progress", {
        done: rescanState.done,
        total: rescanState.total,
        percent: rescanState.total
          ? Math.round((rescanState.done / rescanState.total) * 100)
          : 0,
        name: "",
        info: `Tab Google Maps đã bị đóng. Đang mở lại · Lần ${count}/${maxReopen}…`
      }).catch(() => {});
      const ok = await openRescanMapsTab();
      if (!ok) {
        await abortRescan(
          "Tab Google Maps đã bị đóng — không mở lại được. Quét lại dừng — giữ kết quả đã cập nhật.",
          "MAPS_REOPEN_FAILED"
        );
        return;
      }
      rescanState._awaitingReopen = true;
      await persistRescanCheckpoint();
      await sendToWebPage(rescanState.webUrl, "rescan_progress", {
        done: rescanState.done,
        total: rescanState.total,
        percent: rescanState.total
          ? Math.round((rescanState.done / rescanState.total) * 100)
          : 0,
        name: "",
        info: "Đã mở lại Google Maps. Findmap đang tiếp tục bổ sung thông tin."
      }).catch(() => {});
    } else {
      await abortRescan(
        "Tab Google Maps đã bị đóng. Quét lại dừng — giữ kết quả đã cập nhật.",
        "TAB_MAPS_CLOSED"
      );
    }
  } finally {
    rescanState._handlingTabLoss = false;
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (scrapeState.running && windowId === scrapeState.mapsWindowId && scrapeState.mapsTabId != null) {
    handleSearchMapsTabLost().catch((err) => console.warn("handleSearchMapsTabLost:", err.message));
    return;
  }
  if (rescanState.running && windowId === rescanState.mapsWindowId && rescanState.mapsTabId != null) {
    handleRescanMapsTabLost().catch((err) => console.warn("handleRescanMapsTabLost:", err.message));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (scrapeState.running && tabId === scrapeState.mapsTabId) {
    handleSearchMapsTabLost().catch((err) => console.warn("handleSearchMapsTabLost:", err.message));
    return;
  }
  if (rescanState.running && tabId === rescanState.mapsTabId) {
    handleRescanMapsTabLost().catch((err) => console.warn("handleRescanMapsTabLost:", err.message));
    return;
  }
  if (scrapeState.running && tabId === scrapeState.webTabId) {
    abortSearch(
      "TAB_WEB_CLOSED",
      "Trang kết quả đã bị tắt. Kết quả đã tìm được lưu lại.",
      { chargePartial: true }
    );
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!scrapeState.running || !scrapeState.searchParams?.webUrl) return;
  const tabId = activeInfo.tabId;
  if (tabId === scrapeState.mapsTabId) {
    ensureWebSyncedToResults("Đồng bộ khi quay lại tab Maps", true).catch(() => {});
  } else if (tabId === scrapeState.webTabId) {
    ensureWebSyncedToResults("Đồng bộ khi quay lại tab kết quả", true).catch(() => {});
  }
});

function markMapsControlledActivity(extraMs = 120000) {
  const until = Date.now() + extraMs;
  scrapeState._programmaticMapsNavUntil = Math.max(scrapeState._programmaticMapsNavUntil || 0, until);
}

function beginMapsCellWork(extraMs = 15 * 60 * 1000) {
  mapsCellWorkDepth += 1;
  scrapeState._mapsCellWorkActive = true;
  markMapsControlledActivity(extraMs);
}

function endMapsCellWork() {
  mapsCellWorkDepth = Math.max(0, mapsCellWorkDepth - 1);
  scrapeState._mapsCellWorkActive = mapsCellWorkDepth > 0;
}

function isMapsLoadingExpected() {
  if (scrapeState._expectMapsNavigation) return true;
  if (scrapeState._mapsCellWorkActive) return true;
  if (Date.now() < (scrapeState._programmaticMapsNavUntil || 0)) return true;
  if (Date.now() - (lastScrapeProgressAt || 0) < 45000) return true;
  return false;
}
function scheduleMapsReloadRecovery() {
  if (isMapsLoadingExpected()) return;
  if (mapsReloadTimer) clearTimeout(mapsReloadTimer);
  mapsReloadTimer = setTimeout(() => {
    mapsReloadTimer = null;
    if (isMapsLoadingExpected()) return;
    handleMapsTabReloaded().catch((err) => console.warn("handleMapsTabReloaded:", err.message));
  }, 900);
}

async function navigateMapsTab(updates, waitComplete = true) {
  scrapeState._expectMapsNavigation = true;
  markMapsControlledActivity(120000);
  try {
    await chrome.tabs.update(scrapeState.mapsTabId, updates);
    if (waitComplete && updates.url) {
      await waitTabComplete(scrapeState.mapsTabId);
      await sleep(400);
    }
  } finally {
    scrapeState._expectMapsNavigation = false;
  }
  // Điều hướng có thể đổi process của tab → phát lại lệnh giữ tab nền hoạt động
  ensureMapsBoost(scrapeState.mapsTabId).catch(() => {});
}

async function handleMapsTabReloaded() {
  if (!scrapeState.running || isAborting || mapsReloadRecoverBusy || pointsFinalized) return;
  if (isMapsLoadingExpected()) return;
  mapsReloadRecoverBusy = true;
  try {
    scrapeState.cellGeneration = (scrapeState.cellGeneration || 0) + 1;
    scrapeState._mapsUserReloadCount = (scrapeState._mapsUserReloadCount || 0) + 1;

    const idleMs = Date.now() - (lastScrapeProgressAt || 0);
    const hasResults = scrapeState.mergedPlaces.size > 0;
    const reloadCount = scrapeState._mapsUserReloadCount;

    notifyProgress(
      calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.2),
      `Tab Google Maps vừa được tải lại · Lần ${reloadCount}. Findmap đang khôi phục tiến trình…`
    );

    // Tiến trình đã treo + đã có kết quả → coi như dừng, trừ điểm ngay
    if (hasResults && idleMs >= 60000) {
      await abortSearch(
        "MAPS_RELOAD_IDLE",
        "Tab Google Maps được tải lại khi tiến trình không phản hồi. Findmap sẽ kết thúc và giữ kết quả đã có.",
        { chargePartial: true }
      );
      return;
    }

    if (reloadCount >= 3 && hasResults) {
      await abortSearch(
        "MAPS_RELOAD_STOP",
        "Tab Google Maps đã được tải lại nhiều lần. Findmap sẽ kết thúc và giữ kết quả đã có.",
        { chargePartial: true }
      );
      return;
    }

    await sleep(1200);
    const ready = await ensureMapsContentReady(scrapeState.mapsTabId);
    if (!ready) {
      await abortSearch(
        "MAPS_RELOAD_FAILED",
        "Không kết nối lại được sau khi tab Google Maps tải lại. Findmap sẽ kết thúc và giữ kết quả đã có.",
        { chargePartial: true }
      );
      return;
    }

    lastScrapeProgressAt = Date.now();
    notifyPopup(
      `Đã kết nối lại Google Maps · Tiếp tục khu vực ${scrapeState.gridIndex + 1}/${scrapeState.totalCells}`
    );

    const idx = scrapeState.gridIndex;
    const resumeAt = scrapeState.completedCells.has(idx) ? idx + 1 : idx;
    if (resumeAt >= scrapeState.totalCells) {
      if (hasResults) {
        await handleScrapeComplete({
          searchParams: scrapeState.searchParams,
          partial: true,
          partialReason: "Tab Google Maps được tải lại sau khi các khu vực đã hoàn tất"
        });
      }
      return;
    }

    runGridCell(resumeAt).catch(async (err) => {
      if ((scrapeState.running || hasResults) && !pointsFinalized) {
        await abortSearch("RECOVER_FAILED", err?.message || String(err), { chargePartial: true });
      }
    });
  } finally {
    mapsReloadRecoverBusy = false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!scrapeState.running || tabId !== scrapeState.mapsTabId) return;
  if (changeInfo.status !== "loading") return;
  if (isMapsLoadingExpected()) return;
  scheduleMapsReloadRecovery();
});

const REQUIRED_CONTENT_VERSION = 59;

async function ensureMapsContentReady(tabId) {
  if (
    (scrapeState.running && tabId === scrapeState.mapsTabId) ||
    (rescanState.running && tabId === rescanState.mapsTabId)
  ) {
    ensureMapsBoost(tabId).catch(() => {});
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: "PING" });
      if (pong?.ok && Number(pong.v || 0) >= REQUIRED_CONTENT_VERSION) return true;

      // Bản cũ: reload tab để content_scripts load lại sạch (tránh listener trùng)
      if (pong?.ok && Number(pong.v || 0) < REQUIRED_CONTENT_VERSION && attempt === 0) {
        try {
          markMapsControlledActivity(45000);
          await chrome.tabs.reload(tabId);
          await waitTabComplete(tabId, 25000);
          await sleep(900);
        } catch {}
      }
    } catch {}

    try {
      // Xóa cờ trong isolated world (cùng world với content.js) — không dùng MAIN
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            delete window.__timDiemBanLoaded;
            delete window.__timDiemBanVersion;
          } catch {}
        }
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["run-lease.js", "place-fields.js", "grid.js", "content.js"]
      });
    } catch {}
    await sleep(500 + attempt * 150);
  }
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: "PING" });
    return !!pong?.ok;
  } catch {
    return false;
  }
}

async function sendMapsMessage(action, data) {
  const tabId = scrapeState.mapsTabId;
  if (!tabId) throw new Error("Không tìm thấy tab Google Maps đang dùng để quét.");

  const ready = await ensureMapsContentReady(tabId);
  if (!ready) throw new Error("Không kết nối được với Google Maps. Hãy tải lại tab Google Maps rồi thử lại.");

  try {
    return await chrome.tabs.sendMessage(tabId, { action, data });
  } catch (err) {
    await ensureMapsContentReady(tabId);
    return await chrome.tabs.sendMessage(tabId, { action, data });
  }
}

async function sendMapsMessageWithTimeout(action, data, timeoutMs = 75000) {
  let timer;
  try {
    return await Promise.race([
      sendMapsMessage(action, data),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Google Maps chưa phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runGridCell(cellIndex) {
  if (!scrapeState.running) return;

  const cellGen = ++scrapeState.cellGeneration;
  const lease = { runId: scrapeState.runId, cellGeneration: cellGen };

  if (cellIndex >= scrapeState.totalCells) {
    return;
  }

  if (scrapeState.completedCells.has(cellIndex)) {
    const next = cellIndex + 1;
    if (next < scrapeState.totalCells) {
      scrapeState.gridIndex = next;
      await runGridCell(next);
    }
    return;
  }

  const params = scrapeState.searchParams;
  const cell = scrapeState.gridPoints[cellIndex];
  const url = buildMapsUrl(params.keyword, cell.lat, cell.lng, scrapeState.viewportM);
  const globalSeen = buildGlobalSeenKeys(Array.from(scrapeState.mergedPlaces.values()));

  if (cellIndex === 0) {
    notifyProgress(
      3,
      buildProgressText(cell, cellIndex, scrapeState.totalCells, {
        action: "Đang mở Google Maps…"
      })
    );
    let tab;
    try {
      tab = await openMapsScrapeTab(url);
    } catch (err) {
      throw new Error(`Không mở được Google Maps. ${err.message}`);
    }
    scrapeState.mapsTabId = tab.id;
    markMapsControlledActivity(120000);
    await chrome.tabs.update(scrapeState.mapsTabId, { autoDiscardable: false }).catch(() => {});
    await waitTabComplete(scrapeState.mapsTabId);
    await sleep(1200);
    const ready = await ensureMapsContentReady(scrapeState.mapsTabId);
    if (!ready) {
      throw new Error("Không kết nối được với Google Maps. Hãy tải lại tab Google Maps rồi thử lại.");
    }
    notifyProgress(
      5,
      buildProgressText(cell, cellIndex, scrapeState.totalCells, {
        action: "Đang tải danh sách điểm bán…"
      })
    );
  } else {
    notifyProgress(
      calcProgressPercent(cellIndex, scrapeState.totalCells),
      buildProgressText(cell, cellIndex, scrapeState.totalCells, {
        action: "Đang chuyển sang khu vực tiếp theo…"
      })
    );
    await navigateMapsTab({ url });
    await sleep(1100);
  }

  if (!scrapeState.running || cellGen !== scrapeState.cellGeneration) return;

  let result;
  const cellStartedAt = Date.now();
  const cellElapsed = () => Math.round((Date.now() - cellStartedAt) / 1000);
  bgLog(`Ô ${cellIndex + 1}/${scrapeState.totalCells} bắt đầu · budget ${CELL_SCRAPE_TIMEOUT_MS / 1000}s`);
  beginMapsCellWork();
  try {
    result = await sendMapsMessageWithTimeout(
      "SCRAPE_CELL_LIST",
      {
        searchParams: params,
        ...lease,
        cellIndex,
        totalCells: scrapeState.totalCells,
        cellLat: cell.lat,
        cellLng: cell.lng,
        cellId: cell.cellId,
        cellLabel: cell.cellLabel,
        searchUrl: url,
        globalSeen,
        navigateInPage: false
      },
      CELL_SCRAPE_TIMEOUT_MS
    );
    bgLog(
      `Ô ${cellIndex + 1} content trả về sau ${cellElapsed()}s · ${result?.places?.length || 0} điểm · ` +
        `clickAttempts=${result?.clickAttempts || 0} skipped=${result?.skippedCount || 0}`
    );
  } catch (err) {
    bgLog(`Ô ${cellIndex + 1} THOÁT DO TIMEOUT/LỖI sau ${cellElapsed()}s: ${err.message}`);
    notifyPopup(`Khu vực ${cellIndex + 1} gặp sự cố: ${err.message}`);
    notifyProgress(
      calcProgressPercent(cellIndex, scrapeState.totalCells),
      `Khu vực ${cellIndex + 1} gặp sự cố: ${err.message}`
    );
    result = { success: false, places: [], skippedCount: 0, clickAttempts: 0, ...lease };
    await chrome.tabs
      .sendMessage(scrapeState.mapsTabId, { action: "SCRAPE_ABORT", data: lease })
      .catch(() => {});
  } finally {
    endMapsCellWork();
  }

  if (!scrapeState.running || cellGen !== scrapeState.cellGeneration) return;

  if (!RunLease.same(lease, result)) {
    notifyPopup(`Đã bỏ qua dữ liệu cũ của khu vực ${cellIndex + 1}.`);
    return;
  }

  const stampedPlaces = (result?.places || []).map((p) => ({
    ...p,
    _enrichCellIndex: cellIndex,
    _enrichCellLat: cell.lat,
    _enrichCellLng: cell.lng,
    _enrichSearchUrl: url
  }));

  await handleCellListComplete({
    places: stampedPlaces,
    skippedCount: result?.skippedCount || 0,
    clickAttempts: result?.clickAttempts || 0,
    cellIndex,
    totalCells: scrapeState.totalCells
  });
}

function groupPlacesByEnrichCell(places) {
  const groups = new Map();
  for (const p of places) {
    const idx = Number.isFinite(p._enrichCellIndex) ? p._enrichCellIndex : 0;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

async function enrichPlaceByUrl(place, params, progressText, pct, profile) {
  const href = (place.href || place.mapsUrl || "").split("#")[0];
  if (!href.includes("/maps/place")) return null;

  beginMapsCellWork();
  try {
    await navigateMapsTab({ url: href });
    await sleep(650);

    const result = await sendMapsMessageWithTimeout(
      "ENRICH_PLACE",
      {
        searchParams: params,
        listData: place,
        progressText,
        percent: pct,
        fast: true
      },
      50000
    );

    return result?.place || null;
  } finally {
    endMapsCellWork();
  }
}

async function enrichPlacesInCell(cellPlaces, cellIndex, params, processed, totalEnrich) {
  const cell = scrapeState.gridPoints[cellIndex] || scrapeState.gridPoints[0];
  const cellLat = cell?.lat ?? params.lat;
  const cellLng = cell?.lng ?? params.lng;
  const searchUrl =
    cellPlaces[0]?._enrichSearchUrl ||
    buildMapsUrl(params.keyword, cellLat, cellLng, scrapeState.cellSizeKm);

  beginMapsCellWork();
  try {
    await navigateMapsTab({ url: searchUrl });
    await sleep(500);

    let done = processed;

    for (const place of cellPlaces) {
      if (!scrapeState.running) break;

      done += 1;
      const pct = 55 + Math.round((done / totalEnrich) * 40);
      const progressText = `Giai đoạn 2/2 — ${done}/${totalEnrich}: ${place.name}`;
      const profile = getEnrichProfile(place);
      notifyProgress(pct, progressText);

      try {
        const result = await sendMapsMessageWithTimeout(
          "ENRICH_ONE",
          {
            searchParams: params,
            place,
            cellIndex,
            cellLat,
            cellLng,
            searchUrl,
            globalIdx: done,
            totalEnrich,
            percent: pct
          },
          50000
        );

        if (result?.place) {
          upsertMergedPlace(result.place);
          sendItemToWeb(params.webUrl, result.place, params);
          continue;
        }

        if (result?.needUrlFallback) {
          const enriched = await enrichPlaceByUrl(place, params, progressText, pct, profile);
          if (enriched) {
            upsertMergedPlace(enriched);
            sendItemToWeb(params.webUrl, enriched, params);
          }
        }
      } catch (err) {
        console.warn("Enrich skip:", place.name, err.message);
        try {
          const enriched = await enrichPlaceByUrl(place, params, progressText, pct, profile);
          if (enriched) {
            upsertMergedPlace(enriched);
            sendItemToWeb(params.webUrl, enriched, params);
          }
        } catch (innerErr) {
          console.warn("Enrich URL fallback failed:", place.name, innerErr.message);
        }
      }
    }

    return done;
  } finally {
    endMapsCellWork();
  }
}

function pushLiveItemsToWeb(items, meta = {}) {
  if (!items.length || !currentSearch?.webUrl) return;
  const params = scrapeState.searchParams;
  const withDistance = annotatePlacesRadius(items, params.lat, params.lng, params.radius).map((item) => ({
    ...item,
    _phase: meta.phase || "grid"
  }));

  sendToWebPage(currentSearch.webUrl, "items_batch", {
    items: withDistance,
    searchParams: currentSearch,
    mergedCount: scrapeState.mergedPlaces.size,
    ...meta
  });
}

  async function handleCellListComplete(data) {
  const { places, cellIndex, totalCells, skippedCount = 0, clickAttempts = 0 } = data;
  const beforeCount = scrapeState.mergedPlaces.size;
  bgLog(`Ô ${cellIndex + 1} đánh dấu HOÀN TẤT · nhận ${places.length} điểm từ content`);
  scrapeState.completedCells.add(cellIndex);
  mergePlaces(places);
  const newUnique = scrapeState.mergedPlaces.size - beforeCount;
  scheduleLiveSearchBackup(true);

  const cell = scrapeState.gridPoints[cellIndex];
  const total = getFinalResultsList().length;
  const pct = Math.round(((cellIndex + 1) / totalCells) * 92);
  const progressText = buildProgressText(cell, cellIndex, totalCells, {
    newCount: newUnique,
    skipped: skippedCount,
    total,
    action: `Hoàn tất khu vực với ${places.length} điểm bán`
  });

  scheduleSyncSnapshot(progressText, pct, true);
  notifyProgress(pct, progressText);
  persistScrapeCheckpoint().catch(() => {});

  const nextIndex = cellIndex + 1;
  if (nextIndex < totalCells && scrapeState.running) {
    scrapeState.gridIndex = nextIndex;
    await runGridCell(nextIndex);
    return;
  }

  if (!scrapeState.running) return;

  const allPlaces = getFinalResultsList();
  if (allPlaces.length === 0) {
    chrome.runtime.sendMessage({
      action: "SCRAPE_ERROR",
      error: "Không tìm thấy điểm bán phù hợp trong khu vực đã chọn."
    });
    scrapeState.running = false;
    await closeMapsTabSafely();
    resetScrapeState();
    return;
  }

  notifyProgress(95, `Đang hoàn tất ${allPlaces.length} điểm bán…`);

  try {
    await sendMapsMessage("SCRAPE_FINISH", {});
  } catch {}

  await handleScrapeComplete({ searchParams: scrapeState.searchParams });
}

async function runEnrichPhase() {
  const params = scrapeState.searchParams;
  if (!params || !scrapeState.mapsTabId) {
    await handleScrapeComplete({ searchParams: params });
    return;
  }

  scrapeState.phase = "enrich";
  const list = getFinalResultsList();
  const toEnrich = list.filter(placeNeedsEnrich);
  const skipEnrich = toEnrich.length === 0;
  let processed = 0;

  if (!skipEnrich) {
    notifyProgress(
      55,
      `Đã thu thập ${list.length} điểm bán. Đang bổ sung thông tin cho ${toEnrich.length} điểm…`
    );

    try {
      await sendMapsMessage("SCRAPE_SHIELD_UPDATE", {
        text: `Đang bổ sung thông tin cho ${toEnrich.length} điểm bán…`,
        percent: 55
      });
    } catch {}

    const cellGroups = groupPlacesByEnrichCell(toEnrich);

    for (const [cellIndex, cellPlaces] of cellGroups) {
      if (!scrapeState.running) break;

      notifyProgress(
        55 + Math.round((processed / toEnrich.length) * 38),
        `Khu vực ${cellIndex + 1} · Đang bổ sung thông tin cho ${cellPlaces.length} điểm bán…`
      );

      try {
        processed = await enrichPlacesInCell(cellPlaces, cellIndex, params, processed, toEnrich.length);
      } catch (err) {
        console.warn(`Enrich cell ${cellIndex}:`, err.message);
        for (const place of cellPlaces) {
          if (!scrapeState.running) break;
          processed += 1;
          const pct = 55 + Math.round((processed / toEnrich.length) * 40);
          const progressText = `Giai đoạn 2/2 — dự phòng ${processed}/${toEnrich.length}: ${place.name}`;
          try {
            const enriched = await enrichPlaceByUrl(
              place,
              params,
              progressText,
              pct,
              getEnrichProfile(place)
            );
            if (enriched) {
              upsertMergedPlace(enriched);
              sendItemToWeb(params.webUrl, enriched, params);
            }
          } catch (innerErr) {
            console.warn("Enrich fallback:", place.name, innerErr.message);
          }
        }
      }
    }
  }

  const allPlaces = getFinalResultsList();
  if (allPlaces.length === 0) {
    chrome.runtime.sendMessage({
      action: "SCRAPE_ERROR",
      error: "Không tìm thấy điểm bán phù hợp trong khu vực đã chọn."
    });
    scrapeState.running = false;
    await closeMapsTabSafely();
    resetScrapeState();
    return;
  }

  notifyProgress(95, `Đang hoàn tất ${allPlaces.length} điểm bán…`);

  try {
    await sendMapsMessage("SCRAPE_FINISH", {});
  } catch {}

  await handleScrapeComplete({ searchParams: params });
}

async function closeMapsTabSafely() {
  const tabId = scrapeState.mapsTabId;
  scrapeState.mapsTabId = null;
  scrapeState.mapsWindowId = null;
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {}
}

async function handleScrapeComplete(data) {
  if (pointsFinalized) return { success: true, alreadyFinalized: true };
  pointsFinalized = true;

  const { searchParams, partial, partialReason, partialCode } = data;
  const finalResults = getFinalResultsList();

  scrapeState.phase = partial ? "partial" : "completed";
  scrapeState.running = false;
  // Đóng Maps ngay — tránh để tab treo / mở thêm tab khi tìm từ khóa tiếp theo.
  // Phần sync còn lại chỉ làm việc với tab Findmap.
  disableMapsBoost().catch(() => {});
  await closeMapsTabSafely();

  const completePayload = {
    results: finalResults,
    searchParams: {
      ...toDurableSearchParams(searchParams),
      gridCells: scrapeState.totalCells,
      uniqueResults: finalResults.length
    },
    pointsInfo: null,
    chargeDeferred: true,
    uniquePhoneCount: countResultsWithPhone(finalResults),
    total: finalResults.length,
    totalFound: finalResults.length,
    completedAt: new Date().toISOString(),
    partial: !!partial,
    partialReason: partialReason || null,
    partialCode: partialCode || null
  };

  try {
    // Đồng bộ snapshot đầy đủ trước complete — tránh web nhận ít hơn extension
    await pushSyncSnapshotToWeb(`Đang đồng bộ ${finalResults.length} điểm bán về Findmap…`, 99);
    for (let syncTry = 0; syncTry < 6; syncTry++) {
      const tab = scrapeState.webTabId
        ? await chrome.tabs.get(scrapeState.webTabId).catch(() => null)
        : await findWebTab(searchParams.webUrl);
      if (tab?.id) {
        scrapeState.webTabId = tab.id;
        const verified = await verifyWebReceived(
          tab.id,
          finalResults.length,
          searchParams.searchId
        );
        if (verified.ok) break;
      }
      await pushSyncSnapshotToWeb(`Đang kiểm tra và bổ sung kết quả về Findmap · Lần ${syncTry + 2}`, 99);
      await sleep(400 * (syncTry + 1));
    }

    // Retry gửi complete nhiều lần — đảm bảo web page nhận kết quả ngay cả khi không active
    let sent = false;
    for (let i = 0; i < 8 && !sent; i++) {
      sent = await sendToWebPage(searchParams.webUrl, "complete", completePayload);
      if (!sent) await sleep(1500);
    }
    // Fallback: nếu vẫn chưa gửi được, lưu kết quả vào storage để web page tự lấy khi active
    if (!sent) {
      try {
        await chrome.storage.local.set({ pendingComplete: completePayload });
      } catch {}
    }

    chrome.runtime.sendMessage({
      action: "SEARCH_COMPLETE",
      count: finalResults.length,
      searchId: searchParams.searchId,
      user: null
    }).catch(() => {});
  } finally {
    // Dù sync có lỗi giữa chừng, tab Maps và trạng thái quét luôn được dọn.
    await closeMapsTabSafely();
    await resetScrapeState();
  }
  return { success: true };
}

function dispatchRuntimeMessage(message, sender, sendResponse) {
  if (message.action === "PING_BG") {
    const manifest = chrome.runtime.getManifest();
    sendResponse({ ok: true, version: manifest.version, name: manifest.name });
    return true;
  }

  if (message.action === "CONNECT_WEB_SITE") {
    (async () => {
      try {
        let tab = sender?.tab;
        if (!tab?.id || !tab?.url) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          tab = active;
        }
        const originHint = message.data?.origin || tab?.url;
        if (originHint && !tab?.url) {
          await rememberWebOrigin(originHint);
        }
        // Popup: ping trước, chỉ reload nếu bridge chết
        const result = await ensureBridgeOnTab(tab, { forceReload: false });
        if (result.ok && result.origin) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              action: "TIMDIEMBAN_DATA",
              type: "bridge_ready",
              payload: { ok: true, connected: true, origin: result.origin }
            });
          } catch {}
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.action === "INSPECT_ACTIVE_TAB") {
    inspectActiveTab()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.action === "GET_WEB_ORIGINS") {
    Promise.all([getPreferredWebOrigin(), getExtraWebOrigins()])
      .then(([preferred, extra]) =>
        sendResponse({
          ok: true,
          preferred,
          config: getAppOrigin(),
          extra
        })
      )
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === "START_SEARCH") {
    handleStartSearch(message.data).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === "CANCEL_SEARCH") {
    cancelActiveSearch(message.data?.reason)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "ABANDON_SEARCH") {
    abandonActiveSearch()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "REQUEST_SEARCH_SYNC") {
    pushSearchSyncToWeb(message.data?.reason || "Đồng bộ lại sau khi tải trang")
      .then(async (ok) => {
        let webCount = null;
        if (scrapeState.webTabId) {
          const stats = await readWebTabStats(scrapeState.webTabId);
          webCount = stats?.count ?? null;
        }
        sendResponse({
          success: ok,
          count: getFinalResultsList().length,
          extCount: getFinalResultsList().length,
          webCount,
          lastSyncedMergedCount
        });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "MAPS_TAB_VISIBLE") {
    ensureWebSyncedToResults("Đồng bộ khi tab Maps active lại", true)
      .then((ok) => sendResponse({ success: ok, count: scrapeState.mergedPlaces.size }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "GET_SEARCH_STATUS") {
    getSearchStatus().then(sendResponse).catch(() => sendResponse({ running: false }));
    return true;
  }

  if (message.action === "SET_MAPS_AUTO_FOCUS") {
    const enabled = !!message.data?.enabled;
    if (scrapeState.searchParams) {
      scrapeState.searchParams.mapsAutoFocus = enabled;
      syncMapsAutoFocusAlarm();
      persistScrapeCheckpoint().catch(() => {});
      chrome.storage.local
        .set({
          lastSearch: toDurableSearchParams(scrapeState.searchParams),
          activeSearch: toDurableSearchParams(scrapeState.searchParams)
        })
        .catch(() => {});
    }
    if (enabled) focusMapsTabForSearch().catch(() => {});
    sendResponse({ success: true, enabled });
    return true;
  }

  if (message.action === "SET_MAPS_AUTO_REOPEN") {
    const enabled = !!message.data?.enabled;
    if (scrapeState.searchParams) {
      scrapeState.searchParams.mapsAutoReopen = enabled;
      persistScrapeCheckpoint().catch(() => {});
      chrome.storage.local
        .set({
          lastSearch: toDurableSearchParams(scrapeState.searchParams),
          activeSearch: toDurableSearchParams(scrapeState.searchParams)
        })
        .catch(() => {});
    }
    if (rescanState.running) {
      rescanState.mapsAutoReopen = enabled;
      if (rescanState.params) rescanState.params.mapsAutoReopen = enabled;
      if (rescanState.searchParams) rescanState.searchParams.mapsAutoReopen = enabled;
      persistRescanCheckpoint().catch(() => {});
    }
    sendResponse({ success: true, enabled });
    return true;
  }

  if (message.action === "RESUME_SEARCH") {
    tryResumeFromCheckpoint({ allowReopen: true })
      .then((ok) => sendResponse({ success: ok }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "START_RESCAN") {
    handleStartRescan(message.data).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === "GET_RESCAN_STATUS") {
    sendResponse({
      running: rescanState.running,
      done: rescanState.done,
      total: rescanState.total,
      mapsAutoReopen: isRescanAutoReopenEnabled()
    });
    return true;
  }

  if (message.action === "BACKGROUND_MODE_CHANGED") {
    const enabled = message.data?.enabled === true;
    if (enabled) {
      const tabId = scrapeState.mapsTabId || rescanState.mapsTabId;
      if (tabId) ensureMapsBoost(tabId).catch(() => false);
    } else {
      disableMapsBoost().catch(() => {});
    }
    sendResponse({ success: true, enabled });
    return true;
  }

  if (message.action === "GET_SESSION") {
    chrome.storage.local.get(["authToken", "authUser"], (data) => {
      sendResponse({
        token: data.authToken || "",
        user: data.authUser || null
      });
    });
    return true;
  }

  if (message.action === "GET_MAPS_CENTER") {
    chrome.tabs.query({ url: "*://www.google.com/maps/*" }, (tabs) => {
      const tab = tabs.find((t) => t.active) || tabs[0];
      if (!tab?.url) {
        sendResponse({
          error:
            "Mở Google Maps, kéo bản đồ đến đúng điểm trung tâm, rồi bấm lại."
        });
        return;
      }
      const center = extractMapCenterFromUrl(tab.url);
      if (!center) {
        sendResponse({
          error: "Không đọc được @lat,lng từ URL Maps. Zoom/di chuyển bản đồ rồi thử lại."
        });
        return;
      }
      sendResponse({ center });
    });
    return true;
  }

  if (message.action === "SAVE_SESSION") {
    const { token, user } = message.data || {};
    if (token && user) chrome.storage.local.set({ authToken: token, authUser: user });
    else chrome.storage.local.remove(["authToken", "authUser"]);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "SCRAPE_PROGRESS") {
    if (!scrapeState.running || !acceptsActiveCellMessage(message, sender)) return;
    notifyProgress(message.percent, message.text);
  }

  if (message.action === "SCRAPE_LOG") {
    if (!scrapeState.running || !acceptsActiveCellMessage(message, sender)) return;
    const line = message.line;
    chrome.runtime.sendMessage({ action: "SEARCH_LOG", line }).catch(() => {});
    if (currentSearch?.webUrl) {
      sendToWebPage(currentSearch.webUrl, "log", { line });
    }
  }

  if (message.action === "SCRAPE_ITEM") {
    if (!scrapeState.running || !acceptsActiveCellMessage(message, sender)) return;
    const { result, searchParams } = message.data;
    const params = scrapeState.searchParams || searchParams;
    if (!params) return;
    const merged = upsertMergedPlace(result);
    if (!merged) return;

    scheduleLiveSearchBackup(true);

    // Cập nhật overlay: hiện TỔNG unique đã gửi (không nhầm với # trong ô)
    const total = getFinalResultsList().length;
    const cellIdx = scrapeState.gridIndex || 0;
    const cells = scrapeState.totalCells || 1;
    const pct = calcProgressPercent(cellIdx, cells, Math.min(0.9, 0.2 + (total % 20) * 0.03));
    if (!scrapeState._lastShieldItemAt || Date.now() - scrapeState._lastShieldItemAt > 400) {
      scrapeState._lastShieldItemAt = Date.now();
      updateMapsShield(
        `Khu vực ${cellIdx + 1}/${cells} · Đã đồng bộ ${total} điểm bán${merged.name ? ` · ${merged.name}` : ""}`.slice(0, 140),
        Math.max(pct, 3)
      );
    }

    // Không fire-and-forget — chờ gửi xong để bù sync khi fail
    sendItemToWeb(params.webUrl, merged, params).catch(() => {});
  }

  if (message.action === "CELL_LIST_COMPLETE") {
    return;
  }

  if (message.action === "SCRAPE_ERROR") {
    if (!scrapeState.running && scrapeState.mergedPlaces.size === 0) return;
    notifyPopup(`Cảnh báo: ${message.error}`);
    if (scrapeState.mergedPlaces.size > 0 && !pointsFinalized) {
      abortSearch("SCRAPE_ERROR", message.error || "Lỗi khi quét", { chargePartial: true });
      return;
    }
    if (currentSearch?.webUrl) {
      sendToWebPage(currentSearch.webUrl, "error", {
        error: message.error,
        partial: scrapeState.mergedPlaces.size > 0
      });
    }
  }
}

const BOOT_INDEPENDENT_ACTIONS = new Set([
  "PING_BG",
  "CONNECT_WEB_SITE",
  "INSPECT_ACTIVE_TAB",
  "GET_WEB_ORIGINS",
  "GET_SESSION",
  "SAVE_SESSION",
  "BACKGROUND_MODE_CHANGED"
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (serviceBootComplete || BOOT_INDEPENDENT_ACTIONS.has(message?.action)) {
    return dispatchRuntimeMessage(message, sender, sendResponse);
  }

  ensureServiceReady(`runtime_message:${message?.action || "unknown"}`)
    .then(() => {
      const keepsChannelOpen = dispatchRuntimeMessage(message, sender, sendResponse);
      // Các message tiến độ không có response riêng; ACK để đóng channel đã giữ mở lúc bootstrap.
      if (keepsChannelOpen !== true) sendResponse({ ok: true });
    })
    .catch((err) => {
      sendResponse({ success: false, error: err?.message || "Không khôi phục được service worker" });
    });
  return true;
});

async function handleStartSearch(params) {
  if (scrapeState.running) {
    throw new Error("Một lượt tìm kiếm đang chạy. Hãy bấm 'Dừng quét điểm bán' hoặc đợi hoàn tất.");
  }
  if (rescanState.running) {
    throw new Error("Đang quét lại dữ liệu. Hãy đợi quét lại hoàn tất trước khi tìm kiếm mới.");
  }

  await ensureReadyForNewSearch();
  await clearRescanCheckpoint();
  // Chắc chắn không còn tab Maps cũ trước khi mở tab mới
  await closeMapsTabSafely();

  // Xóa snapshot/checkpoint phiên cũ — tránh sync lại điểm Hà Nội vào lượt Bắc Ninh
  try {
    await clearScrapeCheckpoint();
    await chrome.storage.local.remove([
      "pendingComplete",
      "pendingSearchSync",
      "activeSearch",
      SCRAPE_CHECKPOINT_KEY,
      PENDING_SYNC_KEY
    ]);
  } catch {}
  if (!scrapeState.running) {
    scrapeState.mergedPlaces = new Map();
    scrapeState.completedCells = new Set();
    scrapeState.gridPoints = [];
    scrapeState.searchParams = null;
    scrapeState.gridIndex = 0;
    scrapeState.totalCells = 0;
    scrapeState.phase = "grid";
    lastSyncedMergedCount = 0;
    lastForceSyncAt = 0;
    pointsFinalized = false;
  }

  if (params?.webUrl) {
    try {
      await rememberWebOrigin(params.webUrl);
      // Không reload tab lúc START_SEARCH — bridge đã có từ manifest content_scripts
    } catch {}
  }

  const webTab = await findWebTab(params.webUrl);
  if (!webTab) {
    throw new Error(
      `Trang kết quả chưa mở. Vui lòng mở ${getAppOriginLabel()} trước khi tìm kiếm.`
    );
  }

  const authUser = await checkAuthAndPoints(params.webUrl, params.authToken);
  params.authToken = params.authToken;
  params.userPoints = authUser.points;

  const center = normalizeCenterCoords(params.lat, params.lng);
  if (!center) {
    throw new Error(
      "Tọa độ trung tâm không hợp lệ. Hãy chọn lại tâm trên bản đồ hoặc nhập đúng vĩ độ và kinh độ."
    );
  }
  params.lat = center.lat;
  params.lng = center.lng;

  params.radius = clampSearchRadiusKm(params.radius);
  const grid = generateSearchGrid(params.lat, params.lng, params.radius);

  params.searchId = String(params.searchId || `search_${Date.now()}_${crypto.randomUUID()}`);
  currentSearch = { ...params, gridCells: grid.totalCells };
  pointsFinalized = false;
  lastScrapeProgressAt = Date.now();
  scrapeState.running = true;
  scrapeState.runId = params.searchId;
  scrapeState.cellGeneration = 0;
  scrapeState.searchParams = params;
  scrapeState.webTabId = webTab.id;
  scrapeState.mapsTabId = null;
  scrapeState.gridPoints = grid.points;
  scrapeState.gridIndex = 0;
  scrapeState.totalCells = grid.totalCells;
  scrapeState.cellSizeKm = grid.cellSizeKm;
  scrapeState.viewportM = grid.viewportM;
  scrapeState.mergedPlaces = new Map();
  scrapeState.completedCells = new Set();
  scrapeState.phase = "grid";
  scrapeState._retriedCells = new Set();
  scrapeState._mapsReopenCount = 0;
  scrapeState._mapsUserReloadCount = 0;
  lastSyncedMergedCount = 0;
  lastForceSyncAt = 0;
  startScrapeKeepAlive();

  scrapeState.webTabId = webTab.id;
  await chrome.tabs.update(webTab.id, { autoDiscardable: false }).catch(() => {});

  const durableParams = toDurableSearchParams(params);
  await chrome.storage.local.set({ lastSearch: durableParams, activeSearch: durableParams });
  await persistScrapeCheckpoint();

  await sendToWebPage(
    params.webUrl,
    "start",
    {
      searchParams: {
        ...params,
        gridCells: grid.totalCells,
        cellSizeKm: grid.cellSizeKm,
        viewportM: grid.viewportM,
        gridPoints: grid.points.map((p) => ({
          cellId: p.cellId,
          cellLabel: p.cellLabel,
          lat: p.lat,
          lng: p.lng
        }))
      },
      user: authUser
    },
    { abortOnFail: true }
  );

  await notifyProgress(
    2,
    `Đã tạo ${grid.totalCells} khu vực tìm kiếm trong bán kính ${params.radius} km. Đang mở Google Maps…`
  );

  runGridCell(0).catch(async (err) => {
    if (scrapeState.running) {
      await abortSearch("SCRAPE_FAILED", err?.message || String(err));
    }
  });

  const mapsReady = await waitForMapsTabReady(30000);
  if (!mapsReady && scrapeState.running) {
    await abortSearch(
      "MAPS_OPEN_TIMEOUT",
      "Không mở được Google Maps. Hãy kiểm tra tiện ích được phép hoạt động trên google.com/maps rồi thử lại."
    );
    throw new Error("Không mở được Google Maps. Hãy kiểm tra quyền truy cập Google Maps rồi thử lại.");
  }

  return { success: true, gridCells: grid.totalCells };
}

// ——— Quét lại (Rescan) những điểm thiếu thông tin ———

async function sendMapsMessageToTab(tabId, action, data, timeoutMs = 45000) {
  const ready = await ensureMapsContentReady(tabId);
  if (!ready) throw new Error("Không kết nối được với Google Maps. Hãy tải lại tab Google Maps rồi thử lại.");
  let timer;
  try {
    return await Promise.race([
      (async () => {
        try {
          return await chrome.tabs.sendMessage(tabId, { action, data });
        } catch {
          await ensureMapsContentReady(tabId);
          return await chrome.tabs.sendMessage(tabId, { action, data });
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Google Maps chưa phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleStartRescan(params) {
  if (scrapeState.running) {
    throw new Error("Một lượt tìm kiếm đang chạy. Hãy đợi hoàn tất hoặc dừng lượt tìm kiếm trước.");
  }
  if (rescanState.running) {
    throw new Error("Đang quét lại — vui lòng đợi hoàn tất.");
  }
  if (!Array.isArray(params.places) || !params.places.length) {
    throw new Error("Không có điểm nào để quét lại.");
  }

  await clearRescanCheckpoint();
  resetRescanState();
  rescanState.running = true;
  rescanState.webUrl = params.webUrl;
  rescanState.params = params;
  rescanState.places = params.places;
  rescanState.searchParams = params.searchParams || {};
  rescanState.mapsAutoReopen =
    params.mapsAutoReopen === true || rescanState.searchParams.mapsAutoReopen === true;
  rescanState.done = 0;
  rescanState.total = params.places.length;
  rescanState.placeIndex = 0;
  await persistRescanCheckpoint();

  doRescan(params).catch((err) => {
    console.error("[Rescan] Lỗi:", err);
    if (rescanState.running) {
      abortRescan(err.message || "Lỗi quét lại", "RESCAN_ERROR").catch(() => {});
    }
  });

  return { success: true, total: params.places.length };
}

async function enrichRescanPlace(place, searchParams) {
  const href = buildRescanHref(place);
  if (!href || !rescanState.mapsTabId) return null;

  let attempts = 0;
  while (attempts < 3 && rescanState.running) {
    attempts += 1;
    try {
      if (!rescanState.mapsTabId) throw new Error("Tab Google Maps đã bị đóng.");
      await chrome.tabs.update(rescanState.mapsTabId, { url: href });
      await waitTabComplete(rescanState.mapsTabId);
      ensureMapsBoost(rescanState.mapsTabId).catch(() => {});
      await sleep(700);

      const result = await sendMapsMessageToTab(rescanState.mapsTabId, "ENRICH_PLACE", {
        searchParams,
        listData: place,
        fast: true
      });
      rescanState._awaitingReopen = false;
      return result?.place || null;
    } catch (err) {
      if (
        isRescanAutoReopenEnabled() &&
        rescanState.running &&
        !rescanState.mapsTabId &&
        attempts < 3
      ) {
        for (let w = 0; w < 24; w++) {
          await sleep(500);
          if (rescanState.mapsTabId) break;
          if (!rescanState.running) throw err;
        }
        if (rescanState.mapsTabId) continue;
      }
      throw err;
    }
  }
  return null;
}

async function runRescanPlacesLoop() {
  const places = rescanState.places;
  const webUrl = rescanState.webUrl;
  const searchParams = rescanState.searchParams || {};

  while (rescanState.placeIndex < places.length && rescanState.running) {
    const idx = rescanState.placeIndex;
    const place = places[idx];
    let enriched = null;

    try {
      enriched = await enrichRescanPlace(place, searchParams);
    } catch (err) {
      console.warn("[Rescan] Skip:", place.name, err.message);
    }

    if (enriched) {
      if (place.sourceKey) enriched._sourceKey = place.sourceKey;
      await sendToWebPage(webUrl, "item", {
        result: enriched,
        searchParams,
        rescan: true
      });
    }

    rescanState.placeIndex = idx + 1;
    rescanState.done = idx + 1;
    await persistRescanCheckpoint();

    await sendToWebPage(webUrl, "rescan_progress", {
      done: rescanState.done,
      total: rescanState.total,
      percent: Math.round((rescanState.done / rescanState.total) * 100),
      name: place.name || ""
    });
  }
}

async function finishRescanNormal() {
  if (!rescanState.running) return;
  const webUrl = rescanState.webUrl;
  const done = rescanState.done;
  const total = rescanState.total;

  if (rescanState.mapsTabId) {
    try {
      await chrome.tabs.remove(rescanState.mapsTabId);
    } catch {}
  }
  rescanState.running = false;
  await sendToWebPage(webUrl, "rescan_complete", { done, total }).catch(() => {});
  await clearRescanCheckpoint();
  resetRescanState();
  await clearDurableWorkAlarmIfIdle();
}

async function doRescan(params) {
  const opened = await openRescanMapsTab();
  if (!opened) {
    throw new Error("Không mở được Google Maps. Hãy kiểm tra quyền truy cập Google Maps rồi thử lại.");
  }

  await sendToWebPage(rescanState.webUrl, "rescan_start", { total: rescanState.total });

  try {
    await runRescanPlacesLoop();
  } finally {
    await finishRescanNormal();
  }
}

function buildRescanHref(place) {
  const raw = (place.href || place.mapsUrl || "").split("#")[0];
  if (raw.includes("/maps/place") || raw.includes("query_place_id")) return raw;
  const pid = place.googlePlaceId || "";
  const lat = place.lat;
  const lng = place.lng;
  const name = (place.name || "").trim();
  if (pid && String(pid).startsWith("ChIJ")) {
    const label = name ? encodeURIComponent(name) : `${lat},${lng}`;
    return `https://www.google.com/maps/search/?api=1&query=${label}&query_place_id=${pid}`;
  }
  if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
    if (name) {
      return `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},17z`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  if (name) return `https://www.google.com/maps/search/${encodeURIComponent(name)}`;
  return "";
}

async function recoverDurableWork(reason = "service_wake") {
  if (durableRecoveryBusy || scrapeState.running || rescanState.running) return false;
  durableRecoveryBusy = true;
  try {
    const scrapeCheckpoint = await getScrapeCheckpoint();
    if (DurableLifecycle.isRecoverableScrapeCheckpoint(scrapeCheckpoint)) {
      const resumed = await tryResumeFromCheckpoint();
      if (resumed) bgLog(`Đã khôi phục phiên tìm kiếm (${reason}).`);
      else await ensureDurableWorkAlarm();
      return resumed;
    }

    const rescanCheckpoint = await getRescanCheckpoint();
    if (DurableLifecycle.isRecoverableRescanCheckpoint(rescanCheckpoint)) {
      const resumed = await tryResumeRescanFromCheckpoint();
      if (resumed) console.log(`TimDiemBan: đã khôi phục phiên quét lại (${reason}).`);
      else await ensureDurableWorkAlarm();
      return resumed;
    }
    await clearDurableWorkAlarmIfIdle();
    return false;
  } finally {
    durableRecoveryBusy = false;
  }
}

function ensureServiceReady(reason = "service_boot") {
  if (serviceBootComplete) return Promise.resolve(false);
  if (serviceBootPromise) return serviceBootPromise;

  serviceBootPromise = recoverDurableWork(reason)
    .then((recovered) => {
      serviceBootComplete = true;
      return recovered;
    })
    .catch((err) => {
      serviceBootComplete = false;
      throw err;
    })
    .finally(() => {
      serviceBootPromise = null;
    });
  return serviceBootPromise;
}

ensureServiceReady("worker_loaded").catch((err) => {
  console.warn("service bootstrap:", err?.message || err);
});
chrome.runtime.onStartup.addListener(() => {
  serviceBootComplete = false;
  ensureServiceReady("browser_startup").catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  serviceBootComplete = false;
  ensureServiceReady("extension_installed_or_updated").catch(() => {});
});
