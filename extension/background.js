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
  paused: false,
  pausedAt: 0,
  pauseReason: "",
  resumeRequestedAt: 0,
  runId: "",
  mapsTabId: null,
  mapsWindowId: null,
  enrichTabId: null,
  enrichWindowId: null,
  webTabId: null,
  searchParams: null,
  gridPoints: [],
  gridIndex: 0,
  totalCells: 0,
  cellSizeKm: 2,
  viewportM: 2500,
  mergedPlaces: new Map(),
  pendingCellPlaces: new Map(),
  pendingCellIndex: -1,
  completedCells: new Set(),
  enrichedPlaceKeys: new Set(),
  failedEnrichKeys: new Set(),
  enrichTotal: 0,
  phase: "grid",
  quickScan: false,
  quickProducerDone: false,
  cellGeneration: 0,
  _expectMapsNavigation: false,
  _programmaticMapsNavUntil: 0,
  _mapsCellWorkActive: false,
  _mapsCellListActive: false,
  _mapsCellListLease: null,
  _mapsListWarningKey: "",
  _mapsUserReloadCount: 0,
  _cellContinueFlags: {},
  _cellRestartFlags: {},
  _cellResumeLeases: {},
  _pendingGridContinuation: -1,
  _cellListProgress: {},
  _activeEnrichOpId: "",
  _enrichActivityAt: 0,
  _enrichGeneration: 0,
  _pendingCompletion: null,
  _lastRecoveryFocusDataAt: 0,
  _lastEnrichRecoveryFocusDataAt: 0,
  _lastSoftRecoveryAt: 0,
  _enrichMapsReopenCount: 0
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
/** Lần gần nhất content script trả tiến độ hoặc dữ liệu thật từ Google Maps. */
let lastScrapeProgressAt = 0;
let stallRecoveryBusy = false;
let mapsReloadRecoverBusy = false;
let mapsReloadTimer = null;
let syncDebounceTimer = null;
const MAPS_AUTO_FOCUS_ALARM = "timdiemban_maps_focus";
const mapsCellWorkTokens = new Set();
const quickEnrichWorkTokens = new Set();
let activeMapsCellListToken = null;
const mapsRescanWorkTokens = new Set();
const operationTransitionTokens = new Set();
let mapsContentWakeTimer = null;
let mapsContentWakeTickBusy = false;
let mapsTabLossBusy = false;
let quickEnrichTabLossBusy = false;
let mapsTabRecoveryQueue = Promise.resolve();
let enrichRunPromise = null;
let quickEnrichRunPromise = null;
let enrichWatchdogBusy = false;
let quickEnrichWatchdogBusy = false;
let systemKeepAwakeRequested = false;
let scrapeCheckpointQueue = Promise.resolve();
let rescanCheckpointQueue = Promise.resolve();
let mergedPlaceLookupIndex = null;

function beginOperationTransition(label) {
  const token = Symbol(label || "operation-transition");
  operationTransitionTokens.add(token);
  return token;
}

function endOperationTransition(token) {
  operationTransitionTokens.delete(token);
}

function claimOperationStart(kind) {
  if (operationTransitionTokens.size > 0 || isAborting || durableRecoveryBusy) {
    throw new Error("Findmap đang hoàn tất lượt trước. Vui lòng chờ vài giây rồi thử lại.");
  }
  if (scrapeState.running) {
    throw new Error("Một lượt tìm kiếm đang chạy. Hãy dừng hoặc đợi lượt hiện tại hoàn tất.");
  }
  if (scrapeState.paused && kind !== "resume-search") {
    throw new Error("Một lượt tìm kiếm đang tạm dừng. Hãy tiếp tục hoặc dừng hẳn lượt đó trước.");
  }
  if (rescanState.running) {
    throw new Error("Đang quét lại dữ liệu. Hãy đợi lượt hiện tại hoàn tất.");
  }
  return beginOperationTransition(`start-${kind}`);
}

/** Ngân sách cho một lần thu danh sách; pha click chi tiết chạy riêng. */
// Mỗi request phải kết thúc dưới giới hạn 5 phút của service worker MV3.
const CELL_LIST_TIMEOUT_MS = 270000;
const MAX_INCOMPLETE_CELL_RETRIES = 3;
const MAX_CELL_HARD_RECOVERIES = 1;
const CELL_FLOW_VERSION = 3;
const PER_CELL_ENRICH_FLOW_VERSION = 2;
const MAX_DIRECT_URL_RETRIES = 3;
const MAPS_STALL_FOCUS_MS = 5 * 60 * 1000;
const MAPS_SOFT_RECOVERY_INTERVAL_MS = 60 * 1000;
const CELL_LIST_STALL_RETRY_MS = 5 * 60 * 1000;
const CELL_LIST_SCROLL_GROWTH_PX = 8;
const QUICK_SCAN_QUEUE_LIMIT = 180;
const MERGED_PLACE_NEAR_DUPLICATE_CANDIDATE_LIMIT = 32;

const SCRAPE_CHECKPOINT_KEY = "scrapeCheckpoint";
const RESCAN_CHECKPOINT_KEY = "rescanCheckpoint";
const PENDING_SYNC_KEY = "pendingSearchSync";
const PENDING_COMPLETE_KEY = "pendingComplete";
const PENDING_COMPLETE_VERSION = 2;
const DurableLifecycle = globalThis.TimDiemBanLifecycle;
const DURABLE_WORK_ALARM = DurableLifecycle.WATCHDOG_ALARM;
const DURABLE_WORK_PERIOD_MINUTES = DurableLifecycle.WATCHDOG_PERIOD_MINUTES;
const WEB_DATA_TYPES = new Set(["item", "sync", "items_batch", "progress", "complete", "start"]);

let serviceBootComplete = false;
let serviceBootPromise = null;
let durableRecoveryBusy = false;

function enqueueCheckpointMutation(kind, task) {
  const current = kind === "rescan" ? rescanCheckpointQueue : scrapeCheckpointQueue;
  const next = current.catch(() => {}).then(task);
  if (kind === "rescan") rescanCheckpointQueue = next;
  else scrapeCheckpointQueue = next;
  return next;
}

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
  failed: 0,
  total: 0,
  placeIndex: 0,
  places: null,
  params: null,
  searchParams: null,
  mapsAutoReopen: false,
  _terminalCompletion: null,
  _reopenCount: 0,
  _handlingTabLoss: false,
  _awaitingReopen: false,
  _lastDataAt: 0,
  _lastRecoveryFocusDataAt: 0
};

function requestSystemKeepAwake() {
  if (systemKeepAwakeRequested) return true;
  try {
    chrome.power?.requestKeepAwake("system");
    systemKeepAwakeRequested = true;
    return true;
  } catch (err) {
    console.warn("requestSystemKeepAwake:", err?.message || err);
    return false;
  }
}

function releaseSystemKeepAwake({ force = false } = {}) {
  if (!force && !systemKeepAwakeRequested) return;
  try {
    chrome.power?.releaseKeepAwake();
  } catch (err) {
    console.warn("releaseSystemKeepAwake:", err?.message || err);
  }
  systemKeepAwakeRequested = false;
}

function releaseSystemKeepAwakeIfIdle({ force = false } = {}) {
  if (scrapeState.running || rescanState.running) return false;
  releaseSystemKeepAwake({ force });
  return true;
}

function pingMapsTabWake(tabId) {
  if (!Number.isInteger(tabId)) return;
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

const MAPS_CONTENT_WAKE_INTERVAL_MS = 1000;

function startMapsContentWakePulse() {
  if (mapsContentWakeTimer) return;
  const tick = async () => {
    if (mapsContentWakeTickBusy) return;
    const hasCellWork = mapsCellWorkTokens.size > 0;
    const hasQuickEnrichWork =
      typeof quickEnrichWorkTokens !== "undefined" && quickEnrichWorkTokens.size > 0;
    const hasRescanWork = mapsRescanWorkTokens.size > 0;
    if (!hasCellWork && !hasQuickEnrichWork && !hasRescanWork) {
      stopMapsContentWakePulse();
      return;
    }
    const tabIds = hasCellWork
      ? [scrapeState.mapsTabId, scrapeState?.quickScan ? scrapeState.enrichTabId : null]
          .filter(Number.isInteger)
      : hasQuickEnrichWork && scrapeState.enrichTabId
        ? [scrapeState.enrichTabId]
        : hasRescanWork && rescanState.mapsTabId
          ? [rescanState.mapsTabId]
          : [];
    // Giữ timer khi tab đang được mở lại; tick sau sẽ tự dùng tab mới.
    if (!tabIds.length) return;
    mapsContentWakeTickBusy = true;
    try {
      await Promise.all(
        tabIds.map((tabId) =>
          chrome.tabs.sendMessage(tabId, { action: "KEEPALIVE_TICK" }).catch(() => null)
        )
      );
    } catch {
    } finally {
      mapsContentWakeTickBusy = false;
    }
  };
  tick().catch(() => {});
  mapsContentWakeTimer = setInterval(tick, MAPS_CONTENT_WAKE_INTERVAL_MS);
}

function stopMapsContentWakePulse() {
  if (!mapsContentWakeTimer) return;
  clearInterval(mapsContentWakeTimer);
  mapsContentWakeTimer = null;
}

function clearMapsCellListWorkTokens() {
  activeMapsCellListToken = null;
  scrapeState._mapsCellListActive = false;
  scrapeState._mapsCellListLease = null;
  clearMapsListInterruptionWarning();
}

function clearMapsCellWorkTokens() {
  mapsCellWorkTokens.clear();
  if (typeof quickEnrichWorkTokens !== "undefined") quickEnrichWorkTokens.clear();
  scrapeState._mapsCellWorkActive = false;
  clearMapsCellListWorkTokens();
  if (mapsRescanWorkTokens.size === 0) stopMapsContentWakePulse();
}

function clearMapsRescanWorkTokens() {
  mapsRescanWorkTokens.clear();
  if (
    mapsCellWorkTokens.size === 0 &&
    (typeof quickEnrichWorkTokens === "undefined" || quickEnrichWorkTokens.size === 0)
  ) {
    stopMapsContentWakePulse();
  }
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
    const currentWindow = await chrome.windows.get(tab.windowId).catch(() => null);
    const updateInfo = { focused: true };
    if (currentWindow?.state === "minimized") updateInfo.state = "normal";
    await chrome.windows.update(tab.windowId, updateInfo);
  }
  return tab;
}

function shouldWarnMapsListInterruption({ running, listActive, mapsTabId, activeTabId }) {
  return (
    running === true &&
    listActive === true &&
    Number.isInteger(mapsTabId) &&
    activeTabId !== mapsTabId
  );
}

function setMapsListInterruptionBadge(interrupted) {
  const badgeText = interrupted ? "!" : "";
  const title = interrupted
    ? "Đang lấy danh sách: hãy quay lại tab Google Maps"
    : "Mở tiện ích Findmap";
  chrome.action?.setBadgeBackgroundColor({ color: "#d97706" }).catch(() => {});
  chrome.action?.setBadgeText({ text: badgeText }).catch(() => {});
  chrome.action?.setTitle({ title }).catch(() => {});
}

function clearMapsListInterruptionWarning({ notifyWeb = true } = {}) {
  const hadWarning = Boolean(scrapeState._mapsListWarningKey);
  scrapeState._mapsListWarningKey = "";
  setMapsListInterruptionBadge(false);
  if (hadWarning && notifyWeb && currentSearch?.webUrl) {
    sendToWebPage(currentSearch.webUrl, "progress", {
      mapsTabHiddenDuringList: false,
      mergedCount: getFinalResultsList().length,
      searchParams: currentSearch
    }).catch(() => false);
  }
  return hadWarning;
}

function warnMapsListInterruption(activeTabId, source = "tab_hidden") {
  if (
    !shouldWarnMapsListInterruption({
      running: scrapeState.running,
      listActive: scrapeState._mapsCellListActive,
      mapsTabId: scrapeState.mapsTabId,
      activeTabId
    })
  ) {
    return false;
  }

  const lease = RunLease.normalize(scrapeState._mapsCellListLease) || getActiveCellLease();
  if (!lease || !RunLease.same(lease, getActiveCellLease())) return false;

  const warningKey = `${lease.runId}:${lease.cellGeneration}`;
  if (scrapeState._mapsListWarningKey === warningKey) return false;
  scrapeState._mapsListWarningKey = warningKey;
  setMapsListInterruptionBadge(true);

  const text =
    "Việc lấy danh sách địa điểm có thể bị gián đoạn khi tab Google Maps ở nền. " +
    "Hãy quay lại tab Google Maps để tiếp tục lấy đủ danh sách URL.";
  bgLog(`Cảnh báo tab Maps rời foreground trong pha lấy danh sách (${source}).`);
  notifyProgress(calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells), text, {
    mapsTabHiddenDuringList: true,
    warningCode: "MAPS_LIST_TAB_HIDDEN"
  });
  return true;
}

async function activateMapsTabForCellList() {
  const tabId = scrapeState.mapsTabId;
  if (!scrapeState.running || !Number.isInteger(tabId)) return false;
  try {
    await activateTabAndWindow(tabId);
    clearMapsListInterruptionWarning();
    await sleep(150);
    return true;
  } catch (err) {
    bgLog(`Không thể đưa tab Maps lên trước khi lấy danh sách: ${err.message}`);
    warnMapsListInterruption(null, "activate_failed");
    return false;
  }
}

async function warnIfMapsListNotForeground(source = "list_continuation") {
  const tabId = scrapeState.mapsTabId;
  if (!scrapeState.running || !Number.isInteger(tabId)) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    const mapsWindow = isValidWindowId(tab?.windowId)
      ? await chrome.windows.get(tab.windowId).catch(() => null)
      : null;
    const foreground =
      tab?.active === true &&
      mapsWindow?.focused === true &&
      mapsWindow?.state !== "minimized";
    if (!foreground) warnMapsListInterruption(null, source);
    return foreground;
  } catch (err) {
    bgLog(`Không kiểm tra được trạng thái tab Maps: ${err.message}`);
    warnMapsListInterruption(null, `${source}_check_failed`);
    return false;
  }
}

function shouldFocusMapsForRecovery({
  running,
  enabled,
  tabId,
  lastDataAt,
  lastRecoveryFocusDataAt,
  force = false,
  now = Date.now()
}) {
  const activityAt = Number(lastDataAt || 0);
  if (!running || !enabled || !Number.isInteger(tabId)) return false;
  if (force) return true;
  if (activityAt <= 0) return false;
  if (Number(lastRecoveryFocusDataAt || 0) >= activityAt) return false;
  return now - activityAt >= MAPS_STALL_FOCUS_MS;
}

function markMapsDataActivity(at = Date.now()) {
  lastScrapeProgressAt = Number(at) || Date.now();
  scrapeState._lastRecoveryFocusDataAt = 0;
}

function resetScrapePhaseStallClock(at = Date.now()) {
  lastScrapeProgressAt = Number(at) || Date.now();
  scrapeState._lastRecoveryFocusDataAt = 0;
  scrapeState._lastSoftRecoveryAt = 0;
}

function markRescanDataActivity(at = Date.now()) {
  rescanState._lastDataAt = Number(at) || Date.now();
  rescanState._lastRecoveryFocusDataAt = 0;
}

async function focusTabForRecovery(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const mapsWindow = isValidWindowId(tab?.windowId)
    ? await chrome.windows.get(tab.windowId).catch(() => null)
    : null;
  const alreadyForeground =
    tab?.active && mapsWindow?.focused === true && mapsWindow?.state !== "minimized";
  if (alreadyForeground) return false;
  await activateTabAndWindow(tabId);
  return true;
}

async function focusMapsTabForRecovery(reason, { force = false } = {}) {
  const activityAt = lastScrapeProgressAt || Date.now();
  if (
    !shouldFocusMapsForRecovery({
      running: scrapeState.running,
      enabled: isMapsAutoFocusEnabled(),
      tabId: scrapeState.mapsTabId,
      lastDataAt: activityAt,
      lastRecoveryFocusDataAt: scrapeState._lastRecoveryFocusDataAt,
      force
    })
  ) {
    return false;
  }

  scrapeState._lastRecoveryFocusDataAt = activityAt;
  try {
    const focused = await focusTabForRecovery(scrapeState.mapsTabId);
    if (focused) {
      notifyProgress(
        calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.25),
        reason || "Google Maps không phản hồi trong 5 phút. Findmap đã đưa tab lên trước để khôi phục."
      );
    }
    return focused;
  } catch (err) {
    scrapeState._lastRecoveryFocusDataAt = 0;
    console.warn("focusMapsTabForRecovery:", err.message);
    return false;
  }
}

function isRescanRecoveryFocusEnabled() {
  const value = rescanState.searchParams?.mapsAutoFocus ?? rescanState.params?.mapsAutoFocus;
  return value !== false;
}

async function focusRescanTabForRecovery(reason, { force = false } = {}) {
  const activityAt = rescanState._lastDataAt || Date.now();
  if (
    !shouldFocusMapsForRecovery({
      running: rescanState.running,
      enabled: isRescanRecoveryFocusEnabled(),
      tabId: rescanState.mapsTabId,
      lastDataAt: activityAt,
      lastRecoveryFocusDataAt: rescanState._lastRecoveryFocusDataAt,
      force
    })
  ) {
    return false;
  }

  rescanState._lastRecoveryFocusDataAt = activityAt;
  try {
    const focused = await focusTabForRecovery(rescanState.mapsTabId);
    if (focused && rescanState.webUrl) {
      await sendToWebPage(rescanState.webUrl, "rescan_progress", {
        done: rescanState.done,
        total: rescanState.total,
        percent: rescanState.total ? Math.round((rescanState.done / rescanState.total) * 100) : 0,
        name: "",
        info: reason || "Google Maps không phản hồi trong 5 phút. Findmap đã đưa tab lên trước để khôi phục."
      }).catch(() => {});
    }
    return focused;
  } catch (err) {
    rescanState._lastRecoveryFocusDataAt = 0;
    console.warn("focusRescanTabForRecovery:", err.message);
    return false;
  }
}

async function focusMapsTabAfterFailure(tabId, reason) {
  if (tabId === scrapeState.mapsTabId) {
    return focusMapsTabForRecovery(reason, { force: true });
  }
  if (tabId === scrapeState.enrichTabId) {
    try {
      return await focusTabForRecovery(tabId);
    } catch {
      return false;
    }
  }
  if (tabId === rescanState.mapsTabId) {
    return focusRescanTabForRecovery(reason, { force: true });
  }
  return false;
}

async function maybeFocusMapsTabForStall() {
  return focusMapsTabForRecovery(
    "Google Maps không trả tiến độ mới trong 5 phút. Findmap đã đưa tab lên trước để khôi phục."
  );
}

async function maybeFocusRescanTabForStall() {
  return focusRescanTabForRecovery(
    "Google Maps không trả dữ liệu mới trong 5 phút. Findmap đã đưa tab lên trước để khôi phục."
  );
}

async function maybeFocusMapsTabAfterStall(tabId) {
  if (tabId === rescanState.mapsTabId) return maybeFocusRescanTabForStall();
  if (tabId === scrapeState.mapsTabId) return maybeFocusMapsTabForStall();
  if (tabId === scrapeState.enrichTabId) {
    const activityAt = Number(scrapeState._enrichActivityAt || 0);
    if (
      !shouldFocusMapsForRecovery({
        running: scrapeState.running,
        enabled: isMapsAutoFocusEnabled(),
        tabId,
        lastDataAt: activityAt,
        lastRecoveryFocusDataAt: scrapeState._lastEnrichRecoveryFocusDataAt
      })
    ) {
      return false;
    }
    scrapeState._lastEnrichRecoveryFocusDataAt = activityAt;
    return focusTabForRecovery(tabId).catch(() => false);
  }
  return false;
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

/** Mỗi phiên sở hữu một tab Maps riêng; mặc định mở nền để không giành tab người dùng. */
async function openMapsScrapeTab(url) {
  const preferredWindowId = await getTabWindowId(scrapeState.webTabId);
  const tab = await createMapsTab(url, preferredWindowId, { active: false });
  scrapeState.mapsWindowId = tab.windowId;
  return tab;
}

async function openQuickEnrichTab(url) {
  const preferredWindowId =
    scrapeState.mapsWindowId || (await getTabWindowId(scrapeState.webTabId));
  const tab = await createMapsTab(url, preferredWindowId, { active: false });
  scrapeState.enrichTabId = tab.id;
  scrapeState.enrichWindowId = tab.windowId;
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
    }

    pingMapsTabWake(scrapeState.mapsTabId);
    await maybeFocusMapsTabForStall();
  }

  if (
    (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
    scrapeState.enrichTabId
  ) {
    await chrome.tabs
      .update(scrapeState.enrichTabId, { autoDiscardable: false })
      .catch(() => {});
    pingMapsTabWake(scrapeState.enrichTabId);
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
  const resumedParkedCell = await resumePendingGridContinuationIfReady().catch(() => false);
  if (!resumedParkedCell) maybeRecoverStalledScrape().catch(() => {});
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
    const [scrapeCheckpoint, rescanCheckpoint, pendingComplete] = await Promise.all([
      getScrapeCheckpoint(),
      getRescanCheckpoint(),
      getPendingComplete()
    ]);
    if (
      DurableLifecycle.shouldAutoResumeScrapeCheckpoint(scrapeCheckpoint) ||
      DurableLifecycle.isRecoverableRescanCheckpoint(rescanCheckpoint) ||
      isValidPendingComplete(pendingComplete)
    ) {
      await ensureDurableWorkAlarm();
      return;
    }
  } catch {}
  chrome.alarms.clear(DURABLE_WORK_ALARM);
}

function startScrapeKeepAlive() {
  requestSystemKeepAwake();
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
        if (rescanState.running) {
          await persistRescanCheckpoint();
          await maybeFocusRescanTabForStall();
        }
        await clearDurableWorkAlarmIfIdle();
      })
      .catch((err) => console.warn("durable watchdog:", err?.message || err));
  }
  if (alarm.name === MAPS_AUTO_FOCUS_ALARM) {
    ensureServiceReady("maps_auto_focus_alarm")
      .then(() => {
        if (scrapeState.running && isMapsAutoFocusEnabled()) return maybeFocusMapsTabForStall();
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
  const doneCells = (idx / totalCells) * 92;
  const withinSpan = 92 / totalCells;
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
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Google Maps tải quá lâu"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    }

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        finish();
      }
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) finish(new Error("Tab Google Maps đã bị đóng khi đang tải"));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // Re-check sau khi gắn listener để không bỏ lỡ sự kiện complete giữa tabs.get và addListener.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch(() => finish(new Error("Không tìm thấy tab Google Maps đang tải")));
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

async function getPendingComplete() {
  const data = await chrome.storage.local.get(PENDING_COMPLETE_KEY);
  return data[PENDING_COMPLETE_KEY] || null;
}

function buildPendingCompleteMetadata(payload) {
  if (!payload || typeof payload !== "object") return null;
  const { results, searchParams, ...metadata } = payload;
  return metadata;
}

function buildPendingCompleteMarker(searchId) {
  return {
    version: PENDING_COMPLETE_VERSION,
    source: SCRAPE_CHECKPOINT_KEY,
    searchId: String(searchId || ""),
    savedAt: Date.now()
  };
}

function isCompactPendingComplete(pending) {
  return Boolean(
    pending?.version === PENDING_COMPLETE_VERSION &&
      pending?.source === SCRAPE_CHECKPOINT_KEY &&
      pending?.searchId
  );
}

function isLegacyPendingComplete(pending) {
  return Boolean(pending?.searchParams?.webUrl && Array.isArray(pending?.results));
}

function isValidPendingComplete(pending) {
  return isCompactPendingComplete(pending) || isLegacyPendingComplete(pending);
}

function materializeCompletePayloadFromCheckpoint(checkpoint, pending) {
  if (!checkpoint?.searchParams?.webUrl || !Array.isArray(checkpoint.mergedPlaces)) return null;
  const searchId = String(checkpoint.searchParams.searchId || "");
  if (pending?.searchId && searchId && String(pending.searchId) !== searchId) return null;

  const results = checkpoint.mergedPlaces;
  const metadata = checkpoint.pendingCompletion || {};
  return {
    ...metadata,
    results,
    searchParams: {
      ...checkpoint.searchParams,
      gridCells: checkpoint.totalCells,
      uniqueResults: results.length
    },
    total: Number(metadata.total ?? results.length),
    totalFound: Number(metadata.totalFound ?? results.length),
    uniquePhoneCount: Number(metadata.uniquePhoneCount ?? countResultsWithPhone(results))
  };
}

async function persistPendingComplete(pending) {
  if (!isValidPendingComplete(pending)) return false;
  try {
    await chrome.storage.local.set({ [PENDING_COMPLETE_KEY]: pending });
    await ensureDurableWorkAlarm();
    return true;
  } catch (err) {
    console.warn("persistPendingComplete:", err?.message || err);
    return false;
  }
}

async function clearPendingComplete() {
  try {
    await chrome.storage.local.remove(PENDING_COMPLETE_KEY);
  } catch {}
}

async function preparePendingComplete(payload) {
  if (!isLegacyPendingComplete(payload)) return false;

  // pendingSearchSync cũng chứa full results; bỏ bản sao này trước khi ghi snapshot cuối.
  await clearPendingSearchSync();
  scrapeState.mergedPlaces = placesToMap(payload.results);
  scrapeState.phase = "pending_complete";
  scrapeState.running = false;
  scrapeState._pendingCompletion = buildPendingCompleteMetadata(payload);

  const snapshotSaved = await persistScrapeCheckpoint({ forceRecoverable: true });
  if (!snapshotSaved) {
    await ensureDurableWorkAlarm();
    return false;
  }

  return persistPendingComplete(buildPendingCompleteMarker(payload.searchParams.searchId));
}

async function flushPendingComplete(reason = "service_wake") {
  let pending = await getPendingComplete();
  let checkpoint = null;

  // Worker có thể chết sau khi ghi snapshot nhưng trước marker; tái tạo marker từ checkpoint.
  if (!pending) {
    checkpoint = await getScrapeCheckpoint().catch(() => null);
    if (
      checkpoint?.phase === "pending_complete" &&
      checkpoint?.pendingCompletion &&
      checkpoint?.searchParams?.searchId
    ) {
      pending = buildPendingCompleteMarker(checkpoint.searchParams.searchId);
      const markerSaved = await persistPendingComplete(pending);
      if (!markerSaved) return { pending: true, delivered: false };
    }
  }

  if (!pending) return { pending: false, delivered: false };
  if (!isValidPendingComplete(pending)) {
    await clearPendingComplete();
    return { pending: false, delivered: false };
  }

  let payload = pending;
  if (isCompactPendingComplete(pending)) {
    checkpoint = checkpoint || (await getScrapeCheckpoint().catch(() => null));
    payload = materializeCompletePayloadFromCheckpoint(checkpoint, pending);
    if (!payload) {
      console.warn(`TimDiemBan: marker hoàn tất chưa đọc được checkpoint (${reason}).`);
      await ensureDurableWorkAlarm();
      return { pending: true, delivered: false };
    }
  }
  checkpoint = checkpoint || (await getScrapeCheckpoint().catch(() => null));

  if (checkpoint?.mapsTabId) {
    await chrome.tabs.remove(checkpoint.mapsTabId).catch(() => {});
  }
  if (checkpoint?.enrichTabId && checkpoint.enrichTabId !== checkpoint.mapsTabId) {
    await chrome.tabs.remove(checkpoint.enrichTabId).catch(() => {});
  }

  const delivered = await sendToWebPage(
    payload.searchParams.webUrl,
    "complete",
    payload
  ).catch(() => false);
  if (!delivered) {
    console.warn(`TimDiemBan: chưa giao được kết quả hoàn tất (${reason}).`);
    await ensureDurableWorkAlarm();
    return { pending: true, delivered: false };
  }

  await clearPendingComplete();
  await clearScrapeCheckpoint();
  await chrome.storage.local.remove(["activeSearch"]).catch(() => {});
  return { pending: false, delivered: true };
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

function bgLog(line) {
  const text = `[BG] ${line}`;
  console.log("TimDiemBan:", text);
}

function notifyProgress(percent, text, extra = {}) {
  chrome.runtime.sendMessage({ action: "SEARCH_PROGRESS", percent, text }).catch(() => {});
  // Luôn đẩy overlay Maps — tránh UI kẹt text cũ trong khi vẫn scrape/gửi kết quả
  updateMapsShield(text, percent);
  if (currentSearch?.webUrl) {
    return sendToWebPage(currentSearch.webUrl, "progress", {
      percent,
      text,
      mergedCount: getFinalResultsList().length,
      searchParams: currentSearch,
      ...extra
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
        if (tab?.status === "complete") {
          const quickScan =
            scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true;
          if (!quickScan) return true;
          if (!scrapeState.enrichTabId) {
            await sleep(250);
            continue;
          }
          const enrichTab = await chrome.tabs.get(scrapeState.enrichTabId);
          if (enrichTab?.status === "complete") return true;
        }
      } catch {
        return false;
      }
    }
    await sleep(250);
  }
  return Boolean(
    scrapeState.mapsTabId &&
      (!(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) ||
        scrapeState.enrichTabId)
  );
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

function getPendingCellPlaces(cellIndex) {
  if (Number(scrapeState.pendingCellIndex) !== Number(cellIndex)) return [];
  return Array.from(scrapeState.pendingCellPlaces.values());
}

function stagePendingCellPlaces(cellIndex, places) {
  if (Number(scrapeState.pendingCellIndex) !== Number(cellIndex)) {
    scrapeState.pendingCellIndex = Number(cellIndex);
    scrapeState.pendingCellPlaces = new Map();
  }
  const combined = dedupePlaces([
    ...scrapeState.pendingCellPlaces.values(),
    ...(Array.isArray(places) ? places : [])
  ]);
  scrapeState.pendingCellPlaces = placesToMap(combined);
  return combined;
}

function clearPendingCellPlaces(cellIndex = null) {
  if (cellIndex != null && Number(scrapeState.pendingCellIndex) !== Number(cellIndex)) return;
  scrapeState.pendingCellPlaces = new Map();
  scrapeState.pendingCellIndex = -1;
}

function updateCellListProgress(cellIndex, result = {}) {
  const progressByCell = scrapeState._cellListProgress || (scrapeState._cellListProgress = {});
  const previous = progressByCell[cellIndex] || {
    urlCount: 0,
    scrollTop: 0,
    scrollHeight: 0,
    lastItemKey: "",
    noGrowthMs: 0
  };
  const urlCount = getPendingCellPlaces(cellIndex).length;
  const scrollTop = Math.max(0, Number(result.scrollTop) || 0);
  const scrollHeight = Math.max(0, Number(result.scrollHeight) || 0);
  const lastItemKey = String(result.lastItemKey || "");
  const urlGrew =
    urlCount > Number(previous.urlCount || 0) || Number(result.stagedNewPlacesCount || 0) > 0;
  const scrollGrew =
    scrollTop > Number(previous.scrollTop || 0) + CELL_LIST_SCROLL_GROWTH_PX ||
    scrollHeight > Number(previous.scrollHeight || 0) + CELL_LIST_SCROLL_GROWTH_PX ||
    Boolean(lastItemKey && lastItemKey !== previous.lastItemKey);
  const grew = urlGrew || scrollGrew;
  const elapsedMs = Math.max(0, Number(result.activeElapsedMs ?? result.elapsedMs) || 0);
  const suspendGapMs = Math.max(0, Number(result.suspendGapMs) || 0);
  const reportedActiveElapsedMs = result.activeElapsedMs == null
    ? Math.max(0, elapsedMs - suspendGapMs)
    : elapsedMs;
  const sincePreviousUpdateMs = previous.updatedAt
    ? Math.max(0, Date.now() - Number(previous.updatedAt))
    : reportedActiveElapsedMs;
  const activeElapsedMs = Math.min(reportedActiveElapsedMs, sincePreviousUpdateMs);
  const state = {
    urlCount: Math.max(urlCount, Number(previous.urlCount || 0)),
    scrollTop: Math.max(scrollTop, Number(previous.scrollTop || 0)),
    scrollHeight: Math.max(scrollHeight, Number(previous.scrollHeight || 0)),
    lastItemKey: lastItemKey || previous.lastItemKey || "",
    noGrowthMs: grew
      ? 0
      : Number(previous.noGrowthMs || 0) + Math.min(activeElapsedMs, CELL_LIST_TIMEOUT_MS),
    updatedAt: Date.now()
  };
  progressByCell[cellIndex] = state;
  return {
    ...state,
    grew,
    urlGrew,
    scrollGrew,
    activeElapsedMs,
    suspendGapMs,
    resumeFromCurrent: result.resumeFromCurrent !== false
  };
}

function clearCellListProgress(cellIndex) {
  if (scrapeState._cellListProgress) delete scrapeState._cellListProgress[cellIndex];
}

function getMergedPlaceCanonicalId(place) {
  return String(
    place?.googlePlaceId || getCanonicalPlaceId(place?.mapsUrl || place?.href || "") || ""
  ).toLowerCase();
}

function addMergedPlaceLookupBucket(bucketMap, value, record) {
  if (!value) return;
  let bucket = bucketMap.get(value);
  if (!bucket) {
    bucket = new Set();
    bucketMap.set(value, bucket);
  }
  bucket.add(record);
}

function removeMergedPlaceLookupBucket(bucketMap, value, record) {
  if (!value) return;
  const bucket = bucketMap.get(value);
  if (!bucket) return;
  bucket.delete(record);
  if (!bucket.size) bucketMap.delete(value);
}

function indexMergedPlaceRecord(key, record) {
  if (!mergedPlaceLookupIndex || !record) return;
  const metadata = {
    key,
    canonicalId: getMergedPlaceCanonicalId(record),
    phone: normalizePhone(record.phone),
    name: normalizeName(record.name),
    address: normalizeAddress(record.address)
  };
  mergedPlaceLookupIndex.metadataByRecord.set(record, metadata);
  addMergedPlaceLookupBucket(
    mergedPlaceLookupIndex.byCanonicalId,
    metadata.canonicalId,
    record
  );
  if (metadata.phone.length >= 9) {
    addMergedPlaceLookupBucket(mergedPlaceLookupIndex.byPhone, metadata.phone, record);
    if (metadata.name) {
      addMergedPlaceLookupBucket(
        mergedPlaceLookupIndex.byNamePhone,
        `${metadata.name}|${metadata.phone}`,
        record
      );
    }
  }
  addMergedPlaceLookupBucket(mergedPlaceLookupIndex.byName, metadata.name, record);
  if (metadata.name && metadata.address.length > 10) {
    addMergedPlaceLookupBucket(
      mergedPlaceLookupIndex.byNameAddress,
      `${metadata.name}|${metadata.address}`,
      record
    );
  }
}

function unindexMergedPlaceRecord(record) {
  const index = mergedPlaceLookupIndex;
  const metadata = index?.metadataByRecord.get(record);
  if (!metadata) return;
  removeMergedPlaceLookupBucket(index.byCanonicalId, metadata.canonicalId, record);
  removeMergedPlaceLookupBucket(index.byPhone, metadata.phone, record);
  removeMergedPlaceLookupBucket(
    index.byNamePhone,
    metadata.name && metadata.phone.length >= 9 ? `${metadata.name}|${metadata.phone}` : "",
    record
  );
  removeMergedPlaceLookupBucket(index.byName, metadata.name, record);
  removeMergedPlaceLookupBucket(
    index.byNameAddress,
    metadata.name && metadata.address.length > 10
      ? `${metadata.name}|${metadata.address}`
      : "",
    record
  );
  index.metadataByRecord.delete(record);
}

function rebuildMergedPlaceLookupIndex() {
  mergedPlaceLookupIndex = {
    source: scrapeState.mergedPlaces,
    indexedSize: 0,
    byCanonicalId: new Map(),
    byPhone: new Map(),
    byName: new Map(),
    byNamePhone: new Map(),
    byNameAddress: new Map(),
    metadataByRecord: new WeakMap()
  };
  for (const [key, record] of scrapeState.mergedPlaces.entries()) {
    indexMergedPlaceRecord(key, record);
  }
  mergedPlaceLookupIndex.indexedSize = scrapeState.mergedPlaces.size;
  return mergedPlaceLookupIndex;
}

function ensureMergedPlaceLookupIndex() {
  if (
    !mergedPlaceLookupIndex ||
    mergedPlaceLookupIndex.source !== scrapeState.mergedPlaces ||
    mergedPlaceLookupIndex.indexedSize !== scrapeState.mergedPlaces.size
  ) {
    return rebuildMergedPlaceLookupIndex();
  }
  return mergedPlaceLookupIndex;
}

function syncMergedPlaceLookupSize() {
  if (mergedPlaceLookupIndex?.source === scrapeState.mergedPlaces) {
    mergedPlaceLookupIndex.indexedSize = scrapeState.mergedPlaces.size;
  }
}

function addRankedMergedPlaceCandidate(candidates, candidate) {
  candidates.push(candidate);
  candidates.sort((a, b) => a.rank - b.rank);
  if (candidates.length > MERGED_PLACE_NEAR_DUPLICATE_CANDIDATE_LIMIT) {
    candidates.pop();
  }
}

function findMergedPlaceEntry(place, excludeRecord = null) {
  const index = ensureMergedPlaceLookupIndex();
  const directKey = getDedupeKey(place);
  const directRecord = scrapeState.mergedPlaces.get(directKey);
  if (directRecord && directRecord !== excludeRecord) {
    return { key: directKey, record: directRecord };
  }

  const canonicalId = getMergedPlaceCanonicalId(place);
  const phone = normalizePhone(place?.phone);
  const name = normalizeName(place?.name);
  const address = normalizeAddress(place?.address);
  const coords = resolvePlaceCoords(place || {});
  const candidateRecords = new Set();
  const candidates = [];

  const appendBucket = (bucket) => {
    if (!bucket) return;
    for (const record of bucket) {
      if (candidateRecords.size >= MERGED_PLACE_NEAR_DUPLICATE_CANDIDATE_LIMIT) break;
      if (!record || record === excludeRecord) continue;
      candidateRecords.add(record);
    }
  };
  appendBucket(index.byCanonicalId.get(canonicalId));
  if (name && phone.length >= 9) {
    appendBucket(index.byNamePhone.get(`${name}|${phone}`));
  }
  if (name && address.length > 10) {
    appendBucket(index.byNameAddress.get(`${name}|${address}`));
  }
  if (phone.length >= 9) appendBucket(index.byPhone.get(phone));
  appendBucket(index.byName.get(name));

  for (const record of candidateRecords) {
    const metadata = index.metadataByRecord.get(record) || {};
    const key = metadata.key || getDedupeKey(record);

    const recordKey = getDedupeKey(record);
    if (recordKey === directKey) return { key, record };

    const recordCanonicalId = metadata.canonicalId || getMergedPlaceCanonicalId(record);
    if (canonicalId && recordCanonicalId === canonicalId) return { key, record };

    const recordPhone = metadata.phone || normalizePhone(record.phone);
    const recordName = metadata.name || normalizeName(record.name);
    const samePhone = phone.length >= 9 && phone === recordPhone;
    const sameName = Boolean(name && name === recordName);
    if (!samePhone && !sameName) continue;

    let rank = samePhone && sameName ? 4 : samePhone ? 12 : 20;
    if (sameName && address.length > 10 && address === normalizeAddress(record.address)) {
      rank = 1;
    }

    const recordCoords = coords ? resolvePlaceCoords(record) : null;
    if (coords && recordCoords) {
      const distanceKm = haversineKm(coords.lat, coords.lng, recordCoords.lat, recordCoords.lng);
      if (samePhone && distanceKm < 0.12) rank = Math.min(rank, 2 + distanceKm);
      if (sameName && distanceKm < 0.25) rank = Math.min(rank, 3 + distanceKm);
    }

    addRankedMergedPlaceCandidate(candidates, { key, record, rank });
  }

  return candidates.find(({ record }) => isNearDuplicate(record, place)) || null;
}

function storeMergedPlaceRecord(entry) {
  const { key: previousKey = "" } = entry;
  let { record } = entry;
  unindexMergedPlaceRecord(record);
  if (previousKey && scrapeState.mergedPlaces.get(previousKey) === record) {
    scrapeState.mergedPlaces.delete(previousKey);
  }

  // Chỉ xử lý va chạm khóa phát sinh từ record vừa merge, không rebuild toàn bộ Map.
  for (let pass = 0; pass < 3; pass++) {
    const key = getDedupeKey(record);
    const collision = scrapeState.mergedPlaces.get(key);
    if (!collision || collision === record) {
      scrapeState.mergedPlaces.set(key, record);
      indexMergedPlaceRecord(key, record);
      syncMergedPlaceLookupSize();
      return { key, record };
    }
    unindexMergedPlaceRecord(collision);
    scrapeState.mergedPlaces.delete(key);
    mergePlaceRecord(collision, record);
    record = collision;
  }

  const key = getDedupeKey(record);
  scrapeState.mergedPlaces.set(key, record);
  indexMergedPlaceRecord(key, record);
  syncMergedPlaceLookupSize();
  return { key, record };
}

function upsertMergedPlace(place) {
  const params = scrapeState.searchParams;
  if (!params || !place || !isValidPlaceName(place.name)) return null;
  const cell = scrapeState.gridPoints[scrapeState.gridIndex] || {};
  const mapLat = cell.lat ?? params.lat;
  const mapLng = cell.lng ?? params.lng;

  let match = findMergedPlaceEntry(place);
  let record = match?.record || null;

  if (record) {
    mergePlaceRecord(record, place);
  } else {
    const sanitized =
      sanitizePlace(place, params.lat, params.lng, params.radius, mapLat, mapLng) ||
      sanitizeFromList(place, params.lat, params.lng, params.radius, mapLat, mapLng, true);
    record = sanitized || { ...place };
    match = findMergedPlaceEntry(record);
    if (match) {
      mergePlaceRecord(match.record, record);
      record = match.record;
    }
  }

  const shouldRecheckNearDuplicate = Boolean(match && match.key !== getDedupeKey(record));
  let stored = storeMergedPlaceRecord({ key: match?.key || "", record });
  if (shouldRecheckNearDuplicate) {
    for (let pass = 0; pass < 2; pass++) {
      const duplicate = findMergedPlaceEntry(stored.record, stored.record);
      if (!duplicate) break;
      unindexMergedPlaceRecord(stored.record);
      scrapeState.mergedPlaces.delete(stored.key);
      mergePlaceRecord(duplicate.record, stored.record);
      stored = storeMergedPlaceRecord(duplicate);
    }
  }
  return stored.record;
}

async function persistScrapeCheckpoint({ forceRecoverable = false } = {}) {
  if (!scrapeState.searchParams) return;
  const running = scrapeState.running || scrapeState.paused || scrapeState.mergedPlaces.size > 0;
  if (!running) return;
  const durableSearchParams = toDurableSearchParams(scrapeState.searchParams);
  const now = Date.now();
  const completionPending =
    scrapeState.phase === "pending_complete" && Boolean(scrapeState._pendingCompletion);
  const checkpoint = {
    version: DurableLifecycle.CHECKPOINT_VERSION,
    cellFlowVersion: CELL_FLOW_VERSION,
    running: forceRecoverable || completionPending || scrapeState.running || scrapeState.paused,
    paused: scrapeState.paused === true,
    pausedAt: Number(scrapeState.pausedAt || 0),
    pauseReason: String(scrapeState.pauseReason || ""),
    resumeRequestedAt: Number(scrapeState.resumeRequestedAt || 0),
    runId: scrapeState.runId,
    cellGeneration: scrapeState.cellGeneration,
    lastHeartbeat: now,
    savedAt: now,
    lastProgressAt: lastScrapeProgressAt || now,
    lastRecoveryFocusDataAt: Number(scrapeState._lastRecoveryFocusDataAt || 0),
    lastEnrichRecoveryFocusDataAt: Number(scrapeState._lastEnrichRecoveryFocusDataAt || 0),
    gridIndex: scrapeState.gridIndex,
    totalCells: scrapeState.totalCells,
    completedCells: [...scrapeState.completedCells],
    enrichedPlaceKeys: [...scrapeState.enrichedPlaceKeys],
    failedEnrichKeys: [...scrapeState.failedEnrichKeys],
    pendingCompletion: scrapeState._pendingCompletion,
    enrichTotal: Number(scrapeState.enrichTotal || 0),
    activeEnrichOpId: String(scrapeState._activeEnrichOpId || ""),
    enrichActivityAt: Number(scrapeState._enrichActivityAt || 0),
    enrichGeneration: Number(scrapeState._enrichGeneration || 0),
    phase: scrapeState.phase,
    quickScan: scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true,
    quickProducerDone: scrapeState.quickProducerDone === true,
    searchParams: durableSearchParams,
    cellSizeKm: scrapeState.cellSizeKm,
    viewportM: scrapeState.viewportM,
    gridPoints: scrapeState.gridPoints,
    mergedPlaces: Array.from(scrapeState.mergedPlaces.values()),
    pendingCellPlaces: Array.from(scrapeState.pendingCellPlaces.values()),
    pendingCellIndex: Number(scrapeState.pendingCellIndex),
    retriedCells: [...(scrapeState._retriedCells || [])],
    cellRetryCounts: { ...(scrapeState._cellRetryCounts || {}) },
    cellRecoveryCounts: { ...(scrapeState._cellRecoveryCounts || {}) },
    cellContinueFlags: { ...(scrapeState._cellContinueFlags || {}) },
    cellRestartFlags: { ...(scrapeState._cellRestartFlags || {}) },
    cellResumeLeases: { ...(scrapeState._cellResumeLeases || {}) },
    pendingGridContinuation: Number(scrapeState._pendingGridContinuation ?? -1),
    cellListProgress: { ...(scrapeState._cellListProgress || {}) },
    mapsReopenCount: Number(scrapeState._mapsReopenCount || 0),
    mapsUserReloadCount: Number(scrapeState._mapsUserReloadCount || 0),
    webTabId: scrapeState.webTabId,
    mapsTabId: scrapeState.mapsTabId,
    mapsWindowId: scrapeState.mapsWindowId,
    enrichTabId: scrapeState.enrichTabId,
    enrichWindowId: scrapeState.enrichWindowId,
    enrichMapsReopenCount: Number(scrapeState._enrichMapsReopenCount || 0)
  };

  return enqueueCheckpointMutation("scrape", async () => {
    try {
      await chrome.storage.local.set({
        [SCRAPE_CHECKPOINT_KEY]: checkpoint,
        activeSearch: durableSearchParams
      });
      return true;
    } catch (err) {
      console.warn("persistScrapeCheckpoint:", err.message);
      return false;
    }
  });
}

function restoreScrapeStateFromCheckpoint(cp) {
  if (!cp?.searchParams) return false;
  const hasPerCellEnrich = Number(cp.cellFlowVersion || 0) >= PER_CELL_ENRICH_FLOW_VERSION;
  const hasChunkedCellList = Number(cp.cellFlowVersion || 0) >= CELL_FLOW_VERSION;
  scrapeState.searchParams = cp.searchParams;
  scrapeState.paused = cp.paused === true;
  scrapeState.pausedAt = Number(cp.pausedAt || 0);
  scrapeState.pauseReason = String(cp.pauseReason || "");
  scrapeState.resumeRequestedAt = Number(cp.resumeRequestedAt || 0);
  scrapeState.runId = String(cp.runId || cp.searchParams.searchId || "");
  scrapeState.cellGeneration = Number(cp.cellGeneration || 0);
  scrapeState.webTabId = cp.webTabId ?? null;
  scrapeState.mapsTabId = cp.mapsTabId ?? null;
  scrapeState.mapsWindowId = cp.mapsWindowId ?? null;
  scrapeState.enrichTabId = cp.enrichTabId ?? null;
  scrapeState.enrichWindowId = cp.enrichWindowId ?? null;
  scrapeState.gridPoints = cp.gridPoints || [];
  scrapeState.gridIndex = hasPerCellEnrich ? cp.gridIndex || 0 : 0;
  scrapeState.totalCells = cp.totalCells || 0;
  scrapeState.cellSizeKm = cp.cellSizeKm;
  scrapeState.viewportM = cp.viewportM;
  scrapeState.phase = hasPerCellEnrich ? cp.phase || "grid" : "grid";
  scrapeState.quickScan = cp.quickScan === true || cp.searchParams?.quickScan === true;
  scrapeState.quickProducerDone = scrapeState.quickScan && cp.quickProducerDone === true;
  scrapeState.completedCells = new Set(hasPerCellEnrich ? cp.completedCells || [] : []);
  scrapeState.enrichedPlaceKeys = new Set(hasPerCellEnrich ? cp.enrichedPlaceKeys || [] : []);
  scrapeState.failedEnrichKeys = new Set(hasPerCellEnrich ? cp.failedEnrichKeys || [] : []);
  scrapeState._pendingCompletion = cp.pendingCompletion || null;
  scrapeState.enrichTotal = hasPerCellEnrich ? Number(cp.enrichTotal || 0) : 0;
  scrapeState.mergedPlaces = placesToMap(cp.mergedPlaces || []);
  scrapeState.pendingCellPlaces = placesToMap(
    hasChunkedCellList ? cp.pendingCellPlaces || [] : []
  );
  scrapeState.pendingCellIndex = hasChunkedCellList ? Number(cp.pendingCellIndex ?? -1) : -1;
  scrapeState._retriedCells = new Set(cp.retriedCells || []);
  scrapeState._cellRetryCounts = { ...(cp.cellRetryCounts || {}) };
  scrapeState._cellRecoveryCounts = { ...(cp.cellRecoveryCounts || {}) };
  scrapeState._cellContinueFlags = {
    ...(hasChunkedCellList ? cp.cellContinueFlags || {} : {})
  };
  scrapeState._cellRestartFlags = {
    ...(hasChunkedCellList ? cp.cellRestartFlags || {} : {})
  };
  scrapeState._cellListProgress = {
    ...(hasChunkedCellList ? cp.cellListProgress || {} : {})
  };
  scrapeState._cellResumeLeases = {
    ...(hasChunkedCellList ? cp.cellResumeLeases || {} : {})
  };
  scrapeState._pendingGridContinuation = Number(cp.pendingGridContinuation ?? -1);
  const restoredCellIndex = Number(scrapeState.gridIndex);
  const restoredProgress = scrapeState._cellListProgress?.[restoredCellIndex] || {};
  const hasPendingPlacesForCell =
    Number(scrapeState.pendingCellIndex) === restoredCellIndex &&
    scrapeState.pendingCellPlaces.size > 0;
  const hasScrollEvidence =
    Number(restoredProgress.scrollTop || 0) > 0 ||
    Number(restoredProgress.scrollHeight || 0) > 0 ||
    Boolean(restoredProgress.lastItemKey);
  const hasRestoredListEvidence =
    scrapeState.phase === "grid" &&
    !scrapeState.completedCells.has(restoredCellIndex) &&
    (scrapeState._cellContinueFlags[restoredCellIndex] === true ||
      scrapeState._cellRestartFlags[restoredCellIndex] === true ||
      hasPendingPlacesForCell ||
      hasScrollEvidence);
  if (hasRestoredListEvidence) {
    scrapeState._cellContinueFlags[restoredCellIndex] = true;
    scrapeState._pendingGridContinuation = restoredCellIndex;
    if (!scrapeState._cellResumeLeases[restoredCellIndex]) {
      scrapeState._cellResumeLeases[restoredCellIndex] = {
        runId: scrapeState.runId,
        cellGeneration: scrapeState.cellGeneration
      };
    }
  }
  activeMapsCellListToken = null;
  scrapeState._mapsCellListActive = false;
  scrapeState._mapsCellListLease = null;
  scrapeState._mapsListWarningKey = "";
  scrapeState._mapsReopenCount = Number(cp.mapsReopenCount || 0);
  scrapeState._mapsUserReloadCount = Number(cp.mapsUserReloadCount || 0);
  scrapeState._enrichMapsReopenCount = Number(cp.enrichMapsReopenCount || 0);
  scrapeState._activeEnrichOpId = "";
  scrapeState._enrichActivityAt = Number(cp.enrichActivityAt || cp.lastProgressAt || 0);
  scrapeState._enrichGeneration = Number(cp.enrichGeneration || 0) + 1;
  scrapeState._scheduledCellRetry = "";
  currentSearch = { ...cp.searchParams, gridCells: cp.totalCells };
  lastScrapeProgressAt = cp.lastProgressAt || cp.lastHeartbeat || Date.now();
  scrapeState._lastRecoveryFocusDataAt = Number(cp.lastRecoveryFocusDataAt || 0);
  scrapeState._lastEnrichRecoveryFocusDataAt = Number(cp.lastEnrichRecoveryFocusDataAt || 0);
  return true;
}

function nextPendingCellFromScrapeState() {
  return DurableLifecycle.nextPendingCell({
    totalCells: scrapeState.totalCells,
    gridIndex: scrapeState.gridIndex,
    completedCells: [...scrapeState.completedCells]
  });
}

async function clearScrapeCheckpoint() {
  return enqueueCheckpointMutation("scrape", async () => {
    try {
      await chrome.storage.local.remove([SCRAPE_CHECKPOINT_KEY]);
    } catch {}
  });
}

async function getScrapeCheckpoint() {
  await scrapeCheckpointQueue.catch(() => {});
  const data = await chrome.storage.local.get(SCRAPE_CHECKPOINT_KEY);
  return data[SCRAPE_CHECKPOINT_KEY] || null;
}

async function hasPendingScrapeCompletion() {
  const [checkpoint, pending] = await Promise.all([
    getScrapeCheckpoint().catch(() => null),
    getPendingComplete().catch(() => null)
  ]);
  return Boolean(
    isValidPendingComplete(pending) ||
      (checkpoint?.phase === "pending_complete" && checkpoint?.pendingCompletion)
  );
}

async function recoverStalledEnrich(idleMs) {
  if (
    !scrapeState.running ||
    scrapeState.phase !== "enrich" ||
    !scrapeState.mapsTabId ||
    enrichWatchdogBusy
  ) {
    return false;
  }

  enrichWatchdogBusy = true;
  const observedRunId = scrapeState.runId;
  const observedCellIndex = scrapeState.gridIndex;
  const observedGeneration = Number(scrapeState._enrichGeneration || 0);
  const observedActivityAt = Number(scrapeState._enrichActivityAt || 0);
  const observedTabId = scrapeState.mapsTabId;
  const staleTask = enrichRunPromise;
  const stillOwnsObservedEnrich = () =>
    scrapeState.running &&
    scrapeState.runId === observedRunId &&
    scrapeState.phase === "enrich" &&
    scrapeState.gridIndex === observedCellIndex &&
    Number(scrapeState._enrichGeneration || 0) === observedGeneration &&
    Number(scrapeState._enrichActivityAt || 0) <= observedActivityAt &&
    scrapeState.mapsTabId === observedTabId &&
    enrichRunPromise === staleTask;
  try {
    await maybeFocusMapsTabForStall();
    if (!stillOwnsObservedEnrich()) return false;

    const recoveryGeneration = observedGeneration + 1;
    scrapeState._enrichGeneration = recoveryGeneration;
    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    const stillOwnsRecovery = () =>
      scrapeState.running &&
      scrapeState.runId === observedRunId &&
      scrapeState.phase === "enrich" &&
      scrapeState.gridIndex === observedCellIndex &&
      Number(scrapeState._enrichGeneration || 0) === recoveryGeneration &&
      scrapeState.mapsTabId === observedTabId &&
      (enrichRunPromise === staleTask || enrichRunPromise === null);
    if (!stillOwnsRecovery()) return false;

    bgLog(
      `ENRICH WATCHDOG kích hoạt · idle ${Math.round(idleMs / 1000)}s · ô ${observedCellIndex + 1}`
    );

    const cancellation = await cancelActiveEnrichOperation({ timeoutMs: 5000 });
    if (!stillOwnsRecovery()) return false;
    if (!cancellation.reloaded) {
      await reloadMapsAfterUnsettledEnrich(scrapeState.mapsTabId);
    }
    if (!stillOwnsRecovery()) return false;
    if (enrichRunPromise === staleTask) enrichRunPromise = null;
    scrapeState._activeEnrichOpId = "";
    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    if (!stillOwnsRecovery()) return false;

    notifyProgress(
      calcProgressPercent(observedCellIndex, scrapeState.totalCells, 0.55),
      `Khu vực ${observedCellIndex + 1}/${scrapeState.totalCells} · Google Maps bị treo khi đọc chi tiết. Findmap đang tiếp tục từ URL chưa xử lý…`
    );
    runEnrichPhase().catch(async (err) => {
      if (scrapeState.running && !pointsFinalized) {
        await abortSearch("ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
    return true;
  } finally {
    enrichWatchdogBusy = false;
  }
}

async function recoverStalledQuickEnrich(idleMs) {
  if (
    !scrapeState.running ||
    !(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) ||
    !scrapeState.enrichTabId ||
    getQuickPendingEnrichPlaces().length === 0 ||
    quickEnrichWatchdogBusy
  ) {
    return false;
  }

  quickEnrichWatchdogBusy = true;
  const observedRunId = scrapeState.runId;
  const observedTabId = scrapeState.enrichTabId;
  const observedGeneration = Number(scrapeState._enrichGeneration || 0);
  const observedActivityAt = Number(scrapeState._enrichActivityAt || 0);
  const staleTask = quickEnrichRunPromise;
  const stillOwnsObservedQuickEnrich = () =>
    scrapeState.running &&
    scrapeState.runId === observedRunId &&
    (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
    scrapeState.enrichTabId === observedTabId &&
    Number(scrapeState._enrichGeneration || 0) === observedGeneration &&
    Number(scrapeState._enrichActivityAt || 0) <= observedActivityAt &&
    quickEnrichRunPromise === staleTask;
  try {
    await maybeFocusMapsTabAfterStall(observedTabId);
    if (!stillOwnsObservedQuickEnrich()) return false;

    const recoveryGeneration = observedGeneration + 1;
    scrapeState._enrichGeneration = recoveryGeneration;
    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    const stillOwnsQuickRecovery = () =>
      scrapeState.running &&
      scrapeState.runId === observedRunId &&
      (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
      scrapeState.enrichTabId === observedTabId &&
      Number(scrapeState._enrichGeneration || 0) === recoveryGeneration &&
      (quickEnrichRunPromise === staleTask || quickEnrichRunPromise === null);
    if (!stillOwnsQuickRecovery()) return false;
    bgLog(`QUICK ENRICH WATCHDOG kích hoạt · idle ${Math.round(idleMs / 1000)}s`);
    const cancellation = await cancelQuickEnrichOperation(observedTabId, { timeoutMs: 5000 });
    if (!stillOwnsQuickRecovery()) return false;
    if (!cancellation.reloaded) {
      await reloadMapsAfterUnsettledEnrich(observedTabId);
    }
    if (!stillOwnsQuickRecovery()) return false;
    if (quickEnrichRunPromise === staleTask) quickEnrichRunPromise = null;
    scrapeState._activeEnrichOpId = "";
    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    if (!stillOwnsQuickRecovery()) return false;
    runQuickEnrichPhase().catch(async (err) => {
      if (scrapeState.running && !pointsFinalized) {
        await abortSearch("QUICK_ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
    return true;
  } finally {
    quickEnrichWatchdogBusy = false;
  }
}

async function maybeRecoverStalledScrape() {
  if (!scrapeState.running || isAborting || stallRecoveryBusy) return;
  if (
    (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
    getQuickPendingEnrichPlaces().length > 0
  ) {
    const enrichIdleMs = Date.now() - Number(scrapeState._enrichActivityAt || Date.now());
    if (enrichIdleMs >= MAPS_STALL_FOCUS_MS) {
      const recovered = await recoverStalledQuickEnrich(enrichIdleMs);
      if (recovered) return;
    }
  }
  const activityAt =
    scrapeState.phase === "enrich"
      ? scrapeState._enrichActivityAt || lastScrapeProgressAt
      : lastScrapeProgressAt;
  const idleMs = Date.now() - (activityAt || 0);
  if (idleMs < 120000) return;
  const now = Date.now();
  if (now - Number(scrapeState._lastSoftRecoveryAt || 0) < MAPS_SOFT_RECOVERY_INTERVAL_MS) {
    return;
  }
  scrapeState._lastSoftRecoveryAt = now;

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
    let ready = await ensureMapsContentReady(tabId);
    if (!ready) {
      await focusMapsTabForRecovery(
        "Google Maps không nhận lệnh từ extension. Findmap đã đưa tab lên trước để kết nối lại.",
        { force: true }
      );
      ready = await ensureMapsContentReady(tabId);
    }
    if (!ready) return;

    if (idleMs >= MAPS_STALL_FOCUS_MS && scrapeState.phase === "enrich") {
      await recoverStalledEnrich(idleMs);
      return;
    }

    if (idleMs >= MAPS_STALL_FOCUS_MS && scrapeState.phase === "grid") {
      await maybeFocusMapsTabForStall();
      const idx = scrapeState.gridIndex;
      const staleLease = getActiveCellLease();
      if (staleLease) {
        // Vô hiệu hóa request gốc trước khi abort để chỉ watchdog được quyền tạo retry mới.
        scrapeState.cellGeneration = staleLease.cellGeneration + 1;
        await persistScrapeCheckpoint();
        await chrome.tabs
          .sendMessage(tabId, { action: "SCRAPE_ABORT", data: staleLease })
          .catch(() => {});
      }
      await retryIncompleteGridCell(idx, "stall_watchdog", { forceStallRetry: true });
      return;
    }
  } finally {
    stallRecoveryBusy = false;
  }
}

async function parkSearchAfterResumeFailure(reason) {
  scrapeState.running = false;
  scrapeState.paused = true;
  scrapeState.pausedAt = Date.now();
  scrapeState.pauseReason = String(
    reason || "Chưa thể khôi phục Google Maps. Tiến độ vẫn được giữ để thử tiếp sau."
  );
  scrapeState.resumeRequestedAt = 0;
  stopScrapeKeepAlive();
  releaseSystemKeepAwakeIfIdle({ force: true });
  await persistScrapeCheckpoint({ forceRecoverable: true });
  await clearDurableWorkAlarmIfIdle();
  const status = await getSearchStatus();
  await pushSearchStatusToWeb(status);
}

async function tryResumeFromCheckpoint({ allowReopen = false, allowPaused = false } = {}) {
  const cp = await getScrapeCheckpoint();
  if (!DurableLifecycle.isRecoverableScrapeCheckpoint(cp) || scrapeState.running) return false;
  if (cp.paused === true && !allowPaused) return false;

  restoreScrapeStateFromCheckpoint(cp);

  if (cp.phase === "pending_complete" && cp.pendingCompletion) {
    releaseSystemKeepAwake({ force: true });
    scrapeState.running = false;
    const flushed = await flushPendingComplete("resume_pending_complete");
    await resetScrapeState({ preserveCheckpoint: !flushed.delivered });
    return flushed.delivered;
  }

  scrapeState.paused = false;
  scrapeState.pausedAt = 0;
  scrapeState.pauseReason = "";
  scrapeState.resumeRequestedAt = Date.now();
  scrapeState.running = true;
  await persistScrapeCheckpoint({ forceRecoverable: true });
  requestSystemKeepAwake();
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
      let reopened = false;
      try {
        reopened = await reopenMapsTabForSearch();
      } catch (err) {
        await parkSearchAfterResumeFailure(
          `Chưa mở lại được Google Maps: ${err?.message || "không rõ lỗi"}`
        );
        throw err;
      }
      if (reopened) return true;
    }
    await parkSearchAfterResumeFailure(
      "Chưa mở lại được tab Google Maps. Tiến độ vẫn được giữ để bạn thử tiếp."
    );
    return false;
  }

  const next = nextPendingCellFromScrapeState();
  if (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) {
    let enrichAlive = false;
    if (scrapeState.enrichTabId) {
      try {
        await chrome.tabs.get(scrapeState.enrichTabId);
        enrichAlive = true;
      } catch {
        scrapeState.enrichTabId = null;
        scrapeState.enrichWindowId = null;
      }
    }
    if (!enrichAlive) {
      const canReopen = allowReopen || isMapsAutoReopenEnabled(scrapeState.searchParams);
      if (!canReopen || !(await ensureQuickEnrichTab())) {
        await parkSearchAfterResumeFailure(
          "Chưa mở lại được tab Google Maps đọc chi tiết. Tiến độ vẫn được giữ."
        );
        return false;
      }
    } else {
      // Tách thao tác DOM cũ khỏi worker mới trước khi khôi phục hàng đợi URL.
      await reloadMapsAfterUnsettledEnrich(scrapeState.enrichTabId);
    }

    scrapeState.quickProducerDone = scrapeState.quickProducerDone || next >= scrapeState.totalCells;
    if (scrapeState.quickProducerDone) scrapeState.phase = "enrich";
    await persistScrapeCheckpoint();
    runQuickEnrichPhase().catch(async (err) => {
      if (scrapeState.running && !pointsFinalized) {
        await abortSearch("QUICK_ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
    if (!scrapeState.quickProducerDone) {
      scrapeState.gridIndex = next;
      runGridCell(next).catch(async (err) => {
        if (scrapeState.running || scrapeState.mergedPlaces.size > 0) {
          await abortSearch("RECOVER_FAILED", err?.message || String(err));
        }
      });
    }
    return true;
  }

  if (scrapeState.phase === "enrich") {
    // Service worker có thể ngủ trong khi content script cũ vẫn thao tác DOM.
    // Reload là isolation barrier trước khi tiếp tục hàng đợi URL từ checkpoint.
    try {
      await reloadMapsAfterUnsettledEnrich(scrapeState.mapsTabId);
    } catch (err) {
      await parkSearchAfterResumeFailure(
        `Chưa khôi phục được tab Google Maps đọc chi tiết: ${err?.message || "không rõ lỗi"}`
      );
      throw err;
    }
    notifyPopup("Đã khôi phục danh sách. Findmap tiếp tục click các điểm chưa xử lý…");
    runEnrichPhase().catch(async (err) => {
      if (scrapeState.running && !pointsFinalized) {
        await abortSearch("ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
    return true;
  }

  if (next >= scrapeState.totalCells) {
    if (scrapeState.mergedPlaces.size > 0) {
      runEnrichPhase().catch(async (err) => {
        if (scrapeState.running && !pointsFinalized) {
          await abortSearch("ENRICH_RECOVER_FAILED", err?.message || String(err), {
            chargePartial: true
          });
        }
      });
      return true;
    }
    // Worker có thể dừng sau khi đã persist ô cuối rỗng nhưng trước reset.
    scrapeState.running = false;
    stopScrapeKeepAlive();
    await closeMapsTabSafely();
    await resetScrapeState();
    return true;
  }

  scrapeState.gridIndex = next;
  notifyPopup(`Tiếp tục tìm kiếm từ khu vực ${next + 1}/${scrapeState.totalCells}…`);
  runGridCell(next).catch(async (err) => {
    if (scrapeState.running || scrapeState.mergedPlaces.size > 0) {
      await abortSearch("RECOVER_FAILED", err?.message || String(err));
    }
  });
  return true;
}

async function finalizeFromCheckpoint(reason) {
  const transitionToken = beginOperationTransition("finalize-checkpoint");
  try {
  const cp = await getScrapeCheckpoint();
  if (!cp) return { success: false, error: "Không có tìm kiếm để kết thúc" };

  restoreScrapeStateFromCheckpoint(cp);
  scrapeState.running = false;
  scrapeState.runId = "";

  if (scrapeState.mapsTabId) {
    try {
      await chrome.tabs.sendMessage(scrapeState.mapsTabId, {
        action: "SCRAPE_ABORT",
        data: getActiveCellLease()
      });
    } catch {}
  }
  if (scrapeState.enrichTabId) {
    await chrome.tabs
      .sendMessage(scrapeState.enrichTabId, {
        action: "ENRICH_ABORT",
        data: { opId: String(scrapeState._activeEnrichOpId || "") }
      })
      .catch(() => {});
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
    await resetScrapeState();
  }
  return { success: true, charged: false, count: 0 };
  } finally {
    endOperationTransition(transitionToken);
  }
}

async function abortSearch(code, message, { chargePartial = true } = {}) {
  if (isAborting) return;
  const hasWork =
    scrapeState.running ||
    scrapeState.mergedPlaces.size > 0 ||
    scrapeState.searchParams;
  if (!hasWork) return;

  const transitionToken = beginOperationTransition("abort-search");
  isAborting = true;
  scrapeState.running = false;

  try {
    if (scrapeState.mapsTabId) {
      try {
        await chrome.tabs.sendMessage(scrapeState.mapsTabId, { action: "SCRAPE_ABORT" });
      } catch {}
    }
    if (scrapeState.enrichTabId) {
      await chrome.tabs
        .sendMessage(scrapeState.enrichTabId, {
          action: "ENRICH_ABORT",
          data: { opId: String(scrapeState._activeEnrichOpId || "") }
        })
        .catch(() => {});
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
      await resetScrapeState();
    } else {
      await resetScrapeState();
    }
  } catch (err) {
    // Sync cuối lỗi giữa chừng cũng không được để tab Maps kẹt lại.
    console.warn("abortSearch:", err?.message || err);
    await closeMapsTabSafely();
    await resetScrapeState({ preserveCheckpoint: await hasPendingScrapeCompletion() });
  } finally {
    isAborting = false;
    endOperationTransition(transitionToken);
  }
}

async function cancelActiveSearch(reason) {
  if (scrapeState.paused) {
    return finalizeFromCheckpoint(reason || "Người dùng dừng tìm kiếm");
  }
  if (scrapeState.running || scrapeState.searchParams) {
    await abortSearch("USER_CANCEL", reason || "Người dùng dừng tìm kiếm", { chargePartial: true });
    return { success: true };
  }
  return finalizeFromCheckpoint(reason || "Người dùng dừng tìm kiếm");
}

async function pauseActiveSearch(reason = "Người dùng tạm dừng quét") {
  if (!scrapeState.searchParams) {
    const cp = await getScrapeCheckpoint();
    if (!DurableLifecycle.isRecoverableScrapeCheckpoint(cp)) {
      return { success: false, error: "Không có lượt quét đang chạy để tạm dừng." };
    }
    restoreScrapeStateFromCheckpoint(cp);
  }

  if (scrapeState.paused) {
    const status = await getSearchStatus();
    await pushSearchStatusToWeb(status);
    return { success: true, paused: true, status };
  }
  if (!scrapeState.running) {
    return { success: false, error: "Lượt quét hiện không còn chạy." };
  }

  const listLease = getActiveCellLease();
  const listTabId = scrapeState.mapsTabId;
  const enrichTabId = scrapeState.quickScan ? scrapeState.enrichTabId : scrapeState.mapsTabId;
  const enrichOpId = String(scrapeState._activeEnrichOpId || "");
  const oldCellGeneration = Number(scrapeState.cellGeneration || 0);
  const oldEnrichGeneration = Number(scrapeState._enrichGeneration || 0);
  const cellIndex = Number(scrapeState.gridIndex || 0);

  if (scrapeState.phase === "grid" && !scrapeState.completedCells.has(cellIndex)) {
    scrapeState._cellContinueFlags[cellIndex] = true;
    scrapeState._pendingGridContinuation = cellIndex;
    if (listLease) scrapeState._cellResumeLeases[cellIndex] = listLease;
  }

  scrapeState.paused = true;
  scrapeState.pausedAt = Date.now();
  scrapeState.pauseReason = String(reason || "Người dùng tạm dừng quét");
  scrapeState.resumeRequestedAt = 0;
  scrapeState.running = false;
  scrapeState.cellGeneration = oldCellGeneration + 1;
  scrapeState._enrichGeneration = oldEnrichGeneration + 1;
  enrichRunPromise = null;
  quickEnrichRunPromise = null;

  const saved = await persistScrapeCheckpoint({ forceRecoverable: true });
  if (!saved) {
    scrapeState.paused = false;
    scrapeState.pausedAt = 0;
    scrapeState.pauseReason = "";
    scrapeState.running = true;
    scrapeState.cellGeneration = oldCellGeneration;
    scrapeState._enrichGeneration = oldEnrichGeneration;
    throw new Error("Không lưu được tiến độ nên chưa thể tạm dừng an toàn.");
  }

  clearMapsCellWorkTokens();
  stopScrapeKeepAlive();
  releaseSystemKeepAwakeIfIdle({ force: true });

  if (Number.isInteger(listTabId) && listLease) {
    await chrome.tabs
      .sendMessage(listTabId, { action: "SCRAPE_ABORT", data: listLease })
      .catch(() => null);
  }
  if (Number.isInteger(enrichTabId) && enrichOpId) {
    await chrome.tabs
      .sendMessage(enrichTabId, { action: "ENRICH_ABORT", data: { opId: enrichOpId } })
      .catch(() => null);
  }
  scrapeState._activeEnrichOpId = "";
  await clearDurableWorkAlarmIfIdle();
  notifyPopup("Đã tạm dừng quét. Tiến độ hiện tại đã được lưu.");
  const status = await getSearchStatus();
  await pushSearchStatusToWeb(status);
  return { success: true, paused: true, status };
}

async function abandonActiveSearch() {
  const transitionToken = beginOperationTransition("abandon-search");
  try {
  if (scrapeState.running || scrapeState.searchParams) {
    scrapeState.running = false;
    if (scrapeState.mapsTabId) {
      try {
        await chrome.tabs.sendMessage(scrapeState.mapsTabId, {
          action: "SCRAPE_ABORT",
          data: getActiveCellLease()
        });
      } catch {}
    }
    if (scrapeState.enrichTabId) {
      await chrome.tabs
        .sendMessage(scrapeState.enrichTabId, {
          action: "ENRICH_ABORT",
          data: { opId: String(scrapeState._activeEnrichOpId || "") }
        })
        .catch(() => {});
    }
    await closeMapsTabSafely();
    await resetScrapeState();
    return { success: true };
  }

  const cp = await getScrapeCheckpoint();
  if (cp?.mapsTabId) {
    try {
      await chrome.tabs.remove(cp.mapsTabId);
    } catch {}
  }
  if (cp?.enrichTabId && cp.enrichTabId !== cp.mapsTabId) {
    await chrome.tabs.remove(cp.enrichTabId).catch(() => {});
  }
  await clearScrapeCheckpoint();
  try {
    await chrome.storage.local.remove(["activeSearch", "pendingComplete"]);
  } catch {}
  releaseSystemKeepAwakeIfIdle({ force: true });
  await clearDurableWorkAlarmIfIdle();
  return { success: true };
  } finally {
    endOperationTransition(transitionToken);
  }
}

async function ensureReadyForNewSearch() {
  if (scrapeState.running || scrapeState.paused) {
    throw new Error("Đang có tìm kiếm chạy. Bấm 'Dừng quét điểm bán' hoặc đợi hoàn tất.");
  }

  const pendingComplete = await flushPendingComplete("before_new_search");
  if (pendingComplete.pending) {
    throw new Error(
      "Kết quả của lượt tìm kiếm trước chưa đồng bộ xong. Hãy giữ trang Findmap mở rồi thử lại."
    );
  }

  const cp = await getScrapeCheckpoint();
  if (cp?.paused && DurableLifecycle.isRecoverableScrapeCheckpoint(cp)) {
    throw new Error(
      "Có một lượt quét đang tạm dừng. Hãy bấm 'Tiếp tục quét' hoặc dừng hẳn lượt đó trước khi tìm mới."
    );
  }

  // Đóng tab Maps còn sót (tránh mở nhiều tab khi tìm tuần tự nhiều từ khóa)
  if (scrapeState.mapsTabId || scrapeState.enrichTabId) {
    await closeMapsTabSafely();
  }

  if (cp?.mapsTabId) {
    try {
      await chrome.tabs.get(cp.mapsTabId);
      await chrome.tabs.remove(cp.mapsTabId).catch(() => {});
    } catch {}
  }
  if (cp?.enrichTabId && cp.enrichTabId !== cp.mapsTabId) {
    try {
      await chrome.tabs.get(cp.enrichTabId);
      await chrome.tabs.remove(cp.enrichTabId).catch(() => {});
    } catch {}
  }

  if (!cp?.running) {
    if (cp && !scrapeState.searchParams) {
      await clearScrapeCheckpoint();
    }
    try {
      await chrome.storage.local.remove(["activeSearch", PENDING_SYNC_KEY]);
    } catch {}
    return;
  }

  // Checkpoint còn "running" nhưng Maps đã chết → dọn sạch, cho phép tìm tiếp
  await clearScrapeCheckpoint();
  try {
    await chrome.storage.local.remove(["activeSearch", PENDING_SYNC_KEY]);
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
  const hasMemoryState = Boolean(scrapeState.searchParams);
  const running = scrapeState.running;
  const paused = scrapeState.paused === true || cp?.paused === true;
  const checkpointRunning = !!cp?.running;
  const mergedCount =
    getFinalResultsList().length || (cp?.mergedPlaces?.length ?? 0);
  const totalCells = scrapeState.totalCells || cp?.totalCells || 0;
  const gridIndex = hasMemoryState ? scrapeState.gridIndex : cp?.gridIndex ?? 0;
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

  let liveEnrichTabId = scrapeState.enrichTabId || null;
  if (!liveEnrichTabId && cp?.enrichTabId) {
    try {
      await chrome.tabs.get(cp.enrichTabId);
      liveEnrichTabId = cp.enrichTabId;
    } catch {
      liveEnrichTabId = null;
    }
  } else if (liveEnrichTabId) {
    try {
      await chrome.tabs.get(liveEnrichTabId);
    } catch {
      liveEnrichTabId = null;
      scrapeState.enrichTabId = null;
    }
  }

  const checkpointBusy =
    !paused &&
    checkpointRunning &&
    (!!liveMapsTabId || !!liveEnrichTabId || Date.now() - lastBeat < 120000);
  const stalled =
    !paused &&
    !running &&
    checkpointRunning &&
    mergedCount > 0 &&
    Date.now() - lastBeat > 60000;

  return {
    // Không OR checkpoint mồ côi (tab Maps đã đóng) — để chuỗi nhiều từ khóa chạy tiếp
    running: !paused && (running || checkpointBusy),
    paused,
    stalled,
    phase: hasMemoryState ? scrapeState.phase : cp?.phase || "grid",
    gridIndex,
    totalCells,
    mergedCount,
    searchId: scrapeState.searchParams?.searchId || cp?.searchParams?.searchId || null,
    mapsTabId: liveMapsTabId,
    enrichTabId: liveEnrichTabId,
    quickScan:
      scrapeState.quickScan === true ||
      scrapeState.searchParams?.quickScan === true ||
      cp?.searchParams?.quickScan === true,
    mapsTabHiddenDuringList: Boolean(scrapeState._mapsListWarningKey),
    lastHeartbeat: lastBeat,
    lastProgressAt: lastScrapeProgressAt || cp?.lastProgressAt || lastBeat,
    canCancel: running || checkpointBusy || paused || mergedCount > 0,
    canPause: !paused && (running || checkpointBusy),
    canResume: paused || (!running && DurableLifecycle.isRecoverableScrapeCheckpoint(cp)),
    pausedAt: Number(scrapeState.pausedAt || cp?.pausedAt || 0),
    pauseReason: String(scrapeState.pauseReason || cp?.pauseReason || ""),
    mapsAutoFocus: scrapeState.searchParams?.mapsAutoFocus === true || cp?.searchParams?.mapsAutoFocus === true,
    mapsAutoReopen:
      scrapeState.searchParams?.mapsAutoReopen === true || cp?.searchParams?.mapsAutoReopen === true
  };
}

async function pushSearchStatusToWeb(status = null) {
  const webUrl = scrapeState.searchParams?.webUrl;
  if (!webUrl) return false;
  const payload = status || (await getSearchStatus());
  return sendToWebPage(webUrl, "search_status", payload).catch((err) => {
    console.warn("pushSearchStatusToWeb:", err?.message || err);
    return false;
  });
}

async function resetScrapeState({ preserveCheckpoint = false } = {}) {
  stopScrapeKeepAlive();
  clearMapsCellWorkTokens();
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
  scrapeState.running = false;
  scrapeState.paused = false;
  scrapeState.pausedAt = 0;
  scrapeState.pauseReason = "";
  scrapeState.resumeRequestedAt = 0;
  scrapeState.runId = "";
  scrapeState.mapsTabId = null;
  scrapeState.mapsWindowId = null;
  scrapeState.enrichTabId = null;
  scrapeState.enrichWindowId = null;
  scrapeState.webTabId = null;
  scrapeState.searchParams = null;
  scrapeState.gridPoints = [];
  scrapeState.gridIndex = 0;
  scrapeState.totalCells = 0;
  scrapeState.mergedPlaces = new Map();
  scrapeState.pendingCellPlaces = new Map();
  scrapeState.pendingCellIndex = -1;
  scrapeState.completedCells = new Set();
  scrapeState.enrichedPlaceKeys = new Set();
  scrapeState.failedEnrichKeys = new Set();
  scrapeState._pendingCompletion = null;
  scrapeState.enrichTotal = 0;
  scrapeState.phase = "grid";
  scrapeState.quickScan = false;
  scrapeState.quickProducerDone = false;
  scrapeState.cellGeneration = 0;
  scrapeState._retriedCells = new Set();
  scrapeState._cellRetryCounts = {};
  scrapeState._cellRecoveryCounts = {};
  scrapeState._cellContinueFlags = {};
  scrapeState._cellRestartFlags = {};
  scrapeState._cellResumeLeases = {};
  scrapeState._pendingGridContinuation = -1;
  scrapeState._cellListProgress = {};
  scrapeState._mapsReopenCount = 0;
  scrapeState._mapsUserReloadCount = 0;
  scrapeState._activeEnrichOpId = "";
  scrapeState._enrichActivityAt = 0;
  scrapeState._enrichGeneration = 0;
  scrapeState._enrichMapsReopenCount = 0;
  scrapeState._scheduledCellRetry = "";
  enrichRunPromise = null;
  quickEnrichRunPromise = null;
  enrichWatchdogBusy = false;
  quickEnrichWatchdogBusy = false;
  scrapeState._programmaticMapsNavUntil = 0;
  scrapeState._expectMapsNavigation = false;
  scrapeState._mapsCellListActive = false;
  scrapeState._mapsCellListLease = null;
  scrapeState._mapsListWarningKey = "";
  currentSearch = null;
  pointsFinalized = false;
  lastScrapeProgressAt = 0;
  scrapeState._lastRecoveryFocusDataAt = 0;
  scrapeState._lastEnrichRecoveryFocusDataAt = 0;
  scrapeState._lastSoftRecoveryAt = 0;
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
  if (!preserveCheckpoint) {
    // Normal cleanup removes the checkpoint; pending completion keeps it recoverable.
    await clearScrapeCheckpoint().catch(() => {});
  }
  releaseSystemKeepAwakeIfIdle();
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
  // Tab mở lại vẫn ở nền; chỉ focus nếu không phản hồi hoặc thao tác thất bại.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitTabComplete(tab.id);
  await sleep(1200);

  const ready = await ensureMapsContentReady(tab.id);
  if (!ready) return false;

  markMapsDataActivity();
  notifyProgress(
    calcProgressPercent(idx, scrapeState.totalCells, 0.2),
    `Đã mở lại Google Maps · Tiếp tục khu vực ${idx + 1}/${scrapeState.totalCells}`
  );

  if (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) {
    const enrichReady = await ensureQuickEnrichTab(url);
    if (!enrichReady) return false;
    runQuickEnrichPhase().catch(async (err) => {
      if ((scrapeState.running || scrapeState.mergedPlaces.size > 0) && !pointsFinalized) {
        await abortSearch("QUICK_ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
    if (scrapeState.quickProducerDone) return true;

    const resumeAt = scrapeState.completedCells.has(idx) ? idx + 1 : idx;
    if (resumeAt >= scrapeState.totalCells) {
      scrapeState.quickProducerDone = true;
      scrapeState.phase = "enrich";
      await persistScrapeCheckpoint();
      await runQuickEnrichPhase();
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

  if (scrapeState.phase === "enrich") {
    runEnrichPhase().catch(async (err) => {
      if ((scrapeState.running || scrapeState.mergedPlaces.size > 0) && !pointsFinalized) {
        await abortSearch("ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
    return true;
  }

  const resumeAt = scrapeState.completedCells.has(idx) ? idx + 1 : idx;
  if (resumeAt >= scrapeState.totalCells) {
    if (scrapeState.mergedPlaces.size > 0) {
      await runEnrichPhase();
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

function enqueueMapsTabRecovery(task) {
  const next = mapsTabRecoveryQueue.catch(() => {}).then(task);
  mapsTabRecoveryQueue = next.catch(() => {});
  return next;
}

async function handleSearchMapsTabLost(closedTabId = scrapeState.mapsTabId) {
  if (mapsTabLossBusy || isAborting || !scrapeState.running) return;
  if (scrapeState.mapsTabId == null || scrapeState.mapsTabId !== closedTabId) return;

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
        await pauseActiveSearch(
          `Tab Google Maps bị đóng quá nhiều lần (${maxReopen}). Tiến độ đã được lưu; bấm Tiếp tục quét để thử lại.`
        );
        return;
      }
      notifyProgress(
        calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.1),
        `Tab Google Maps đã bị đóng. Đang mở lại · Lần ${count}/${maxReopen}…`
      );
      const ok = await reopenMapsTabForSearch();
      if (!ok) {
        await pauseActiveSearch(
          "Tab Google Maps đã bị đóng và chưa mở lại được. Tiến độ đã được lưu để bạn tiếp tục sau."
        );
      }
    } else {
      await pauseActiveSearch(
        "Tab Google Maps đã bị đóng. Tiến độ đã được lưu; bấm Tiếp tục quét để mở lại tab."
      );
    }
  } finally {
    mapsTabLossBusy = false;
  }
}

async function handleQuickEnrichTabLost(closedTabId = scrapeState.enrichTabId) {
  if (
    quickEnrichTabLossBusy ||
    isAborting ||
    !scrapeState.running ||
    !(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) ||
    scrapeState.enrichTabId == null ||
    scrapeState.enrichTabId !== closedTabId
  ) {
    return;
  }

  quickEnrichTabLossBusy = true;
  scrapeState.enrichTabId = null;
  scrapeState.enrichWindowId = null;
  scrapeState._activeEnrichOpId = "";
  scrapeState._enrichGeneration = Number(scrapeState._enrichGeneration || 0) + 1;
  quickEnrichRunPromise = null;
  await persistScrapeCheckpoint();

  try {
    if (!isMapsAutoReopenEnabled(scrapeState.searchParams)) {
      await pauseActiveSearch(
        "Tab Google Maps đọc chi tiết đã bị đóng. Tiến độ đã được lưu; bấm Tiếp tục quét để mở lại tab."
      );
      return;
    }

    const count = Number(scrapeState._enrichMapsReopenCount || 0) + 1;
    scrapeState._enrichMapsReopenCount = count;
    const maxReopen = getMapsAutoReopenMax();
    if (count > maxReopen) {
      await pauseActiveSearch(
        `Tab Google Maps đọc chi tiết bị đóng quá nhiều lần (${maxReopen}). Tiến độ đã được lưu để tiếp tục sau.`
      );
      return;
    }

    notifyProgress(
      calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.6),
      `Tab đọc chi tiết đã bị đóng. Đang mở lại · Lần ${count}/${maxReopen}…`
    );
    const ready = await ensureQuickEnrichTab();
    if (!ready) {
      await pauseActiveSearch(
        "Chưa mở lại được tab Google Maps đọc chi tiết. Tiến độ đã được lưu để bạn tiếp tục sau."
      );
      return;
    }

    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    runQuickEnrichPhase().catch(async (err) => {
      if (scrapeState.running && !pointsFinalized) {
        await abortSearch("QUICK_ENRICH_RECOVER_FAILED", err?.message || String(err), {
          chargePartial: true
        });
      }
    });
  } finally {
    quickEnrichTabLossBusy = false;
  }
}

async function persistRescanCheckpoint() {
  if (!rescanState.running || !Array.isArray(rescanState.places) || !rescanState.places.length) return;
  const now = Date.now();
  const durableParams = {
    ...(rescanState.params || {}),
    searchParams: toDurableSearchParams(rescanState.params?.searchParams || {})
  };
  delete durableParams.authToken;
  delete durableParams.places;
  const checkpoint = {
    version: DurableLifecycle.CHECKPOINT_VERSION,
    running: true,
    savedAt: now,
    lastHeartbeat: now,
    webUrl: rescanState.webUrl,
    done: rescanState.done,
    failed: rescanState.failed,
    total: rescanState.total,
    placeIndex: rescanState.placeIndex,
    places: rescanState.places,
    params: durableParams,
    searchParams: toDurableSearchParams(rescanState.searchParams),
    terminalCompletion: rescanState._terminalCompletion,
    mapsAutoReopen: isRescanAutoReopenEnabled(),
    reopenCount: Number(rescanState._reopenCount || 0),
    lastDataAt: Number(rescanState._lastDataAt || now),
    lastRecoveryFocusDataAt: Number(rescanState._lastRecoveryFocusDataAt || 0),
    mapsTabId: rescanState.mapsTabId,
    mapsWindowId: rescanState.mapsWindowId
  };

  return enqueueCheckpointMutation("rescan", async () => {
    try {
      await chrome.storage.local.set({ [RESCAN_CHECKPOINT_KEY]: checkpoint });
      await ensureDurableWorkAlarm();
      return true;
    } catch (err) {
      console.warn("persistRescanCheckpoint:", err?.message || err);
      return false;
    }
  });
}

async function getRescanCheckpoint() {
  await rescanCheckpointQueue.catch(() => {});
  const data = await chrome.storage.local.get(RESCAN_CHECKPOINT_KEY);
  return data[RESCAN_CHECKPOINT_KEY] || null;
}

async function clearRescanCheckpoint() {
  return enqueueCheckpointMutation("rescan", async () => {
    try {
      await chrome.storage.local.remove(RESCAN_CHECKPOINT_KEY);
    } catch {}
  });
}

function restoreRescanStateFromCheckpoint(checkpoint) {
  if (!DurableLifecycle.isRecoverableRescanCheckpoint(checkpoint)) return false;
  rescanState.running = true;
  rescanState.webUrl = checkpoint.webUrl;
  rescanState.done = Number(checkpoint.done || 0);
  rescanState.failed = Number(checkpoint.failed || 0);
  rescanState.total = Number(checkpoint.total || checkpoint.places.length);
  rescanState.placeIndex = Number(checkpoint.placeIndex || 0);
  rescanState.places = checkpoint.places;
  rescanState.params = checkpoint.params || {};
  rescanState.searchParams = checkpoint.searchParams || {};
  rescanState._terminalCompletion = checkpoint.terminalCompletion || null;
  rescanState.mapsAutoReopen = checkpoint.mapsAutoReopen === true;
  rescanState._reopenCount = Number(checkpoint.reopenCount || 0);
  rescanState._lastDataAt = Number(checkpoint.lastDataAt || checkpoint.lastHeartbeat || Date.now());
  rescanState._lastRecoveryFocusDataAt = Number(checkpoint.lastRecoveryFocusDataAt || 0);
  rescanState.mapsTabId = checkpoint.mapsTabId ?? null;
  rescanState.mapsWindowId = checkpoint.mapsWindowId ?? null;
  return true;
}

async function tryResumeRescanFromCheckpoint({ allowReopen = false } = {}) {
  if (scrapeState.running || rescanState.running) return false;
  const checkpoint = await getRescanCheckpoint();
  if (!restoreRescanStateFromCheckpoint(checkpoint)) return false;

  await ensureDurableWorkAlarm();
  if (rescanState._terminalCompletion) {
    return deliverRescanTerminalCompletion();
  }
  if (rescanState.placeIndex >= rescanState.places.length) {
    return finishRescanNormal();
  }
  requestSystemKeepAwake();

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
    try {
      mapsAlive = await openRescanMapsTab();
    } catch (err) {
      rescanState.running = false;
      releaseSystemKeepAwake({ force: true });
      await ensureDurableWorkAlarm();
      throw err;
    }
  }
  if (!mapsAlive) {
    rescanState.running = false;
    releaseSystemKeepAwake({ force: true });
    await ensureDurableWorkAlarm();
    return false;
  }

  await sendToWebPage(rescanState.webUrl, "rescan_progress", {
    done: rescanState.done,
    total: rescanState.total,
    percent: rescanState.total ? Math.round((rescanState.done / rescanState.total) * 100) : 0,
    name: "",
    info: "Findmap đã khôi phục phiên quét lại sau khi Chrome đánh thức tiện ích."
  }).catch(() => {});

  runRescanPlacesLoop()
    .then(async (completed) => {
      if (completed) await finishRescanNormal();
      else await parkRescanForRecovery();
    })
    .catch((err) => abortRescan(err?.message || "Không khôi phục được quét lại", "RESCAN_RECOVER_FAILED"));
  return true;
}

function resetRescanState() {
  clearMapsRescanWorkTokens();
  rescanState.running = false;
  rescanState.mapsTabId = null;
  rescanState.mapsWindowId = null;
  rescanState.webUrl = null;
  rescanState.done = 0;
  rescanState.failed = 0;
  rescanState.total = 0;
  rescanState.placeIndex = 0;
  rescanState.places = null;
  rescanState.params = null;
  rescanState.searchParams = null;
  rescanState.mapsAutoReopen = false;
  rescanState._terminalCompletion = null;
  rescanState._reopenCount = 0;
  rescanState._handlingTabLoss = false;
  rescanState._awaitingReopen = false;
  rescanState._lastDataAt = 0;
  rescanState._lastRecoveryFocusDataAt = 0;
  releaseSystemKeepAwakeIfIdle();
}

async function closeRescanMapsTabSafely() {
  const tabId = rescanState.mapsTabId;
  clearMapsRescanWorkTokens();
  rescanState.mapsTabId = null;
  rescanState.mapsWindowId = null;
  if (!tabId) return;
  await chrome.tabs.remove(tabId).catch(() => {});
}

async function parkRescanForRecovery() {
  if (!rescanState.webUrl) return false;
  await closeRescanMapsTabSafely();
  await persistRescanCheckpoint();
  rescanState.running = false;
  resetRescanState();
  await ensureDurableWorkAlarm();
  return false;
}

async function sendRescanDataWithRetry(webUrl, type, payload, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const delivered = await sendToWebPage(webUrl, type, payload).catch(() => false);
    if (delivered) return true;
    if (attempt + 1 < maxAttempts) await sleep(300 * (attempt + 1));
  }
  return false;
}

async function deliverRescanTerminalCompletion() {
  const payload = rescanState._terminalCompletion;
  const webUrl = rescanState.webUrl;
  if (!payload || !webUrl) return false;

  const transitionToken = beginOperationTransition("complete-rescan");
  try {
  await closeRescanMapsTabSafely();
  rescanState.running = false;
  const delivered = await sendRescanDataWithRetry(webUrl, "rescan_complete", payload, 5);
  if (delivered) {
    await clearRescanCheckpoint();
    resetRescanState();
    await clearDurableWorkAlarmIfIdle();
    return true;
  }

  resetRescanState();
  await ensureDurableWorkAlarm();
  return false;
  } finally {
    endOperationTransition(transitionToken);
  }
}

async function abortRescan(message, code = "TAB_MAPS_CLOSED") {
  if (!rescanState.running && !rescanState.webUrl) return;
  const done = rescanState.done;
  const failed = rescanState.failed;
  const total = rescanState.total;
  rescanState._terminalCompletion = {
    done,
    failed,
    total,
    error: message,
    code,
    partial: done > 0
  };
  await closeRescanMapsTabSafely();
  await persistRescanCheckpoint();
  return deliverRescanTerminalCompletion();
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
    const closedMapsTabId = scrapeState.mapsTabId;
    if (
      (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
      windowId === scrapeState.enrichWindowId
    ) {
      scrapeState.enrichTabId = null;
      scrapeState.enrichWindowId = null;
    }
    enqueueMapsTabRecovery(() => handleSearchMapsTabLost(closedMapsTabId)).catch((err) =>
      console.warn("handleSearchMapsTabLost:", err.message)
    );
    return;
  }
  if (
    scrapeState.running &&
    (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
    windowId === scrapeState.enrichWindowId &&
    scrapeState.enrichTabId != null
  ) {
    const closedEnrichTabId = scrapeState.enrichTabId;
    enqueueMapsTabRecovery(() => handleQuickEnrichTabLost(closedEnrichTabId)).catch((err) =>
      console.warn("handleQuickEnrichTabLost:", err.message)
    );
    return;
  }
  if (rescanState.running && windowId === rescanState.mapsWindowId && rescanState.mapsTabId != null) {
    handleRescanMapsTabLost().catch((err) => console.warn("handleRescanMapsTabLost:", err.message));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (scrapeState.running && tabId === scrapeState.mapsTabId) {
    enqueueMapsTabRecovery(() => handleSearchMapsTabLost(tabId)).catch((err) =>
      console.warn("handleSearchMapsTabLost:", err.message)
    );
    return;
  }
  if (
    scrapeState.running &&
    (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
    tabId === scrapeState.enrichTabId
  ) {
    enqueueMapsTabRecovery(() => handleQuickEnrichTabLost(tabId)).catch((err) =>
      console.warn("handleQuickEnrichTabLost:", err.message)
    );
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
    clearMapsListInterruptionWarning();
    ensureWebSyncedToResults("Đồng bộ khi quay lại tab Maps", true).catch(() => {});
  } else {
    warnMapsListInterruption(tabId, "tab_activated");
    if (tabId === scrapeState.webTabId) {
      ensureWebSyncedToResults("Đồng bộ khi quay lại tab kết quả", true).catch(() => {});
    }
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (
    !scrapeState.running ||
    !scrapeState.searchParams?.webUrl ||
    !scrapeState._mapsCellListActive
  ) {
    return;
  }
  if (windowId !== scrapeState.mapsWindowId) {
    warnMapsListInterruption(null, "window_focus_changed");
    return;
  }
  chrome.tabs
    .query({ active: true, windowId })
    .then(([activeTab]) => {
      if (activeTab?.id === scrapeState.mapsTabId) clearMapsListInterruptionWarning();
      else warnMapsListInterruption(activeTab?.id ?? null, "maps_window_focused");
    })
    .catch(() => warnMapsListInterruption(null, "window_focus_check_failed"));
});

function markMapsControlledActivity(extraMs = 120000) {
  const until = Date.now() + extraMs;
  scrapeState._programmaticMapsNavUntil = Math.max(scrapeState._programmaticMapsNavUntil || 0, until);
}

function beginMapsCellWork(extraMs = 15 * 60 * 1000) {
  const token = Symbol("maps-cell-work");
  mapsCellWorkTokens.add(token);
  scrapeState._mapsCellWorkActive = true;
  markMapsControlledActivity(extraMs);
  startMapsContentWakePulse();
  return token;
}

function endMapsCellWork(token) {
  mapsCellWorkTokens.delete(token);
  scrapeState._mapsCellWorkActive = mapsCellWorkTokens.size > 0;
  if (
    mapsCellWorkTokens.size === 0 &&
    (typeof quickEnrichWorkTokens === "undefined" || quickEnrichWorkTokens.size === 0) &&
    mapsRescanWorkTokens.size === 0
  ) {
    stopMapsContentWakePulse();
  }
}

function beginQuickEnrichWork() {
  const token = Symbol("quick-enrich-work");
  quickEnrichWorkTokens.add(token);
  startMapsContentWakePulse();
  return token;
}

function endQuickEnrichWork(token) {
  quickEnrichWorkTokens.delete(token);
  if (
    mapsCellWorkTokens.size === 0 &&
    (typeof quickEnrichWorkTokens === "undefined" || quickEnrichWorkTokens.size === 0) &&
    mapsRescanWorkTokens.size === 0
  ) {
    stopMapsContentWakePulse();
  }
}

function beginMapsCellListWork(lease) {
  const token = Symbol("maps-cell-list-work");
  activeMapsCellListToken = token;
  scrapeState._mapsCellListActive = true;
  scrapeState._mapsCellListLease = RunLease.normalize(lease);
  return token;
}

function endMapsCellListWork(token) {
  if (activeMapsCellListToken !== token) return;
  activeMapsCellListToken = null;
  scrapeState._mapsCellListActive = false;
  scrapeState._mapsCellListLease = null;
  clearMapsListInterruptionWarning();
}

function beginMapsRescanWork() {
  const token = Symbol("maps-rescan-work");
  mapsRescanWorkTokens.add(token);
  startMapsContentWakePulse();
  return token;
}

function endMapsRescanWork(token) {
  mapsRescanWorkTokens.delete(token);
  if (
    mapsCellWorkTokens.size === 0 &&
    (typeof quickEnrichWorkTokens === "undefined" || quickEnrichWorkTokens.size === 0) &&
    mapsRescanWorkTokens.size === 0
  ) {
    stopMapsContentWakePulse();
  }
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
    try {
      await chrome.tabs.update(scrapeState.mapsTabId, {
        ...updates,
        autoDiscardable: false
      });
    } catch (err) {
      await focusMapsTabForRecovery(
        "Google Maps không nhận được lệnh đổi URL. Findmap đã đưa tab lên trước để thử lại.",
        { force: true }
      );
      await chrome.tabs.update(scrapeState.mapsTabId, {
        ...updates,
        autoDiscardable: false
      });
    }
    if (waitComplete && updates.url) {
      await waitTabComplete(scrapeState.mapsTabId);
      await sleep(400);
    }
  } finally {
    scrapeState._expectMapsNavigation = false;
  }
}

async function handleMapsTabReloaded() {
  if (!scrapeState.running || isAborting || mapsReloadRecoverBusy || pointsFinalized) return;
  if (isMapsLoadingExpected()) return;
  mapsReloadRecoverBusy = true;
  try {
    scrapeState.cellGeneration = (scrapeState.cellGeneration || 0) + 1;
    scrapeState._mapsUserReloadCount = (scrapeState._mapsUserReloadCount || 0) + 1;

    const hasResults = scrapeState.mergedPlaces.size > 0;
    const reloadCount = scrapeState._mapsUserReloadCount;

    notifyProgress(
      calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.2),
      `Tab Google Maps vừa được tải lại · Lần ${reloadCount}. Findmap đang khôi phục tiến trình…`
    );

    await sleep(1200);
    let ready = await ensureMapsContentReady(scrapeState.mapsTabId);
    if (!ready) {
      await focusMapsTabForRecovery(
        "Google Maps chưa kết nối lại được sau khi tải lại. Findmap đã đưa tab lên trước để thử lại.",
        { force: true }
      );
      ready = await ensureMapsContentReady(scrapeState.mapsTabId);
    }
    if (!ready) {
      notifyProgress(
        calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.2),
        "Google Maps vẫn đang tải lại. Findmap sẽ tiếp tục thử qua watchdog và không dừng kết quả hiện có."
      );
      await persistScrapeCheckpoint();
      return;
    }

    markMapsDataActivity();
    notifyPopup(
      `Đã kết nối lại Google Maps · Tiếp tục khu vực ${scrapeState.gridIndex + 1}/${scrapeState.totalCells}`
    );

    const idx = scrapeState.gridIndex;
    if (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) {
      runQuickEnrichPhase().catch(async (err) => {
        if ((scrapeState.running || hasResults) && !pointsFinalized) {
          await abortSearch("QUICK_ENRICH_RECOVER_FAILED", err?.message || String(err), {
            chargePartial: true
          });
        }
      });
      if (scrapeState.quickProducerDone) return;
      const resumeAt = scrapeState.completedCells.has(idx) ? idx + 1 : idx;
      if (resumeAt >= scrapeState.totalCells) {
        scrapeState.quickProducerDone = true;
        scrapeState.phase = "enrich";
        await persistScrapeCheckpoint();
        await runQuickEnrichPhase();
        return;
      }
      runGridCell(resumeAt).catch(async (err) => {
        if ((scrapeState.running || hasResults) && !pointsFinalized) {
          await abortSearch("RECOVER_FAILED", err?.message || String(err), {
            chargePartial: true
          });
        }
      });
      return;
    }
    if (scrapeState.phase === "enrich") {
      runEnrichPhase().catch(async (err) => {
        if ((scrapeState.running || hasResults) && !pointsFinalized) {
          await abortSearch("ENRICH_RECOVER_FAILED", err?.message || String(err), {
            chargePartial: true
          });
        }
      });
      return;
    }

    const resumeAt = scrapeState.completedCells.has(idx) ? idx + 1 : idx;
    if (resumeAt >= scrapeState.totalCells) {
      if (hasResults) {
        await runEnrichPhase();
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

const REQUIRED_CONTENT_VERSION = 75;

async function sendTabMessageWithTimeout(tabId, message, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `Google Maps chưa phản hồi lệnh ${message?.action || "không xác định"}.`
          );
          error.code = "MAPS_MESSAGE_TIMEOUT";
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureMapsContentReady(tabId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const pong = await sendTabMessageWithTimeout(tabId, { action: "PING" }, 2500);
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
    } catch (err) {
      // Renderer không phản hồi thì đừng xếp thêm các lệnh inject có thể treo vô hạn.
      if (err?.code === "MAPS_MESSAGE_TIMEOUT") return false;
    }

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
    const pong = await sendTabMessageWithTimeout(tabId, { action: "PING" }, 2500);
    return !!pong?.ok && Number(pong.v || 0) >= REQUIRED_CONTENT_VERSION;
  } catch {
    return false;
  }
}

async function sendMapsMessage(action, data) {
  const tabId = scrapeState.mapsTabId;
  if (!tabId) throw new Error("Không tìm thấy tab Google Maps đang dùng để quét.");

  let ready = await ensureMapsContentReady(tabId);
  if (!ready) {
    await focusMapsTabForRecovery(
      "Google Maps không nhận lệnh từ extension. Findmap đã đưa tab lên trước để kết nối lại.",
      { force: true }
    );
    ready = await ensureMapsContentReady(tabId);
  }
  if (!ready) throw new Error("Không kết nối được với Google Maps. Hãy tải lại tab Google Maps rồi thử lại.");

  try {
    return await chrome.tabs.sendMessage(tabId, { action, data });
  } catch (err) {
    await focusMapsTabForRecovery(
      "Google Maps không thực hiện được thao tác ở chế độ nền. Findmap đã đưa tab lên trước để thử lại.",
      { force: true }
    );
    await ensureMapsContentReady(tabId);
    return await chrome.tabs.sendMessage(tabId, { action, data });
  }
}

function isSuccessfulMapsResponse(action, result) {
  if (!result || result.success === false) return false;
  if (action === "SCRAPE_CELL_LIST") return result.success === true && result.reachedEnd === true;
  if (action === "ENRICH_PLACE") return result.success === true && Boolean(result.place);
  return true;
}

async function sendMapsMessageWithTimeout(action, data, timeoutMs = 75000) {
  let timer;
  try {
    const result = await Promise.race([
      sendMapsMessage(action, data),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `Google Maps chưa phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`
          );
          error.code = "MAPS_MESSAGE_TIMEOUT";
          reject(error);
        }, timeoutMs);
      })
    ]);
    if (isSuccessfulMapsResponse(action, result)) {
      markMapsDataActivity();
    } else {
      await maybeFocusMapsTabForStall();
    }
    return result;
  } catch (err) {
    await maybeFocusMapsTabForStall();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function abortCellListLeaseForContinuation(tabId, lease, timeoutMs = 4000) {
  let response = null;
  try {
    response = await sendTabMessageWithTimeout(
      tabId,
      { action: "SCRAPE_ABORT", data: lease },
      timeoutMs
    );
  } catch (err) {
    bgLog(`Không xác nhận được SCRAPE_ABORT: ${err?.message || err}`);
  }

  const settled = response?.success === true;
  if (settled) return { settled: true, reloaded: false };

  try {
    await reloadMapsAfterUnsettledEnrich(tabId);
    return { settled: false, reloaded: true, reloadFailed: false };
  } catch (err) {
    bgLog(`Chưa reload được Maps sau SCRAPE_ABORT: ${err?.message || err}`);
    return { settled: false, reloaded: false, reloadFailed: true };
  }
}

async function parkGridCellUntilRendererReady(
  cellIndex,
  { restartFromTop = false, reason = "renderer_unavailable" } = {}
) {
  if (!scrapeState.running || scrapeState.phase !== "grid") return false;
  const continueFlags =
    scrapeState._cellContinueFlags || (scrapeState._cellContinueFlags = {});
  const restartFlags =
    scrapeState._cellRestartFlags || (scrapeState._cellRestartFlags = {});
  continueFlags[cellIndex] = true;
  if (restartFromTop) restartFlags[cellIndex] = true;
  scrapeState._pendingGridContinuation = cellIndex;
  scrapeState.gridIndex = cellIndex;
  await persistScrapeCheckpoint();
  await ensureDurableWorkAlarm();
  bgLog(`Ô ${cellIndex + 1} đang chờ renderer Maps thức lại (${reason}).`);
  notifyProgress(
    calcProgressPercent(cellIndex, scrapeState.totalCells, 0.15),
    `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · Google Maps đang tạm ngủ. ` +
      "Findmap đã lưu tiến độ và sẽ tự tiếp tục khi tab phản hồi."
  );
  return false;
}

async function resumePendingGridContinuationIfReady() {
  const cellIndex = Number(scrapeState._pendingGridContinuation);
  if (
    !scrapeState.running ||
    scrapeState.phase !== "grid" ||
    !Number.isSafeInteger(cellIndex) ||
    cellIndex < 0 ||
    cellIndex >= scrapeState.totalCells ||
    scrapeState._mapsCellWorkActive ||
    scrapeState._mapsCellListActive ||
    scrapeState._scheduledCellRetry
  ) {
    return false;
  }
  if (!scrapeState.mapsTabId) return false;

  const ready = await ensureMapsContentReady(scrapeState.mapsTabId);
  if (!ready) return false;

  scrapeState._pendingGridContinuation = -1;
  await persistScrapeCheckpoint();
  runGridCell(cellIndex).catch(async (err) => {
    if (scrapeState.running && scrapeState.phase === "grid" && !pointsFinalized) {
      await abortSearch("RECOVER_FAILED", err?.message || String(err), { chargePartial: true });
    }
  });
  return true;
}

async function retryIncompleteGridCell(cellIndex, reason, diagnostics = {}) {
  if (!scrapeState.running) return false;

  const retryKey = `${scrapeState.runId}:${scrapeState.cellGeneration}:${cellIndex}`;
  if (scrapeState._scheduledCellRetry === retryKey) return false;
  scrapeState._scheduledCellRetry = retryKey;

  try {
    const retryCounts = scrapeState._cellRetryCounts || (scrapeState._cellRetryCounts = {});
    const continueFlags =
      scrapeState._cellContinueFlags || (scrapeState._cellContinueFlags = {});
    const resumableChunk =
      reason === "chunk_budget" ||
      reason === "renderer_suspended" ||
      reason === "message_timeout";
    const hasResumeEvidence =
      getPendingCellPlaces(cellIndex).length > 0 ||
      Number(diagnostics.scrollTop || 0) > 0 ||
      Number(diagnostics.scrollHeight || 0) > 0 ||
      Boolean(diagnostics.lastItemKey) ||
      reason === "message_timeout";
    const stallQualified =
      diagnostics.forceStallRetry === true ||
      (!diagnostics.grew && Number(diagnostics.noGrowthMs || 0) >= CELL_LIST_STALL_RETRY_MS);
    const canContinueChunk =
      resumableChunk && !stallQualified && hasResumeEvidence && Boolean(scrapeState.mapsTabId);
    continueFlags[cellIndex] = canContinueChunk;

    if (canContinueChunk) {
      const restartFlags =
        scrapeState._cellRestartFlags || (scrapeState._cellRestartFlags = {});
      if (diagnostics.resumeFromCurrent === false) restartFlags[cellIndex] = true;
      else delete restartFlags[cellIndex];
      if (diagnostics.grew) retryCounts[cellIndex] = 0;
      scrapeState.gridIndex = cellIndex;
      await persistScrapeCheckpoint();
      notifyProgress(
        calcProgressPercent(cellIndex, scrapeState.totalCells, 0.15),
        `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · Đã lưu ${getPendingCellPlaces(cellIndex).length} URL · Đang cuộn tiếp…`
      );
      bgLog(
        `Ô ${cellIndex + 1} tạm dừng (${reason}) nhưng vẫn có tiến triển; tiếp tục không tính retry.`
      );
      await sleep(350);
      if (!scrapeState.running) return false;
      await runGridCell(cellIndex);
      return true;
    }

    if (stallQualified && scrapeState._cellListProgress?.[cellIndex]) {
      scrapeState._cellListProgress[cellIndex].noGrowthMs = 0;
    }
    const attempts = Number(retryCounts[cellIndex] || 0);
    if (attempts >= MAX_INCOMPLETE_CELL_RETRIES) {
      const recoveryCounts =
        scrapeState._cellRecoveryCounts || (scrapeState._cellRecoveryCounts = {});
      const recoveries = Number(recoveryCounts[cellIndex] || 0);
      if (recoveries < MAX_CELL_HARD_RECOVERIES && scrapeState.mapsTabId) {
        recoveryCounts[cellIndex] = recoveries + 1;
        retryCounts[cellIndex] = 0;
        continueFlags[cellIndex] = false;
        if (scrapeState._cellRestartFlags) delete scrapeState._cellRestartFlags[cellIndex];
        if (scrapeState._cellResumeLeases) delete scrapeState._cellResumeLeases[cellIndex];
        clearCellListProgress(cellIndex);
        await persistScrapeCheckpoint();
        notifyProgress(
          calcProgressPercent(cellIndex, scrapeState.totalCells, 0.12),
          `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · Đang khởi tạo lại Maps để tiếp tục tải đủ danh sách…`
        );
        scrapeState._expectMapsNavigation = true;
        markMapsControlledActivity(120000);
        try {
          try {
            await chrome.tabs.reload(scrapeState.mapsTabId);
            await waitTabComplete(scrapeState.mapsTabId, 30000);
          } catch (err) {
            await focusMapsTabForRecovery(
              "Google Maps không khởi tạo lại được ở nền. Findmap đã đưa tab lên trước để thử lại.",
              { force: true }
            );
          }
          await ensureMapsContentReady(scrapeState.mapsTabId);
        } finally {
          scrapeState._expectMapsNavigation = false;
        }
        await sleep(1200);
        if (!scrapeState.running) return false;
        await runGridCell(cellIndex);
        return true;
      }

      await abortSearch(
        "CELL_LIST_INCOMPLETE",
        `Khu vực ${cellIndex + 1} chưa tải được tới cuối danh sách sau nhiều lần thử và khởi tạo lại Maps. ` +
          "Findmap đã dừng để không bỏ sót dữ liệu rồi chuyển nhầm sang khu vực khác.",
        { chargePartial: true }
      );
      return false;
    }

    const nextAttempt = attempts + 1;
    retryCounts[cellIndex] = nextAttempt;
    scrapeState.gridIndex = cellIndex;
    await persistScrapeCheckpoint();

    notifyPopup(
      `Khu vực ${cellIndex + 1} chưa tới cuối danh sách. Findmap đang ${
        canContinueChunk ? "tiếp tục từ vị trí hiện tại" : "tải lại và thử tiếp"
      } ` +
        `(${nextAttempt}/${MAX_INCOMPLETE_CELL_RETRIES})…`
    );
    notifyProgress(
      calcProgressPercent(cellIndex, scrapeState.totalCells, 0.15),
      `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · Chưa tới cuối danh sách · ` +
        `${canContinueChunk ? "Đang cuộn tiếp…" : "Đang thử lại…"}`
    );
    bgLog(`Ô ${cellIndex + 1} chưa hoàn tất (${reason || "unknown"}) · retry ${nextAttempt}`);

    await sleep(Math.min(5000, 1200 * nextAttempt));
    if (!scrapeState.running) return false;
    await runGridCell(cellIndex);
    return true;
  } finally {
    if (scrapeState._scheduledCellRetry === retryKey) {
      scrapeState._scheduledCellRetry = "";
    }
  }
}

function isCompleteCellResult(result) {
  return result?.success === true && result?.reachedEnd === true;
}

function stampCellPlacesForEnrich(places, cellIndex) {
  const cell = scrapeState.gridPoints[cellIndex] || {};
  const params = scrapeState.searchParams || {};
  const searchUrl = buildMapsUrl(params.keyword, cell.lat, cell.lng, scrapeState.viewportM);
  return (Array.isArray(places) ? places : []).map((place) => ({
    ...place,
    _enrichKey: place._enrichKey || getStableEnrichKey(place),
    _enrichCellIndex: cellIndex,
    _enrichCellLat: cell.lat,
    _enrichCellLng: cell.lng,
    _enrichSearchUrl: searchUrl
  }));
}

async function runGridCell(cellIndex) {
  if (!scrapeState.running) return;

  const cellGen = ++scrapeState.cellGeneration;
  const lease = { runId: scrapeState.runId, cellGeneration: cellGen };
  let previousFeedSignature = "";
  let previousFeedInstanceId = "";

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

  scrapeState.gridIndex = cellIndex;

  const params = scrapeState.searchParams;
  const cell = scrapeState.gridPoints[cellIndex];
  const url = buildMapsUrl(params.keyword, cell.lat, cell.lng, scrapeState.viewportM);
  const pendingCellPlaces = getPendingCellPlaces(cellIndex);
  const globalSeen = buildGlobalSeenKeys([
    ...scrapeState.mergedPlaces.values(),
    ...pendingCellPlaces
  ]);
  const continuingSameCell = scrapeState._cellContinueFlags?.[cellIndex] === true;
  const restartingSameCell = scrapeState._cellRestartFlags?.[cellIndex] === true;
  let resumeFromCurrent = continuingSameCell && !restartingSameCell;
  const retryingSameCell =
    continuingSameCell ||
    restartingSameCell ||
    Number(scrapeState._cellRetryCounts?.[cellIndex] || 0) > 0 ||
    Number(scrapeState._cellRecoveryCounts?.[cellIndex] || 0) > 0;
  const requireFeedChange = cellIndex > 0 && !retryingSameCell;

  if (cellIndex === 0 && !scrapeState.mapsTabId) {
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
    if (
      (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
      !scrapeState.enrichTabId
    ) {
      try {
        await openQuickEnrichTab(url);
      } catch (err) {
        throw new Error(`Không mở được tab Google Maps đọc chi tiết. ${err.message}`);
      }
    }
    const tabCheckpointSaved = await persistScrapeCheckpoint({ forceRecoverable: true });
    if (!tabCheckpointSaved) {
      throw new Error("Không lưu được tab Google Maps để khôi phục lượt quét.");
    }
    markMapsControlledActivity(120000);
    await chrome.tabs.update(scrapeState.mapsTabId, { autoDiscardable: false }).catch(() => {});
    await waitTabComplete(scrapeState.mapsTabId);
    if (scrapeState.enrichTabId) {
      await waitTabComplete(scrapeState.enrichTabId);
    }
    await sleep(1200);
    const ready = await ensureMapsContentReady(scrapeState.mapsTabId);
    if (!ready) {
      await parkGridCellUntilRendererReady(cellIndex, {
        restartFromTop: true,
        reason: "initial_renderer_unavailable"
      });
      return;
    }
    if (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) {
      const enrichReady = await ensureMapsContentReady(scrapeState.enrichTabId);
      if (!enrichReady) {
        throw new Error("Không kết nối được tab Google Maps đọc chi tiết cho chế độ quét nhanh.");
      }
    }
    notifyProgress(
      5,
      buildProgressText(cell, cellIndex, scrapeState.totalCells, {
        action: "Đang tải danh sách điểm bán…"
      })
    );
  } else {
    try {
      const signature = await sendMapsMessageWithTimeout("GET_FEED_SIGNATURE", {}, 5000);
      previousFeedSignature = String(signature?.signature || "");
      previousFeedInstanceId = String(signature?.instanceId || "");
    } catch {}

    notifyProgress(
      calcProgressPercent(cellIndex, scrapeState.totalCells),
      buildProgressText(cell, cellIndex, scrapeState.totalCells, {
        action:
          continuingSameCell
            ? `Đang cuộn tiếp từ ${pendingCellPlaces.length} URL đã lưu…`
            : retryingSameCell
            ? "Đang tải lại khu vực chưa tới cuối danh sách…"
            : "Đang chuyển sang khu vực tiếp theo…"
      })
    );
    if (retryingSameCell) {
      if (continuingSameCell) {
        const resumeLease = scrapeState._cellResumeLeases?.[cellIndex] || null;
        if (resumeLease) {
          const cancellation = await abortCellListLeaseForContinuation(
            scrapeState.mapsTabId,
            resumeLease
          );
          if (cancellation.reloadFailed) {
            await parkGridCellUntilRendererReady(cellIndex, {
              restartFromTop: true,
              reason: "resume_barrier_unavailable"
            });
            return;
          }
          if (scrapeState._cellResumeLeases) delete scrapeState._cellResumeLeases[cellIndex];
          if (cancellation.reloaded) resumeFromCurrent = false;
        }
      } else {
        scrapeState._expectMapsNavigation = true;
        markMapsControlledActivity(120000);
        try {
          try {
            await chrome.tabs.reload(scrapeState.mapsTabId);
            await waitTabComplete(scrapeState.mapsTabId);
          } catch (err) {
            await focusMapsTabForRecovery(
              "Google Maps không tải lại được khu vực đang quét. Findmap đã đưa tab lên trước để thử lại.",
              { force: true }
            );
            await navigateMapsTab({ url });
          }
        } finally {
          scrapeState._expectMapsNavigation = false;
        }
      }
    } else {
      await navigateMapsTab({ url });
    }
    await sleep(1100);
  }

  if (!scrapeState.running || cellGen !== scrapeState.cellGeneration) return;
  const readyForCellList = await ensureMapsContentReady(scrapeState.mapsTabId);
  if (!readyForCellList) {
    await parkGridCellUntilRendererReady(cellIndex, {
      restartFromTop: !resumeFromCurrent,
      reason: "cell_preflight_unavailable"
    });
    return;
  }
  scrapeState._pendingGridContinuation = -1;
  if (scrapeState._cellRestartFlags) delete scrapeState._cellRestartFlags[cellIndex];

  // Persist the new lease/generation before the long Maps request so a worker
  // restart cannot revive an older lease or lose the tabs that were just opened.
  const launchCheckpointSaved = await persistScrapeCheckpoint({ forceRecoverable: true });
  if (!launchCheckpointSaved) {
    throw new Error("Không lưu được tiến độ trước khi cuộn Google Maps.");
  }

  let result;
  const cellStartedAt = Date.now();
  const cellElapsed = () => Math.round((Date.now() - cellStartedAt) / 1000);
  bgLog(`Ô ${cellIndex + 1}/${scrapeState.totalCells} bắt đầu · budget ${CELL_LIST_TIMEOUT_MS / 1000}s`);
  const cellWorkToken = beginMapsCellWork();
  const cellListWorkToken = beginMapsCellListWork(lease);
  try {
    if (continuingSameCell) await warnIfMapsListNotForeground();
    else await activateMapsTabForCellList();
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
        previousFeedSignature,
        previousFeedInstanceId,
        requireFeedChange,
        resumeFromCurrent,
        navigateInPage: false
      },
      CELL_LIST_TIMEOUT_MS
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
    const isMessageTimeout = err?.code === "MAPS_MESSAGE_TIMEOUT";
    let resumeAfterTimeout = true;
    if (isMessageTimeout && scrapeState.mapsTabId) {
      try {
        const cancellation = await abortCellListLeaseForContinuation(
          scrapeState.mapsTabId,
          lease
        );
        if (cancellation.reloadFailed) {
          const resumeLeases =
            scrapeState._cellResumeLeases || (scrapeState._cellResumeLeases = {});
          resumeLeases[cellIndex] = lease;
        }
        resumeAfterTimeout = cancellation.settled === true;
      } catch (cancelErr) {
        bgLog(`Không dựng được barrier sau timeout ô ${cellIndex + 1}: ${cancelErr.message}`);
        resumeAfterTimeout = false;
      }
    } else {
      await sendTabMessageWithTimeout(
        scrapeState.mapsTabId,
        { action: "SCRAPE_ABORT", data: lease },
        4000
      ).catch(() => {});
    }
    result = {
      success: false,
      reachedEnd: false,
      reason: isMessageTimeout ? "message_timeout" : "message_error",
      error: err.message,
      places: [],
      skippedCount: 0,
      clickAttempts: 0,
      resumeFromCurrent: resumeAfterTimeout,
      ...lease
    };
  } finally {
    endMapsCellListWork(cellListWorkToken);
    endMapsCellWork(cellWorkToken);
  }

  if (!scrapeState.running || cellGen !== scrapeState.cellGeneration) return;

  if (!RunLease.same(lease, result)) {
    notifyPopup(`Đã bỏ qua dữ liệu cũ của khu vực ${cellIndex + 1}.`);
    return;
  }

  const pendingCountBefore = getPendingCellPlaces(cellIndex).length;
  const stampedPlaces = stampCellPlacesForEnrich(result?.places, cellIndex);
  if (stampedPlaces.length) stagePendingCellPlaces(cellIndex, stampedPlaces);
  const pendingCountAfter = getPendingCellPlaces(cellIndex).length;
  const progress = updateCellListProgress(cellIndex, {
    ...result,
    stagedNewPlacesCount: Math.max(0, pendingCountAfter - pendingCountBefore)
  });
  if (progress.urlGrew) markMapsDataActivity();

  if (!isCompleteCellResult(result)) {
    await persistScrapeCheckpoint();
    await retryIncompleteGridCell(
      cellIndex,
      result?.reason || result?.error || "content_incomplete",
      progress
    );
    return;
  }

  const completeCellPlaces = getPendingCellPlaces(cellIndex);

  await handleCellListComplete({
    places: completeCellPlaces,
    skippedCount: result?.skippedCount || 0,
    clickAttempts: result?.clickAttempts || 0,
    reachedEnd: result?.reachedEnd === true,
    cellIndex,
    totalCells: scrapeState.totalCells
  });
}

function normalizePlaceDetailUrl(raw) {
  raw = String(raw || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://www.google.com");
    if (url.protocol !== "https:" || url.hostname !== "www.google.com") return "";
    if (!url.pathname.includes("/maps/place/")) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function getPlaceDetailUrl(place) {
  for (const raw of [place?.href, place?.mapsUrl]) {
    const detailUrl = normalizePlaceDetailUrl(raw);
    if (detailUrl) return detailUrl;
  }
  return "";
}

function getCanonicalEnrichPlaceId(place) {
  let fallback = "";
  for (const raw of [place?.googlePlaceId, place?.placeId, place?.href, place?.mapsUrl]) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const canonical = /^ChIJ[a-zA-Z0-9_-]+$/i.test(value)
      ? value
      : getCanonicalPlaceId(value);
    if (!canonical) continue;
    const normalized = String(canonical).toLowerCase();
    if (normalized.startsWith("chij")) return normalized;
    if (!fallback) fallback = normalized;
  }
  return fallback;
}

function getStableEnrichKey(place) {
  const canonicalId = getCanonicalEnrichPlaceId(place);
  if (canonicalId) return `cid:${canonicalId}`;

  const detailUrl = getPlaceDetailUrl(place);
  if (detailUrl) {
    try {
      const url = new URL(detailUrl);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      return `url:${url.origin}${pathname}`;
    } catch {}
  }
  return String(getDedupeKey(place || {}));
}

function getEnrichCheckpointKey(place) {
  return String(place?._enrichKey || getStableEnrichKey(place));
}

function preserveEnrichMetadata(enriched, source) {
  if (!enriched) return enriched;
  enriched._enrichKey = getEnrichCheckpointKey(source);
  enriched._enrichCellIndex = source?._enrichCellIndex;
  enriched._enrichCellLat = source?._enrichCellLat;
  enriched._enrichCellLng = source?._enrichCellLng;
  enriched._enrichSearchUrl = source?._enrichSearchUrl;
  return enriched;
}

async function persistEnrichAttemptProgress(cellIndex, processed, totalEnrich) {
  scrapeState._enrichActivityAt = Date.now();
  scrapeState._lastEnrichRecoveryFocusDataAt = 0;
  scheduleLiveSearchBackup(true);
  const ratio = totalEnrich > 0 ? Math.min(processed / totalEnrich, 1) : 1;
  const pct = calcProgressPercent(cellIndex, scrapeState.totalCells, 0.5 + ratio * 0.48);
  scheduleSyncSnapshot(
    `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · Đã đọc ${processed}/${totalEnrich} URL chi tiết`,
    pct
  );
  await persistScrapeCheckpoint();
}

async function markEnrichAttemptComplete(place, cellIndex, processed, totalEnrich) {
  const key = getEnrichCheckpointKey(place);
  scrapeState.enrichedPlaceKeys.add(key);
  scrapeState.failedEnrichKeys.delete(key);
  await persistEnrichAttemptProgress(cellIndex, processed, totalEnrich);
}

const ENRICH_ABORT_TIMEOUT_MS = 12000;

async function reloadMapsAfterUnsettledEnrich(tabId) {
  scrapeState._expectMapsNavigation = true;
  markMapsControlledActivity(60000);
  try {
    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId, 30000);
    await sleep(900);
    const ready = await ensureMapsContentReady(tabId);
    if (!ready) {
      throw new Error("Không thể khởi tạo lại Google Maps sau khi thao tác chi tiết cũ chưa dừng.");
    }
  } finally {
    scrapeState._expectMapsNavigation = false;
  }
}

async function cancelActiveEnrichOperation({ timeoutMs = ENRICH_ABORT_TIMEOUT_MS } = {}) {
  const opId = String(scrapeState._activeEnrichOpId || "");
  const tabId = scrapeState.mapsTabId;
  if (!opId || !tabId) return { settled: true, reloaded: false };

  let timer = null;
  let response = null;
  try {
    response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: "ENRICH_ABORT", data: { opId } }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Google Maps không xác nhận thao tác chi tiết cũ đã dừng.")),
          timeoutMs
        );
      })
    ]);
  } catch (err) {
    bgLog(`Không xác nhận được ENRICH_ABORT ${opId}: ${err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const settled =
    response?.success === true &&
    response?.opId === opId &&
    response?.settled === true;
  if (!settled) {
    bgLog(`ENRICH_ABORT ${opId} chưa settled; tải lại Maps trước URL tiếp theo.`);
    await reloadMapsAfterUnsettledEnrich(tabId);
  }
  if (scrapeState._activeEnrichOpId === opId) scrapeState._activeEnrichOpId = "";
  return { settled, reloaded: !settled };
}

async function enrichPlaceByUrl(
  place,
  params,
  progressText,
  pct,
  attempt,
  enrichGeneration = Number(scrapeState._enrichGeneration || 0)
) {
  const href = getPlaceDetailUrl(place);
  if (!href) return null;
  const opId = `${scrapeState.runId}:${scrapeState.gridIndex}:${attempt}:${crypto.randomUUID()}`;
  let operationStarted = false;

  const cellWorkToken = beginMapsCellWork();
  try {
    await cancelActiveEnrichOperation();
    if (Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)) {
      return null;
    }
    scrapeState._activeEnrichOpId = opId;
    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    operationStarted = true;
    await navigateMapsTab({ url: href });
    await sleep(650);

    const result = await sendMapsMessageWithTimeout(
      "ENRICH_PLACE",
      {
        searchParams: params,
        listData: place,
        progressText,
        percent: pct,
        thorough: true,
        opId
      },
      50000
    );

    if (Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)) return null;

    if (result?.opId === opId && result?.settled === false) {
      await reloadMapsAfterUnsettledEnrich(scrapeState.mapsTabId);
      if (scrapeState._activeEnrichOpId === opId) scrapeState._activeEnrichOpId = "";
      operationStarted = false;
      throw new Error("Thao tác chi tiết cũ chưa dừng; Google Maps đã được tải lại an toàn.");
    }
    if (result?.opId !== opId || result?.success !== true) return null;
    return result.place || null;
  } catch (err) {
    if (operationStarted && scrapeState._activeEnrichOpId === opId) {
      await cancelActiveEnrichOperation();
    }
    throw err;
  } finally {
    if (scrapeState._activeEnrichOpId === opId) scrapeState._activeEnrichOpId = "";
    endMapsCellWork(cellWorkToken);
  }
}

async function markEnrichFailure(place, cellIndex, processed, totalEnrich, error) {
  const key = getEnrichCheckpointKey(place);
  scrapeState.failedEnrichKeys.add(key);
  bgLog(
    `Bỏ qua URL chi tiết sau khi đã retry: ${place.name || key} · ${error?.message || error || "không rõ lỗi"}`
  );
  notifyPopup(
    `Không đọc được chi tiết của ${place.name || "một điểm bán"}; Findmap giữ dữ liệu danh sách và tiếp tục.`
  );
  await persistEnrichAttemptProgress(cellIndex, processed, totalEnrich);
}

async function enrichPlacesInCell(
  cellPlaces,
  cellIndex,
  params,
  processed,
  totalEnrich,
  enrichGeneration = Number(scrapeState._enrichGeneration || 0)
) {
  let done = processed;

  for (const place of cellPlaces) {
    if (
      !scrapeState.running ||
      Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)
    ) break;
    const key = getEnrichCheckpointKey(place);
    if (
      scrapeState.enrichedPlaceKeys.has(key) ||
      scrapeState.failedEnrichKeys.has(key)
    ) {
      continue;
    }

    done += 1;
    const href = getPlaceDetailUrl(place);
    if (!href) {
      await markEnrichFailure(
        place,
        cellIndex,
        done,
        totalEnrich,
        new Error("Thiếu URL chi tiết Google Maps hợp lệ.")
      );
      continue;
    }

    const pct = calcProgressPercent(
      cellIndex,
      scrapeState.totalCells,
      0.5 + (done / Math.max(totalEnrich, 1)) * 0.48
    );
    const progressText =
      `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · ` +
      `Đang mở URL ${done}/${totalEnrich}: ${place.name}`;
    notifyProgress(pct, progressText);

    let enriched = null;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_DIRECT_URL_RETRIES; attempt++) {
      if (
        !scrapeState.running ||
        Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)
      ) break;
      try {
        enriched = preserveEnrichMetadata(
          await enrichPlaceByUrl(place, params, progressText, pct, attempt, enrichGeneration),
          place
        );
        if (enriched) break;
        lastError = new Error("Trang chi tiết không trả về dữ liệu hợp lệ.");
      } catch (err) {
        if (Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)) return done;
        lastError = err;
        console.warn(
          `Mở URL chi tiết thất bại (${attempt}/${MAX_DIRECT_URL_RETRIES}):`,
          place.name,
          err.message
        );
      }
      if (!enriched && attempt < MAX_DIRECT_URL_RETRIES) {
        await sleep(Math.min(4000, 900 * attempt));
      }
    }

    if (
      !scrapeState.running ||
      Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)
    ) break;
    if (!enriched) {
      await markEnrichFailure(
        place,
        cellIndex,
        done,
        totalEnrich,
        lastError || new Error("Google Maps không trả dữ liệu.")
      );
      continue;
    }

    upsertMergedPlace(enriched);
    sendItemToWeb(params.webUrl, enriched, params);
    await markEnrichAttemptComplete(place, cellIndex, done, totalEnrich);
  }

  return done;
}

function getQuickPendingEnrichPlaces() {
  if (!(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true)) return [];
  const pending = [];
  for (const place of scrapeState.mergedPlaces.values()) {
    const key = getEnrichCheckpointKey(place);
    if (scrapeState.enrichedPlaceKeys.has(key) || scrapeState.failedEnrichKeys.has(key)) continue;
    pending.push(place);
  }
  return pending;
}

async function ensureQuickEnrichTab(fallbackUrl = "") {
  if (
    !(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) ||
    !scrapeState.running
  ) {
    return false;
  }
  if (Number.isInteger(scrapeState.enrichTabId)) {
    try {
      await chrome.tabs.get(scrapeState.enrichTabId);
      return true;
    } catch {
      scrapeState.enrichTabId = null;
      scrapeState.enrichWindowId = null;
    }
  }

  const firstPendingUrl = getPlaceDetailUrl(getQuickPendingEnrichPlaces()[0]);
  const cell = scrapeState.gridPoints[Math.min(scrapeState.gridIndex, scrapeState.totalCells - 1)];
  const searchUrl = cell
    ? buildMapsUrl(
        scrapeState.searchParams.keyword,
        cell.lat,
        cell.lng,
        scrapeState.viewportM
      )
    : "https://www.google.com/maps";
  const tab = await openQuickEnrichTab(firstPendingUrl || fallbackUrl || searchUrl);
  await waitTabComplete(tab.id, 30000);
  await sleep(900);
  return ensureMapsContentReady(tab.id);
}

async function cancelQuickEnrichOperation(tabId, { timeoutMs = ENRICH_ABORT_TIMEOUT_MS } = {}) {
  const opId = String(scrapeState._activeEnrichOpId || "");
  if (!opId || !Number.isInteger(tabId)) return { settled: true, reloaded: false };

  let timer = null;
  let response = null;
  try {
    response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: "ENRICH_ABORT", data: { opId } }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tab đọc chi tiết không xác nhận thao tác cũ đã dừng.")),
          timeoutMs
        );
      })
    ]);
  } catch (err) {
    bgLog(`Không xác nhận được ENRICH_ABORT ${opId} ở tab đọc chi tiết: ${err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const settled =
    response?.success === true && response?.opId === opId && response?.settled === true;
  if (!settled) await reloadMapsAfterUnsettledEnrich(tabId);
  if (scrapeState._activeEnrichOpId === opId) scrapeState._activeEnrichOpId = "";
  return { settled, reloaded: !settled };
}

async function enrichQuickPlaceByUrl(
  place,
  params,
  progressText,
  pct,
  attempt,
  enrichGeneration
) {
  const href = getPlaceDetailUrl(place);
  const tabId = scrapeState.enrichTabId;
  if (!href || !Number.isInteger(tabId)) return null;
  const opId = `${scrapeState.runId}:quick:${attempt}:${crypto.randomUUID()}`;
  let operationStarted = false;
  const workToken = beginQuickEnrichWork();

  try {
    await cancelQuickEnrichOperation(tabId);
    if (Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)) return null;
    scrapeState._activeEnrichOpId = opId;
    scrapeState._enrichActivityAt = Date.now();
    await persistScrapeCheckpoint();
    operationStarted = true;

    try {
      await chrome.tabs.update(tabId, { url: href, autoDiscardable: false });
    } catch (err) {
      await focusMapsTabAfterFailure(
        tabId,
        "Tab Google Maps đọc chi tiết không nhận được URL. Findmap đã đưa tab lên trước để thử lại."
      );
      await chrome.tabs.update(tabId, { url: href, autoDiscardable: false });
    }
    await waitTabComplete(tabId, 30000);
    await sleep(650);

    const result = await sendMapsMessageToTab(
      tabId,
      "ENRICH_PLACE",
      {
        searchParams: params,
        listData: place,
        progressText,
        percent: pct,
        thorough: true,
        opId
      },
      50000
    );

    if (Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)) return null;
    if (result?.opId === opId && result?.settled === false) {
      await reloadMapsAfterUnsettledEnrich(tabId);
      operationStarted = false;
      throw new Error("Thao tác chi tiết cũ chưa dừng; tab đọc chi tiết đã được tải lại.");
    }
    if (result?.opId !== opId || result?.success !== true) return null;
    return result.place || null;
  } catch (err) {
    if (operationStarted && scrapeState._activeEnrichOpId === opId) {
      await cancelQuickEnrichOperation(tabId);
    }
    throw err;
  } finally {
    if (scrapeState._activeEnrichOpId === opId) scrapeState._activeEnrichOpId = "";
    endQuickEnrichWork(workToken);
  }
}

async function completeQuickScanIfReady(enrichGeneration) {
  if (
    !scrapeState.running ||
    !(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) ||
    !scrapeState.quickProducerDone ||
    Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0) ||
    getQuickPendingEnrichPlaces().length > 0
  ) {
    return false;
  }

  const total = getFinalResultsList().length;
  if (total === 0) {
    await handleScrapeComplete({ searchParams: scrapeState.searchParams });
    return true;
  }

  notifyProgress(95, `Đã lấy hết danh sách và đọc xong ${total} điểm bán…`);
  await Promise.all(
    [scrapeState.mapsTabId, scrapeState.enrichTabId]
      .filter(Number.isInteger)
      .map((tabId) =>
        chrome.tabs.sendMessage(tabId, { action: "SCRAPE_FINISH", data: {} }).catch(() => null)
      )
  );
  await handleScrapeComplete({ searchParams: scrapeState.searchParams });
  return true;
}

async function runQuickEnrichPhaseInternal(
  enrichGeneration = Number(scrapeState._enrichGeneration || 0)
) {
  const params = scrapeState.searchParams;
  if (
    !params ||
    !(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true)
  ) return false;
  if (!(await ensureQuickEnrichTab())) {
    throw new Error("Không kết nối được tab Google Maps đọc chi tiết.");
  }

  while (
    scrapeState.running &&
    Number(enrichGeneration) === Number(scrapeState._enrichGeneration || 0)
  ) {
    const pending = getQuickPendingEnrichPlaces();
    if (!pending.length) break;

    const place = pending[0];
    const cellIndex = Math.max(0, Number(place._enrichCellIndex || 0));
    const totalEnrich = Math.max(scrapeState.mergedPlaces.size, scrapeState.enrichTotal || 0);
    scrapeState.enrichTotal = totalEnrich;
    const processed = Math.max(0, totalEnrich - pending.length) + 1;
    const pct = Math.min(
      94,
      Math.max(
        5,
        Math.round(
          ((scrapeState.gridIndex + 1) / Math.max(scrapeState.totalCells, 1)) * 55 +
            (processed / Math.max(totalEnrich, 1)) * 38
        )
      )
    );
    const progressText =
      `Quét nhanh · Tab danh sách vùng ${Math.min(scrapeState.gridIndex + 1, scrapeState.totalCells)}` +
      `/${scrapeState.totalCells} · Tab chi tiết ${processed}/${totalEnrich}: ${place.name || "địa điểm"}`;
    notifyProgress(pct, progressText);

    const href = getPlaceDetailUrl(place);
    if (!href) {
      await markEnrichFailure(
        place,
        cellIndex,
        processed,
        totalEnrich,
        new Error("Thiếu URL chi tiết Google Maps hợp lệ.")
      );
      continue;
    }

    let enriched = null;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_DIRECT_URL_RETRIES; attempt++) {
      if (
        !scrapeState.running ||
        Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)
      ) {
        break;
      }
      try {
        enriched = preserveEnrichMetadata(
          await enrichQuickPlaceByUrl(
            place,
            params,
            progressText,
            pct,
            attempt,
            enrichGeneration
          ),
          place
        );
        if (enriched) break;
        lastError = new Error("Trang chi tiết không trả về dữ liệu hợp lệ.");
      } catch (err) {
        lastError = err;
        if (Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)) break;
        console.warn(
          `Tab đọc chi tiết thất bại (${attempt}/${MAX_DIRECT_URL_RETRIES}):`,
          place.name,
          err.message
        );
      }
      if (!enriched && attempt < MAX_DIRECT_URL_RETRIES) {
        await sleep(Math.min(4000, 900 * attempt));
      }
    }

    if (
      !scrapeState.running ||
      Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)
    ) {
      break;
    }
    if (!enriched) {
      await markEnrichFailure(
        place,
        cellIndex,
        processed,
        totalEnrich,
        lastError || new Error("Google Maps không trả dữ liệu.")
      );
      continue;
    }

    upsertMergedPlace(enriched);
    sendItemToWeb(params.webUrl, enriched, params);
    await markEnrichAttemptComplete(place, cellIndex, processed, totalEnrich);
  }

  return completeQuickScanIfReady(enrichGeneration);
}

function runQuickEnrichPhase() {
  if (!(scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true)) {
    return Promise.resolve(false);
  }
  if (quickEnrichRunPromise) return quickEnrichRunPromise;
  const enrichGeneration = Number(scrapeState._enrichGeneration || 0);
  const task = runQuickEnrichPhaseInternal(enrichGeneration);
  quickEnrichRunPromise = task;
  task.finally(() => {
    if (quickEnrichRunPromise === task) quickEnrichRunPromise = null;
  }).catch(() => {});
  return task;
}

async function waitForQuickQueueCapacity() {
  let warned = false;
  while (
    scrapeState.running &&
    (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) &&
    getQuickPendingEnrichPlaces().length >= QUICK_SCAN_QUEUE_LIMIT
  ) {
    if (!warned) {
      warned = true;
      notifyProgress(
        calcProgressPercent(scrapeState.gridIndex, scrapeState.totalCells, 0.75),
        `Quét nhanh · Đã lưu ${getQuickPendingEnrichPlaces().length} URL. ` +
          "Tạm chờ tab đọc chi tiết xử lý bớt trước khi cuộn vùng tiếp theo…"
      );
    }
    runQuickEnrichPhase().catch(() => {});
    await sleep(1200);
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

async function handleQuickCellListComplete(data) {
  const { places, cellIndex, totalCells, skippedCount = 0 } = data;
  const beforeCount = scrapeState.mergedPlaces.size;
  bgLog(`Ô ${cellIndex + 1} đã xác nhận CUỐI DANH SÁCH · nhận ${places.length} điểm từ content`);
  scrapeState.gridIndex = cellIndex;
  mergePlaces(places);
  clearPendingCellPlaces(cellIndex);
  if (scrapeState._cellContinueFlags) delete scrapeState._cellContinueFlags[cellIndex];
  if (scrapeState._cellRestartFlags) delete scrapeState._cellRestartFlags[cellIndex];
  if (scrapeState._cellResumeLeases) delete scrapeState._cellResumeLeases[cellIndex];
  scrapeState.phase = "grid";
  const newUnique = scrapeState.mergedPlaces.size - beforeCount;
  scheduleLiveSearchBackup(true);

  const cell = scrapeState.gridPoints[cellIndex];
  const total = getFinalResultsList().length;
  const pct = calcProgressPercent(cellIndex, totalCells, 0.48);
  const progressText = buildProgressText(cell, cellIndex, totalCells, {
    newCount: newUnique,
    skipped: skippedCount,
    total,
    action: `Quét nhanh · Tab danh sách đã lưu ${places.length} URL chi tiết`
  });
  scheduleSyncSnapshot(progressText, pct, true);
  notifyProgress(pct, progressText);

  scrapeState.completedCells.add(cellIndex);
  clearCellListProgress(cellIndex);
  scrapeState.enrichTotal = Math.max(scrapeState.enrichTotal, scrapeState.mergedPlaces.size);
  const nextIndex = cellIndex + 1;
  scrapeState.quickProducerDone = nextIndex >= scrapeState.totalCells;
  if (scrapeState.quickProducerDone) scrapeState.phase = "enrich";
  await persistScrapeCheckpoint();

  runQuickEnrichPhase().catch(async (err) => {
    if (scrapeState.running && !pointsFinalized) {
      await abortSearch("QUICK_ENRICH_FAILED", err?.message || String(err), {
        chargePartial: true
      });
    }
  });

  if (scrapeState.quickProducerDone) {
    await runQuickEnrichPhase();
    return;
  }

  await waitForQuickQueueCapacity();
  if (!scrapeState.running || pointsFinalized) return;
  scrapeState.gridIndex = nextIndex;
  await persistScrapeCheckpoint();
  return runGridCell(nextIndex);
}

async function handleCellListComplete(data) {
  const {
    places,
    cellIndex,
    totalCells,
    skippedCount = 0,
    reachedEnd = false
  } = data;
  if (!reachedEnd) {
    await retryIncompleteGridCell(cellIndex, "missing_end_marker");
    return;
  }
  if (scrapeState.quickScan === true || scrapeState.searchParams?.quickScan === true) {
    return handleQuickCellListComplete(data);
  }

  const beforeCount = scrapeState.mergedPlaces.size;
  bgLog(`Ô ${cellIndex + 1} đã xác nhận CUỐI DANH SÁCH · nhận ${places.length} điểm từ content`);
  scrapeState.gridIndex = cellIndex;
  mergePlaces(places);
  clearPendingCellPlaces(cellIndex);
  if (scrapeState._cellContinueFlags) delete scrapeState._cellContinueFlags[cellIndex];
  if (scrapeState._cellRestartFlags) delete scrapeState._cellRestartFlags[cellIndex];
  if (scrapeState._cellResumeLeases) delete scrapeState._cellResumeLeases[cellIndex];
  scrapeState.phase = "enrich";
  scrapeState.enrichTotal = 0;
  const newUnique = scrapeState.mergedPlaces.size - beforeCount;
  scheduleLiveSearchBackup(true);

  const cell = scrapeState.gridPoints[cellIndex];
  const total = getFinalResultsList().length;
  const pct = calcProgressPercent(cellIndex, totalCells, 0.48);
  const progressText = buildProgressText(cell, cellIndex, totalCells, {
    newCount: newUnique,
    skipped: skippedCount,
    total,
    action: `Đã tải tới cuối danh sách · Đã lưu ${places.length} URL chi tiết`
  });

  scheduleSyncSnapshot(progressText, pct, true);
  notifyProgress(pct, progressText);
  await persistScrapeCheckpoint();
  await runEnrichPhase();
}

async function completeCellAfterEnrich(
  cellIndex,
  enrichGeneration = Number(scrapeState._enrichGeneration || 0)
) {
  if (
    !scrapeState.running ||
    Number(enrichGeneration) !== Number(scrapeState._enrichGeneration || 0)
  ) {
    return;
  }

  scrapeState.completedCells.add(cellIndex);
  resetScrapePhaseStallClock();
  scrapeState.phase = "grid";
  scrapeState.enrichTotal = 0;
  if (scrapeState._cellRetryCounts) delete scrapeState._cellRetryCounts[cellIndex];
  if (scrapeState._cellRecoveryCounts) delete scrapeState._cellRecoveryCounts[cellIndex];
  if (scrapeState._cellContinueFlags) delete scrapeState._cellContinueFlags[cellIndex];
  if (scrapeState._cellRestartFlags) delete scrapeState._cellRestartFlags[cellIndex];
  if (scrapeState._cellResumeLeases) delete scrapeState._cellResumeLeases[cellIndex];
  clearCellListProgress(cellIndex);
  clearPendingCellPlaces(cellIndex);

  const total = getFinalResultsList().length;
  const pct = calcProgressPercent(cellIndex, scrapeState.totalCells, 1);
  const text =
    `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · ` +
    `Đã cuộn và đọc xong URL · Tổng ${total} điểm bán`;
  notifyProgress(pct, text);
  scheduleSyncSnapshot(text, pct, true);
  await persistScrapeCheckpoint();

  const nextIndex = cellIndex + 1;
  if (nextIndex < scrapeState.totalCells) {
    scrapeState.gridIndex = nextIndex;
    return nextIndex;
  }

  if (total === 0) {
    await handleScrapeComplete({ searchParams: scrapeState.searchParams });
    return null;
  }

  notifyProgress(95, `Đang hoàn tất ${total} điểm bán…`);
  try {
    await sendMapsMessage("SCRAPE_FINISH", {});
  } catch {}
  await handleScrapeComplete({ searchParams: scrapeState.searchParams });
  return null;
}

function continueGridAfterEnrich(nextIndex) {
  if (!Number.isInteger(nextIndex) || !scrapeState.running || pointsFinalized) return;
  runGridCell(nextIndex)
    .catch(async (err) => {
      if (scrapeState.running && !pointsFinalized) {
        await abortSearch("SCRAPE_FAILED", err?.message || String(err));
      }
    })
    .catch((err) => console.warn("runGridCell after enrich:", err?.message || err));
}

function runEnrichPhase() {
  if (enrichRunPromise) return enrichRunPromise;
  const enrichGeneration = Number(scrapeState._enrichGeneration || 0);
  const task = runEnrichPhaseInternal(enrichGeneration);
  enrichRunPromise = task;
  task
    .then(
      (nextIndex) => {
        if (enrichRunPromise === task) enrichRunPromise = null;
        if (enrichGeneration !== Number(scrapeState._enrichGeneration || 0)) return;
        continueGridAfterEnrich(nextIndex);
      },
      () => {
        if (enrichRunPromise === task) enrichRunPromise = null;
      }
    )
    .catch(() => {});
  return task;
}

async function runEnrichPhaseInternal(enrichGeneration = Number(scrapeState._enrichGeneration || 0)) {
  const params = scrapeState.searchParams;
  if (!params || !scrapeState.mapsTabId) {
    await handleScrapeComplete({ searchParams: params });
    return;
  }

  scrapeState.phase = "enrich";
  scrapeState._enrichActivityAt = Date.now();
  await persistScrapeCheckpoint();
  const cellIndex = scrapeState.gridIndex;
  const list = getFinalResultsList();
  const cellPlaces = list.filter(
    (place) => Number(place._enrichCellIndex) === Number(cellIndex)
  );
  const toEnrich = cellPlaces.filter((place) => {
    const key = getEnrichCheckpointKey(place);
    return (
      !scrapeState.enrichedPlaceKeys.has(key) &&
      !scrapeState.failedEnrichKeys.has(key)
    );
  });
  if (!scrapeState.enrichTotal) {
    scrapeState.enrichTotal = cellPlaces.length;
    await persistScrapeCheckpoint();
  }
  const totalEnrich = Math.max(scrapeState.enrichTotal, cellPlaces.length);
  scrapeState.enrichTotal = totalEnrich;
  let processed = Math.max(0, totalEnrich - toEnrich.length);

  if (toEnrich.length > 0) {
    const pct = calcProgressPercent(
      cellIndex,
      scrapeState.totalCells,
      0.5 + (processed / Math.max(totalEnrich, 1)) * 0.48
    );
    notifyProgress(
      pct,
      `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · ` +
        `Đã cuộn đủ ${cellPlaces.length} điểm · Bắt đầu mở URL ${processed + 1}/${totalEnrich}…`
    );

    try {
      await sendMapsMessage("SCRAPE_SHIELD_UPDATE", {
        text:
          `Khu vực ${cellIndex + 1}/${scrapeState.totalCells} · ` +
          `Đang mở từng URL chi tiết · ${processed}/${totalEnrich}`,
        percent: pct
      });
    } catch {}

    processed = await enrichPlacesInCell(
      toEnrich,
      cellIndex,
      params,
      processed,
      totalEnrich,
      enrichGeneration
    );
  }

  if (
    !scrapeState.running ||
    enrichGeneration !== Number(scrapeState._enrichGeneration || 0)
  ) {
    return;
  }
  return completeCellAfterEnrich(cellIndex, enrichGeneration);
}

async function closeMapsTabSafely() {
  const tabIds = [...new Set([scrapeState.mapsTabId, scrapeState.enrichTabId].filter(Number.isInteger))];
  clearMapsCellWorkTokens();
  scrapeState.mapsTabId = null;
  scrapeState.mapsWindowId = null;
  scrapeState.enrichTabId = null;
  scrapeState.enrichWindowId = null;
  if (!tabIds.length) return;
  await Promise.all(tabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
}

async function handleScrapeComplete(data) {
  if (pointsFinalized) return { success: true, alreadyFinalized: true };
  const transitionToken = beginOperationTransition("complete-search");
  try {
  pointsFinalized = true;

  const { searchParams, partial, partialReason, partialCode } = data;
  const finalResults = getFinalResultsList();

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
    detailFailures: scrapeState.failedEnrichKeys.size,
    total: finalResults.length,
    totalFound: finalResults.length,
    completedAt: new Date().toISOString(),
    partial: !!partial,
    partialReason: partialReason || null,
    partialCode: partialCode || null
  };

  // Snapshot recoverable là nguồn full results duy nhất; marker pending chỉ tham chiếu checkpoint.
  const prepared = await preparePendingComplete(completePayload);
  if (!prepared) await ensureDurableWorkAlarm();
  await closeMapsTabSafely();

  let sent = false;
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
    for (let i = 0; i < 8 && !sent; i++) {
      sent = await sendToWebPage(searchParams.webUrl, "complete", completePayload);
      if (!sent) await sleep(1500);
    }
    if (sent) {
      await clearPendingComplete();
      await clearScrapeCheckpoint();
    } else {
      await ensureDurableWorkAlarm();
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
    await resetScrapeState({ preserveCheckpoint: !sent });
  }
  return { success: true };
  } finally {
    endOperationTransition(transitionToken);
  }
}

const PRIVILEGED_WEB_ACTIONS = new Set([
  "START_SEARCH",
  "CANCEL_SEARCH",
  "PAUSE_SEARCH",
  "ABANDON_SEARCH",
  "REQUEST_SEARCH_SYNC",
  "GET_SEARCH_STATUS",
  "SET_MAPS_AUTO_FOCUS",
  "SET_MAPS_AUTO_REOPEN",
  "RESUME_SEARCH",
  "START_RESCAN",
  "GET_RESCAN_STATUS",
  "GET_SESSION",
  "GET_MAPS_CENTER",
  "SAVE_SESSION"
]);

function getRuntimeSenderOrigin(sender) {
  for (const raw of [sender?.origin, sender?.url, sender?.tab?.url]) {
    try {
      const url = new URL(String(raw || ""));
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {}
  }
  return "";
}

function isOwnExtensionPageSender(sender) {
  if (!sender?.id || sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  return [sender?.origin, sender?.url].some((raw) =>
    String(raw || "").startsWith(extensionOrigin)
  );
}

function isTrustedFindmapSender(sender) {
  if (isOwnExtensionPageSender(sender)) return true;
  if (!sender?.id || sender.id !== chrome.runtime.id) return false;
  const origin = getRuntimeSenderOrigin(sender);
  return !!origin && getConfiguredWebOrigins().includes(origin);
}

function dispatchRuntimeMessage(message, sender, sendResponse) {
  if (PRIVILEGED_WEB_ACTIONS.has(message?.action) && !isTrustedFindmapSender(sender)) {
    sendResponse({
      ok: false,
      success: false,
      error: "Nguồn yêu cầu không thuộc Findmap."
    });
    return;
  }

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

  if (message.action === "PAUSE_SEARCH") {
    pauseActiveSearch(message.data?.reason)
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
    flushPendingComplete("web_requested_sync")
      .then(async (pending) => {
        const ok = pending.delivered
          ? true
          : await pushSearchSyncToWeb(message.data?.reason || "Đồng bộ lại sau khi tải trang");
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
    if (sender?.tab?.id === scrapeState.mapsTabId) {
      clearMapsListInterruptionWarning();
    }
    ensureWebSyncedToResults("Đồng bộ khi tab Maps active lại", true)
      .then((ok) => sendResponse({ success: ok, count: scrapeState.mergedPlaces.size }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "MAPS_TAB_HIDDEN") {
    const accepted =
      scrapeState.running &&
      scrapeState._mapsCellListActive &&
      acceptsActiveCellMessage(message, sender);
    const warned = accepted
      ? warnMapsListInterruption(sender?.tab?.id === scrapeState.mapsTabId ? null : sender?.tab?.id)
      : false;
    sendResponse({ success: accepted, warned });
    return;
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
    handleResumeSearch()
      .then(async (ok) => {
        const status = await getSearchStatus();
        await pushSearchStatusToWeb(status);
        sendResponse({ success: ok, status });
      })
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

  if (message.action === "SCRAPE_CELL_LIST_CHECKPOINT") {
    const data = message.data || {};
    const cellIndex = Number(data.cellIndex);
    const accepted =
      scrapeState.running &&
      scrapeState.phase === "grid" &&
      Number.isSafeInteger(cellIndex) &&
      cellIndex === Number(scrapeState.gridIndex) &&
      acceptsActiveCellMessage(message, sender);
    if (!accepted) {
      sendResponse({ success: false, ignored: true });
      return;
    }

    const beforeCount = getPendingCellPlaces(cellIndex).length;
    const stampedPlaces = stampCellPlacesForEnrich(data.places, cellIndex);
    if (stampedPlaces.length) stagePendingCellPlaces(cellIndex, stampedPlaces);
    const afterCount = getPendingCellPlaces(cellIndex).length;
    const progress = updateCellListProgress(cellIndex, {
      ...data,
      stagedNewPlacesCount: Math.max(0, afterCount - beforeCount),
      activeElapsedMs: 0
    });
    if (progress.urlGrew) markMapsDataActivity();
    persistScrapeCheckpoint()
      .then(() => sendResponse({ success: true, count: afterCount }))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "SCRAPE_PROGRESS") {
    if (!scrapeState.running || !acceptsActiveCellMessage(message, sender)) return;
    // Heartbeat/UI text không phải dữ liệu mới; chỉ reset mốc 5 phút khi list thực sự tăng.
    if (message.dataActivity === true) markMapsDataActivity();
    notifyProgress(message.percent, message.text);
  }

  if (message.action === "SCRAPE_ITEM") {
    if (!scrapeState.running || !acceptsActiveCellMessage(message, sender)) return;
    markMapsDataActivity();
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
  "SAVE_SESSION"
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
  const transitionToken = claimOperationStart("search");
  try {

  params.quickScan = params?.quickScan === true;

  await ensureReadyForNewSearch();
  await clearRescanCheckpoint();
  // Chắc chắn không còn tab Maps cũ trước khi mở tab mới
  await closeMapsTabSafely();

  // Xóa snapshot/checkpoint phiên cũ — tránh sync lại điểm Hà Nội vào lượt Bắc Ninh
  try {
    await clearScrapeCheckpoint();
    await chrome.storage.local.remove([
      "pendingSearchSync",
      "activeSearch",
      SCRAPE_CHECKPOINT_KEY,
      PENDING_SYNC_KEY
    ]);
  } catch {}
  if (!scrapeState.running) {
    scrapeState.mergedPlaces = new Map();
    scrapeState.pendingCellPlaces = new Map();
    scrapeState.pendingCellIndex = -1;
    scrapeState.completedCells = new Set();
    scrapeState.enrichedPlaceKeys = new Set();
    scrapeState.failedEnrichKeys = new Set();
    scrapeState.enrichTotal = 0;
    scrapeState.gridPoints = [];
    scrapeState.searchParams = null;
    scrapeState.gridIndex = 0;
    scrapeState.totalCells = 0;
    scrapeState.phase = "grid";
    scrapeState.quickScan = false;
    scrapeState.quickProducerDone = false;
    scrapeState._cellRetryCounts = {};
    scrapeState._cellRecoveryCounts = {};
    scrapeState._cellContinueFlags = {};
    scrapeState._cellRestartFlags = {};
    scrapeState._cellResumeLeases = {};
    scrapeState._pendingGridContinuation = -1;
    scrapeState._cellListProgress = {};
    scrapeState._enrichActivityAt = 0;
    scrapeState._enrichGeneration = 0;
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
  delete params.authToken;
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
  markMapsDataActivity();
  scrapeState.running = true;
  scrapeState.paused = false;
  scrapeState.pausedAt = 0;
  scrapeState.pauseReason = "";
  scrapeState.resumeRequestedAt = 0;
  scrapeState.runId = params.searchId;
  scrapeState.cellGeneration = 0;
  scrapeState.searchParams = params;
  scrapeState.webTabId = webTab.id;
  scrapeState.mapsTabId = null;
  scrapeState.mapsWindowId = null;
  scrapeState.enrichTabId = null;
  scrapeState.enrichWindowId = null;
  scrapeState.gridPoints = grid.points;
  scrapeState.gridIndex = 0;
  scrapeState.totalCells = grid.totalCells;
  scrapeState.cellSizeKm = grid.cellSizeKm;
  scrapeState.viewportM = grid.viewportM;
  scrapeState.mergedPlaces = new Map();
  scrapeState.pendingCellPlaces = new Map();
  scrapeState.pendingCellIndex = -1;
  scrapeState.completedCells = new Set();
  scrapeState.enrichedPlaceKeys = new Set();
  scrapeState.failedEnrichKeys = new Set();
  scrapeState.enrichTotal = 0;
  scrapeState.phase = "grid";
  scrapeState.quickScan = params.quickScan === true;
  scrapeState.quickProducerDone = false;
  scrapeState._retriedCells = new Set();
  scrapeState._cellRetryCounts = {};
  scrapeState._cellRecoveryCounts = {};
  scrapeState._cellContinueFlags = {};
  scrapeState._cellRestartFlags = {};
  scrapeState._cellResumeLeases = {};
  scrapeState._pendingGridContinuation = -1;
  scrapeState._cellListProgress = {};
  scrapeState._mapsReopenCount = 0;
  scrapeState._mapsUserReloadCount = 0;
  scrapeState._enrichMapsReopenCount = 0;
  scrapeState._activeEnrichOpId = "";
  scrapeState._enrichActivityAt = Date.now();
  scrapeState._enrichGeneration = 0;
  quickEnrichRunPromise = null;
  activeMapsCellListToken = null;
  scrapeState._mapsCellListActive = false;
  scrapeState._mapsCellListLease = null;
  scrapeState._mapsListWarningKey = "";
  lastSyncedMergedCount = 0;
  lastForceSyncAt = 0;
  startScrapeKeepAlive();

  scrapeState.webTabId = webTab.id;
  await chrome.tabs.update(webTab.id, { autoDiscardable: false }).catch(() => {});

  const durableParams = toDurableSearchParams(params);
  await chrome.storage.local.set({ lastSearch: durableParams, activeSearch: durableParams });
  const initialCheckpointSaved = await persistScrapeCheckpoint();
  if (!initialCheckpointSaved) {
    throw new Error(
      "Không lưu được trạng thái tìm kiếm để chạy bền. Hãy kiểm tra dung lượng Chrome rồi thử lại."
    );
  }

  const startPayload = {
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
  };
  let startDelivered = false;
  for (let attempt = 0; attempt < 3 && !startDelivered; attempt++) {
    startDelivered = await sendToWebPage(params.webUrl, "start", startPayload);
    if (!startDelivered) await sleep(300 * (attempt + 1));
  }
  if (!startDelivered) {
    await abortSearch(
      "WEB_START_DELIVERY_FAILED",
      "Không đồng bộ được trạng thái bắt đầu về Findmap. Hãy giữ trang kết quả mở rồi thử lại.",
      { chargePartial: false }
    );
    throw new Error("Không đồng bộ được trạng thái bắt đầu về Findmap.");
  }

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
  } catch (err) {
    if (scrapeState.running || scrapeState.searchParams) {
      await closeMapsTabSafely().catch(() => {});
      await resetScrapeState().catch(() => releaseSystemKeepAwake({ force: true }));
    } else if (!rescanState.running) {
      releaseSystemKeepAwakeIfIdle({ force: true });
    }
    throw err;
  } finally {
    endOperationTransition(transitionToken);
  }
}

async function handleResumeSearch() {
  const transitionToken = claimOperationStart("resume-search");
  try {
    return await tryResumeFromCheckpoint({ allowReopen: true, allowPaused: true });
  } finally {
    endOperationTransition(transitionToken);
  }
}

// ——— Quét lại (Rescan) những điểm thiếu thông tin ———

async function sendMapsMessageToTab(tabId, action, data, timeoutMs = 45000) {
  let ready = await ensureMapsContentReady(tabId);
  if (!ready) {
    await focusMapsTabAfterFailure(
      tabId,
      "Google Maps không nhận lệnh từ extension. Findmap đã đưa tab lên trước để kết nối lại."
    );
    ready = await ensureMapsContentReady(tabId);
  }
  if (!ready) throw new Error("Không kết nối được với Google Maps. Hãy tải lại tab Google Maps rồi thử lại.");
  let timer;
  try {
    const result = await Promise.race([
      (async () => {
        try {
          return await chrome.tabs.sendMessage(tabId, { action, data });
        } catch {
          await focusMapsTabAfterFailure(
            tabId,
            "Google Maps không thực hiện được thao tác ở chế độ nền. Findmap đã đưa tab lên trước để thử lại."
          );
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
    if (isSuccessfulMapsResponse(action, result)) {
      if (tabId === rescanState.mapsTabId) markRescanDataActivity();
      else if (tabId === scrapeState.mapsTabId) markMapsDataActivity();
      else if (tabId === scrapeState.enrichTabId) {
        scrapeState._enrichActivityAt = Date.now();
        scrapeState._lastEnrichRecoveryFocusDataAt = 0;
      }
    } else {
      await maybeFocusMapsTabAfterStall(tabId);
    }
    return result;
  } catch (err) {
    await maybeFocusMapsTabAfterStall(tabId);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleStartRescan(params) {
  const transitionToken = claimOperationStart("rescan");
  try {
    if (!Array.isArray(params.places) || !params.places.length) {
      throw new Error("Không có điểm nào để quét lại.");
    }
    if (params.places.length > 5000) {
      throw new Error("Mỗi lượt quét lại hỗ trợ tối đa 5.000 điểm bán.");
    }

    const pausedSearch = await getScrapeCheckpoint();
    if (pausedSearch?.paused && DurableLifecycle.isRecoverableScrapeCheckpoint(pausedSearch)) {
      throw new Error("Có lượt tìm kiếm đang tạm dừng. Hãy tiếp tục hoặc dừng hẳn trước khi quét lại.");
    }

  const pendingComplete = await flushPendingComplete("before_rescan");
  if (pendingComplete.pending) {
    throw new Error(
      "Kết quả tìm kiếm trước chưa đồng bộ xong. Hãy giữ trang Findmap mở rồi thử quét lại."
    );
  }
  await resetScrapeState();
  await clearScrapeCheckpoint();
  await chrome.storage.local.remove(["activeSearch", PENDING_SYNC_KEY]).catch(() => {});

  await clearRescanCheckpoint();
  resetRescanState();
  const durableParams = {
    ...params,
    searchParams: toDurableSearchParams(params.searchParams || {})
  };
  delete durableParams.authToken;
  delete durableParams.places;
  rescanState.running = true;
  requestSystemKeepAwake();
  rescanState.webUrl = params.webUrl;
  rescanState.params = durableParams;
  rescanState.places = params.places.map((place) => ({ ...place }));
  rescanState.searchParams = toDurableSearchParams(params.searchParams || {});
  rescanState.mapsAutoReopen =
    params.mapsAutoReopen === true || rescanState.searchParams.mapsAutoReopen === true;
  rescanState.done = 0;
  rescanState.failed = 0;
  rescanState.total = params.places.length;
  rescanState.placeIndex = 0;
  markRescanDataActivity();
  const initialCheckpointSaved = await persistRescanCheckpoint();
  if (!initialCheckpointSaved) {
    throw new Error(
      "Không lưu được trạng thái quét lại để chạy bền. Hãy kiểm tra dung lượng Chrome rồi thử lại."
    );
  }

  doRescan(params).catch((err) => {
    console.error("[Rescan] Lỗi:", err);
    if (rescanState.running) {
      abortRescan(err.message || "Lỗi quét lại", "RESCAN_ERROR").catch(() => {});
    }
  });

    return { success: true, total: params.places.length };
  } catch (err) {
    if (rescanState.running || rescanState.webUrl) {
      await closeRescanMapsTabSafely().catch(() => {});
      await clearRescanCheckpoint().catch(() => {});
      resetRescanState();
    } else if (!scrapeState.running) {
      releaseSystemKeepAwake({ force: true });
    }
    throw err;
  } finally {
    endOperationTransition(transitionToken);
  }
}

async function enrichRescanPlace(place, searchParams) {
  const href = buildRescanHref(place);
  if (!href || !rescanState.mapsTabId) return null;

  const rescanWorkToken = beginMapsRescanWork();
  try {
    let attempts = 0;
    while (attempts < 3 && rescanState.running) {
      attempts += 1;
      const opId = `rescan:${rescanState.placeIndex}:${attempts}:${crypto.randomUUID()}`;
      try {
        if (!rescanState.mapsTabId) throw new Error("Tab Google Maps đã bị đóng.");
        try {
          await chrome.tabs.update(rescanState.mapsTabId, {
            url: href,
            autoDiscardable: false
          });
        } catch (err) {
          await focusRescanTabForRecovery(
            "Google Maps không nhận được lệnh đổi URL. Findmap đã đưa tab lên trước để thử lại.",
            { force: true }
          );
          await chrome.tabs.update(rescanState.mapsTabId, {
            url: href,
            autoDiscardable: false
          });
        }
        await waitTabComplete(rescanState.mapsTabId);
        await sleep(700);

        const result = await sendMapsMessageToTab(rescanState.mapsTabId, "ENRICH_PLACE", {
          searchParams,
          listData: place,
          fast: true,
          opId
        });
        if (result?.opId !== opId || result?.success !== true) {
          throw new Error(result?.error || "Google Maps không trả chi tiết đúng thao tác yêu cầu.");
        }
        rescanState._awaitingReopen = false;
        return result?.place || null;
      } catch (err) {
        if (rescanState.mapsTabId) {
          await chrome.tabs
            .sendMessage(rescanState.mapsTabId, { action: "ENRICH_ABORT", data: { opId } })
            .catch(() => {});
        }
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
        if (rescanState.running && attempts < 3) {
          await sleep(Math.min(3000, 700 * attempts));
          continue;
        }
        throw err;
      }
    }
    return null;
  } finally {
    endMapsRescanWork(rescanWorkToken);
  }
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
      console.warn("[Rescan] Chưa xử lý được:", place.name, err.message);
    }

    if (enriched) {
      markRescanDataActivity();
      if (place.sourceKey) enriched._sourceKey = place.sourceKey;
      const delivered = await sendRescanDataWithRetry(webUrl, "item", {
        result: enriched,
        searchParams,
        rescan: true
      });
      if (!delivered) {
        await persistRescanCheckpoint();
        await ensureDurableWorkAlarm();
        return false;
      }
    } else {
      // A permanently broken Maps URL must not block the remaining rescan queue.
      rescanState.failed += 1;
    }

    // Checkpoint advances only after the enriched item was accepted by the web page.
    rescanState.placeIndex = idx + 1;
    rescanState.done = idx + 1;
    await persistRescanCheckpoint();

    await sendRescanDataWithRetry(webUrl, "rescan_progress", {
      done: rescanState.done,
      total: rescanState.total,
      percent: Math.round((rescanState.done / rescanState.total) * 100),
      name: place.name || "",
      failed: rescanState.failed
    }, 2);
  }
  return rescanState.placeIndex >= places.length;
}

async function finishRescanNormal() {
  if (!rescanState.running) return false;
  const done = rescanState.done;
  const failed = rescanState.failed;
  const total = rescanState.total;

  rescanState._terminalCompletion = { done, failed, total };
  await closeRescanMapsTabSafely();
  await persistRescanCheckpoint();
  return deliverRescanTerminalCompletion();
}

async function doRescan(params) {
  const opened = await openRescanMapsTab();
  if (!opened) {
    throw new Error("Không mở được Google Maps. Hãy kiểm tra quyền truy cập Google Maps rồi thử lại.");
  }

  let startDelivered = false;
  for (let attempt = 0; attempt < 3 && !startDelivered; attempt++) {
    startDelivered = await sendToWebPage(rescanState.webUrl, "rescan_start", {
      total: rescanState.total
    });
    if (!startDelivered) await sleep(300 * (attempt + 1));
  }
  if (!startDelivered) {
    await parkRescanForRecovery();
    return false;
  }
  const completed = await runRescanPlacesLoop();
  if (completed) return finishRescanNormal();
  await parkRescanForRecovery();
  return false;
}

function buildRescanHref(place) {
  const raw = String(place.href || place.mapsUrl || "").trim();
  if (raw) {
    try {
      const url = new URL(raw, "https://www.google.com");
      const allowedPath = url.pathname.startsWith("/maps/");
      const isPlace = url.pathname.includes("/maps/place/");
      const isPlaceQuery = url.searchParams.has("query_place_id");
      if (
        url.protocol === "https:" &&
        url.hostname === "www.google.com" &&
        allowedPath &&
        (isPlace || isPlaceQuery)
      ) {
        url.hash = "";
        return url.href;
      }
    } catch {}
  }
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
  if (
    durableRecoveryBusy ||
    operationTransitionTokens.size > 0 ||
    scrapeState.running ||
    rescanState.running
  ) {
    return false;
  }
  durableRecoveryBusy = true;
  try {
    const pendingComplete = await flushPendingComplete(reason);
    if (pendingComplete.delivered) {
      await clearDurableWorkAlarmIfIdle();
      return true;
    }
    if (pendingComplete.pending) return false;

    const scrapeCheckpoint = await getScrapeCheckpoint();
    if (DurableLifecycle.shouldAutoResumeScrapeCheckpoint(scrapeCheckpoint)) {
      const resumed = await tryResumeFromCheckpoint();
      if (resumed) bgLog(`Đã khôi phục phiên tìm kiếm (${reason}).`);
      if (resumed) {
        await pushSearchStatusToWeb();
        return true;
      }
      // Main search may have lost Maps; still continue recovery of an independent rescan.
      await ensureDurableWorkAlarm();
      await resetScrapeState({ preserveCheckpoint: true });
    } else if (DurableLifecycle.isRecoverableScrapeCheckpoint(scrapeCheckpoint)) {
      bgLog("Phiên tìm kiếm đang tạm dừng; chờ người dùng bấm Tiếp tục quét.");
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
    if (!scrapeState.running && !rescanState.running) {
      releaseSystemKeepAwake({ force: true });
    }
    durableRecoveryBusy = false;
  }
}

function ensureServiceReady(reason = "service_boot") {
  if (serviceBootComplete) return Promise.resolve(false);
  if (serviceBootPromise) return serviceBootPromise;

  // Badge state survives a worker sleep; clear stale warnings before checkpoint recovery.
  setMapsListInterruptionBadge(false);
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
