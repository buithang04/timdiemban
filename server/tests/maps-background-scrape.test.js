const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const background = read("extension", "background.js");
const content = read("extension", "content.js");
const webApp = read("web", "app.js");
const webSearch = read("web", "search.js");
const webIndex = read("web", "index.html");
const manifest = JSON.parse(read("extension", "manifest.json"));

function section(start, end) {
  const from = background.indexOf(start);
  const to = background.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Không tìm thấy mốc bắt đầu: ${start}`);
  assert.notEqual(to, -1, `Không tìm thấy mốc kết thúc: ${end}`);
  return background.slice(from, to);
}

function contentSection(start, end) {
  const from = content.indexOf(start);
  const to = content.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Không tìm thấy mốc content bắt đầu: ${start}`);
  assert.notEqual(to, -1, `Không tìm thấy mốc content kết thúc: ${end}`);
  return content.slice(from, to);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("manifest không yêu cầu quyền debugger", () => {
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal((manifest.optional_permissions || []).includes("debugger"), false);
});

test("extension không còn gọi debugger hoặc cơ chế screencast", () => {
  assert.doesNotMatch(background, /chrome\.debugger|Page\.startScreencast|Emulation\.setFocus/);
  assert.doesNotMatch(content, /AudioContext|timdiemban-audio-unlock|antiThrottle|requestAnimationFrame/);
});

test("tab Maps mở nền; focus đầu pha list độc lập với recovery 5 phút", () => {
  const open = section("async function openMapsScrapeTab", "async function scrapeKeepAliveTick");
  const rescanOpen = section(
    "async function openRescanMapsTab",
    "async function handleRescanMapsTabLost"
  );

  assert.match(open, /createMapsTab\(url, preferredWindowId, \{ active: false \}\)/);
  assert.doesNotMatch(open, /activateTabAndWindow/);

  assert.match(rescanOpen, /createMapsTab\(/);
  assert.match(rescanOpen, /active: false/);
  assert.doesNotMatch(rescanOpen, /activateTabAndWindow\(tab\.id\)/);

  const listFocus = section(
    "async function activateMapsTabForCellList",
    "function shouldFocusMapsForRecovery"
  );
  assert.match(listFocus, /await activateTabAndWindow\(tabId\)/);
  assert.doesNotMatch(listFocus, /lastScrapeProgressAt|_lastRecoveryFocusDataAt/);

  const keepalive = section("async function scrapeKeepAliveTick", "function isMapsAutoFocusEnabled");
  assert.match(keepalive, /maybeFocusMapsTabForStall\(\)/);
  assert.doesNotMatch(keepalive, /mapsForeground|mapsTabInactiveSince|activateTabAndWindow/);
  assert.match(background, /MAPS_STALL_FOCUS_MS = 5 \* 60 \* 1000/);
});

test("mỗi ô focus Maps một lần trước list; chunk tiếp tục không giành tab lại", () => {
  const runCell = section("async function runGridCell", "function getEnrichCheckpointKey");
  const focusCalls = runCell.match(/await activateMapsTabForCellList\(\)/g) || [];
  const focusAt = runCell.indexOf("await activateMapsTabForCellList()");
  const listWorkAt = runCell.indexOf("beginMapsCellListWork(lease)");
  const sendAt = runCell.indexOf('sendMapsMessageWithTimeout(\n      "SCRAPE_CELL_LIST"');

  assert.equal(focusCalls.length, 1, "runGridCell chỉ có một điểm focus Maps có điều kiện");
  assert.ok(focusAt >= 0, "pha list phải chủ động đưa Maps lên trước");
  assert.match(
    runCell,
    /if \(continuingSameCell\) await warnIfMapsListNotForeground\(\);\s*else await activateMapsTabForCellList\(\)/,
    "chỉ lần đầu của ô hoặc retry tải lại mới focus; chunk cuộn tiếp giữ nguyên tab người dùng"
  );
  const continuationCheck = section(
    "async function warnIfMapsListNotForeground",
    "function shouldFocusMapsForRecovery"
  );
  assert.match(continuationCheck, /warnMapsListInterruption\(null, source\)/);
  assert.doesNotMatch(continuationCheck, /activateTabAndWindow|focusTabForRecovery/);
  assert.ok(listWorkAt >= 0 && listWorkAt < sendAt, "state list phải active trước request list");
  assert.ok(sendAt > focusAt, "SCRAPE_CELL_LIST chỉ gửi sau khi đã focus đầu chunk");
  assert.doesNotMatch(
    runCell.slice(sendAt),
    /activateMapsTabForCellList/,
    "không được focus lại trong khi request list đang chạy"
  );
});

test("dừng quét luôn dọn tab Maps kể cả khi sync cuối lỗi", () => {
  const finalize = section("async function finalizeFromCheckpoint", "async function abortSearch");
  const abort = section("async function abortSearch", "async function cancelActiveSearch");
  const abandon = section("async function abandonActiveSearch", "async function ensureReadyForNewSearch");
  const complete = section(
    "async function handleScrapeComplete",
    "chrome.runtime.onMessage.addListener"
  );

  assert.doesNotMatch(`${finalize}\n${abort}\n${abandon}\n${complete}`, /debugger|disableMapsBoost/);

  // Dọn dẹp phải nằm trong finally — lỗi giữa chừng không được làm kẹt tab Maps
  assert.match(abort, /\} finally \{\s*isAborting = false;/);
  assert.match(
    complete,
    /\} finally \{[\s\S]*closeMapsTabSafely\(\);[\s\S]*resetScrapeState\(\{ preserveCheckpoint: !sent \}\);/
  );
});

test("watchdog không focus khi đổi URL; chỉ phục hồi khi update hoặc message lỗi", () => {
  const keepalive = section("async function scrapeKeepAliveTick", "function isMapsAutoFocusEnabled");
  const navigate = section("async function navigateMapsTab", "async function handleMapsTabReloaded");
  const rescanEnrich = section(
    "async function enrichRescanPlace",
    "async function runRescanPlacesLoop"
  );

  assert.match(keepalive, /persistScrapeCheckpoint\(\)/);
  assert.match(navigate, /chrome\.tabs\.update\(scrapeState\.mapsTabId/);
  assert.match(navigate, /focusMapsTabForRecovery/);
  assert.ok(
    navigate.indexOf("chrome.tabs.update") < navigate.indexOf("focusMapsTabForRecovery"),
    "đổi URL phải thử ở nền trước khi focus phục hồi"
  );
  assert.match(rescanEnrich, /chrome\.tabs\.update\(rescanState\.mapsTabId/);
  assert.match(rescanEnrich, /focusRescanTabForRecovery/);
  assert.doesNotMatch(`${navigate}\n${rescanEnrich}`, /await activateTabAndWindow/);
  assert.match(background, /WATCHDOG_ALARM/);
});

test("focus recovery chỉ đủ điều kiện sau 5 phút và không lặp lại cùng một đợt treo", () => {
  const source = section("function shouldFocusMapsForRecovery", "function markMapsDataActivity");
  const context = vm.createContext({ MAPS_STALL_FOCUS_MS: 300000 });
  vm.runInContext(`${source}\nthis.shouldFocusMapsForRecovery = shouldFocusMapsForRecovery;`, context);

  const base = {
    running: true,
    enabled: true,
    tabId: 7,
    lastDataAt: 1000000,
    lastRecoveryFocusDataAt: 0,
    now: 1000000 + 299999
  };
  assert.equal(context.shouldFocusMapsForRecovery(base), false);
  assert.equal(context.shouldFocusMapsForRecovery({ ...base, now: 1300000 }), true);
  assert.equal(
    context.shouldFocusMapsForRecovery({ ...base, now: 1600000, lastRecoveryFocusDataAt: 1000000 }),
    false
  );
  assert.equal(context.shouldFocusMapsForRecovery({ ...base, force: true }), true);
});

test("chỉ cảnh báo rời Maps khi search đang chạy đúng pha lấy danh sách", () => {
  const source = section(
    "function shouldWarnMapsListInterruption",
    "function setMapsListInterruptionBadge"
  );
  const context = vm.createContext({});
  vm.runInContext(
    `${source}\nthis.shouldWarnMapsListInterruption = shouldWarnMapsListInterruption;`,
    context
  );

  const listRunning = {
    running: true,
    listActive: true,
    mapsTabId: 7,
    activeTabId: 8
  };
  assert.equal(context.shouldWarnMapsListInterruption(listRunning), true);
  assert.equal(
    context.shouldWarnMapsListInterruption({ ...listRunning, running: false }),
    false,
    "idle không được cảnh báo"
  );
  assert.equal(
    context.shouldWarnMapsListInterruption({ ...listRunning, listActive: false }),
    false,
    "pha enrich không được cảnh báo"
  );
  assert.equal(
    context.shouldWarnMapsListInterruption({ ...listRunning, activeTabId: 7 }),
    false,
    "Maps đang active không được cảnh báo"
  );
  assert.equal(
    context.shouldWarnMapsListInterruption({ ...listRunning, mapsTabId: null }),
    false,
    "chưa có tab Maps không được cảnh báo"
  );
});

test("cảnh báo rời Maps được dedupe theo runId và cellGeneration", () => {
  const source = section(
    "function shouldWarnMapsListInterruption",
    "async function activateMapsTabForCellList"
  );
  const notifications = [];
  const logs = [];
  const badgeCalls = [];
  const activeLease = { runId: "run-1", cellGeneration: 4 };
  const scrapeState = {
    running: true,
    mapsTabId: 7,
    gridIndex: 0,
    totalCells: 3,
    _mapsCellListActive: true,
    _mapsCellListLease: { ...activeLease },
    _mapsListWarningKey: ""
  };
  const context = vm.createContext({
    chrome: {
      action: {
        setBadgeBackgroundColor: (value) => {
          badgeCalls.push(["color", value]);
          return Promise.resolve();
        },
        setBadgeText: (value) => {
          badgeCalls.push(["text", value]);
          return Promise.resolve();
        },
        setTitle: (value) => {
          badgeCalls.push(["title", value]);
          return Promise.resolve();
        }
      }
    },
    scrapeState,
    currentSearch: null,
    RunLease: {
      normalize: (lease) => (lease ? { ...lease } : null),
      same: (left, right) =>
        left?.runId === right?.runId && left?.cellGeneration === right?.cellGeneration
    },
    getActiveCellLease: () => ({ ...activeLease }),
    bgLog: (line) => logs.push(line),
    notifyProgress: (...args) => notifications.push(args),
    calcProgressPercent: () => 25,
    sendToWebPage: async () => true,
    getFinalResultsList: () => []
  });
  vm.runInContext(`${source}\nthis.warnMapsListInterruption = warnMapsListInterruption;`, context);

  assert.equal(context.warnMapsListInterruption(8, "tab_activated"), true);
  assert.equal(context.warnMapsListInterruption(9, "visibility_hidden"), false);
  assert.equal(notifications.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(scrapeState._mapsListWarningKey, "run-1:4");
  assert.equal(notifications[0][2].mapsTabHiddenDuringList, true);
  assert.equal(notifications[0][2].warningCode, "MAPS_LIST_TAB_HIDDEN");
  assert.ok(badgeCalls.some(([kind, value]) => kind === "text" && value.text === "!"));

  activeLease.cellGeneration = 5;
  scrapeState._mapsCellListLease = { ...activeLease };
  assert.equal(context.warnMapsListInterruption(8, "next_chunk"), true);
  assert.equal(notifications.length, 2, "generation mới được phép cảnh báo một lần mới");
  assert.equal(scrapeState._mapsListWarningKey, "run-1:5");
});

test("tabs.onActivated chỉ đồng bộ hoặc cảnh báo, tuyệt đối không tự focus Maps", () => {
  const source = section(
    "chrome.tabs.onActivated.addListener",
    "function markMapsControlledActivity"
  );
  const calls = [];
  let listener = null;
  let windowListener = null;
  const context = vm.createContext({
    chrome: {
      tabs: {
        onActivated: {
          addListener: (handler) => {
            listener = handler;
          }
        },
        query: async () => [{ id: 7 }]
      },
      windows: {
        onFocusChanged: {
          addListener: (handler) => {
            windowListener = handler;
          }
        }
      }
    },
    scrapeState: {
      running: true,
      searchParams: { webUrl: "https://findmap.vn" },
      mapsTabId: 7,
      mapsWindowId: 3,
      webTabId: 11,
      _mapsCellListActive: true
    },
    clearMapsListInterruptionWarning: () => calls.push(["clear"]),
    warnMapsListInterruption: (tabId, reason) => calls.push(["warn", tabId, reason]),
    ensureWebSyncedToResults: (reason, force) => {
      calls.push(["sync", reason, force]);
      return Promise.resolve(true);
    }
  });
  vm.runInContext(source, context);

  assert.equal(typeof listener, "function");
  assert.equal(typeof windowListener, "function");
  listener({ tabId: 8 });
  listener({ tabId: 11 });
  listener({ tabId: 7 });

  assert.deepEqual(plain(calls), [
    ["warn", 8, "tab_activated"],
    ["warn", 11, "tab_activated"],
    ["sync", "Đồng bộ khi quay lại tab kết quả", true],
    ["clear"],
    ["sync", "Đồng bộ khi quay lại tab Maps", true]
  ]);
  assert.doesNotMatch(
    source,
    /activateTabAndWindow|focusMapsTab|chrome\.tabs\.update|chrome\.windows\.update/
  );
});

test("đổi cửa sổ trong pha list chỉ cảnh báo, quay lại cửa sổ Maps thì dọn cảnh báo", async () => {
  const source = section(
    "chrome.windows.onFocusChanged.addListener",
    "function markMapsControlledActivity"
  );
  const calls = [];
  let listener = null;
  let activeTabId = 7;
  const context = vm.createContext({
    chrome: {
      windows: {
        onFocusChanged: {
          addListener: (handler) => {
            listener = handler;
          }
        }
      },
      tabs: {
        query: async () => [{ id: activeTabId }]
      }
    },
    scrapeState: {
      running: true,
      searchParams: { webUrl: "https://findmap.vn" },
      _mapsCellListActive: true,
      mapsWindowId: 3,
      mapsTabId: 7
    },
    warnMapsListInterruption: (tabId, reason) => calls.push(["warn", tabId, reason]),
    clearMapsListInterruptionWarning: () => calls.push(["clear"])
  });
  vm.runInContext(source, context);

  listener(9);
  listener(3);
  await Promise.resolve();
  activeTabId = 8;
  listener(3);
  await Promise.resolve();

  assert.deepEqual(plain(calls), [
    ["warn", null, "window_focus_changed"],
    ["clear"],
    ["warn", 8, "maps_window_focused"]
  ]);
  assert.doesNotMatch(source, /activateTabAndWindow|focusMapsTab|chrome\.windows\.update/);
});

test("MAPS_TAB_HIDDEN chỉ nhận lease của list hiện tại và không kích hoạt tab", () => {
  const handler = section(
    'if (message.action === "MAPS_TAB_HIDDEN")',
    'if (message.action === "GET_SEARCH_STATUS")'
  );

  assert.match(handler, /scrapeState\.running/);
  assert.match(handler, /scrapeState\._mapsCellListActive/);
  assert.match(handler, /acceptsActiveCellMessage\(message, sender\)/);
  assert.match(handler, /warnMapsListInterruption/);
  assert.doesNotMatch(
    handler,
    /activateTabAndWindow|focusMapsTab|chrome\.tabs\.update|active:\s*true/
  );
});

test("chỉ phản hồi thật từ Maps mới đặt lại đồng hồ 5 phút", () => {
  const notify = section("function notifyProgress", "async function waitForMapsTabReady");
  const progressHandler = section(
    'if (message.action === "SCRAPE_PROGRESS")',
    'if (message.action === "SCRAPE_LOG")'
  );
  const itemHandler = section(
    'if (message.action === "SCRAPE_ITEM")',
    'if (message.action === "CELL_LIST_COMPLETE")'
  );
  const directResponse = section(
    "async function sendMapsMessageWithTimeout",
    "async function retryIncompleteGridCell"
  );

  assert.doesNotMatch(notify, /lastScrapeProgressAt|markMapsDataActivity/);
  assert.match(progressHandler, /message\.dataActivity === true/);
  assert.doesNotMatch(
    progressHandler,
    /if \(!scrapeState\.running[^]*?return;\s*markMapsDataActivity\(\)/
  );
  assert.match(itemHandler, /markMapsDataActivity\(\)/);
  assert.match(directResponse, /markMapsDataActivity\(\)/);
});

test("wake pulse dùng token nên finally của lượt cũ không dừng lượt mới", async () => {
  const pulse = section("const MAPS_CONTENT_WAKE_INTERVAL_MS", "function isValidWindowId");
  const work = section("function beginMapsCellWork", "function isMapsLoadingExpected");
  const reset = section("async function resetScrapeState", "function isMapsAutoReopenEnabled");
  const sends = [];
  let clearCount = 0;
  const context = vm.createContext({
    chrome: {
      tabs: {
        sendMessage: async (tabId, message) => {
          sends.push([tabId, message]);
          return { ok: true };
        }
      }
    },
    setInterval: () => ({ id: Math.random() }),
    clearInterval: () => {
      clearCount += 1;
    }
  });
  vm.runInContext(
    `
      const scrapeState = {
        mapsTabId: 7,
        _mapsCellWorkActive: false,
        _mapsCellListActive: false,
        _mapsCellListLease: null,
        _programmaticMapsNavUntil: 0
      };
      const rescanState = { mapsTabId: 9 };
      const mapsCellWorkTokens = new Set();
      let activeMapsCellListToken = null;
      const mapsRescanWorkTokens = new Set();
      let mapsContentWakeTimer = null;
      let mapsContentWakeTickBusy = false;
      const RunLease = { normalize: (lease) => lease ? { ...lease } : null };
      function markMapsControlledActivity() {}
      function clearMapsListInterruptionWarning() {}
      ${pulse}
      ${work}
      this.api = {
        beginMapsCellWork,
        endMapsCellWork,
        beginMapsCellListWork,
        endMapsCellListWork,
        clearMapsCellWorkTokens,
        cellCount: () => mapsCellWorkTokens.size,
        isCellActive: () => scrapeState._mapsCellWorkActive,
        isListActive: () => scrapeState._mapsCellListActive,
        listLease: () => scrapeState._mapsCellListLease,
        hasTimer: () => Boolean(mapsContentWakeTimer)
      };
    `,
    context
  );

  assert.match(pulse, /MAPS_CONTENT_WAKE_INTERVAL_MS = 1000/);
  assert.match(pulse, /KEEPALIVE_TICK/);
  assert.match(pulse, /mapsContentWakeTickBusy/);
  assert.match(work, /startMapsContentWakePulse\(\)/);
  assert.match(reset, /clearMapsCellWorkTokens\(\)/);

  const oldToken = context.api.beginMapsCellWork();
  assert.equal(context.api.isListActive(), false, "wake/enrich state không được giả làm pha list");
  const oldListToken = context.api.beginMapsCellListWork({ runId: "run-1", cellGeneration: 2 });
  assert.equal(context.api.isListActive(), true);
  assert.deepEqual(plain(context.api.listLease()), { runId: "run-1", cellGeneration: 2 });
  const newListToken = context.api.beginMapsCellListWork({ runId: "run-1", cellGeneration: 3 });
  context.api.endMapsCellListWork(oldListToken);
  assert.equal(context.api.isListActive(), true, "finally cũ không được xóa state list mới");
  assert.deepEqual(plain(context.api.listLease()), { runId: "run-1", cellGeneration: 3 });
  context.api.endMapsCellListWork(newListToken);
  assert.equal(context.api.isListActive(), false);
  assert.equal(context.api.isCellActive(), true, "kết thúc list không được tắt wake work còn sống");

  context.api.clearMapsCellWorkTokens();
  const newToken = context.api.beginMapsCellWork();
  context.api.endMapsCellWork(oldToken);
  await Promise.resolve();

  assert.equal(context.api.cellCount(), 1);
  assert.equal(context.api.isCellActive(), true);
  assert.equal(context.api.hasTimer(), true);
  assert.equal(clearCount, 1);
  assert.ok(sends.some(([tabId, message]) => tabId === 7 && message.action === "KEEPALIVE_TICK"));

  context.api.endMapsCellWork(newToken);
  assert.equal(context.api.cellCount(), 0);
  assert.equal(context.api.isCellActive(), false);
  assert.equal(context.api.hasTimer(), false);
  assert.equal(clearCount, 2);
});

test("rescan tab nền được wake trong toàn bộ thao tác đọc URL", async () => {
  const pulse = section("const MAPS_CONTENT_WAKE_INTERVAL_MS", "function isValidWindowId");
  const work = section("function beginMapsCellWork", "function isMapsLoadingExpected");
  const rescanFlow = section("async function enrichRescanPlace", "async function runRescanPlacesLoop");
  const sends = [];
  const context = vm.createContext({
    chrome: {
      tabs: {
        sendMessage: async (tabId, message) => {
          sends.push([tabId, message]);
          return { ok: true };
        }
      }
    },
    setInterval: () => ({ id: 1 }),
    clearInterval: () => {}
  });
  vm.runInContext(
    `
      const scrapeState = {
        mapsTabId: null,
        _mapsCellWorkActive: false,
        _programmaticMapsNavUntil: 0
      };
      const rescanState = { mapsTabId: 29 };
      const mapsCellWorkTokens = new Set();
      const mapsRescanWorkTokens = new Set();
      let mapsContentWakeTimer = null;
      let mapsContentWakeTickBusy = false;
      function markMapsControlledActivity() {}
      ${pulse}
      ${work}
      this.api = { beginMapsRescanWork, endMapsRescanWork };
    `,
    context
  );

  const token = context.api.beginMapsRescanWork();
  await Promise.resolve();

  assert.ok(sends.some(([tabId, message]) => tabId === 29 && message.action === "KEEPALIVE_TICK"));
  assert.ok(
    rescanFlow.indexOf("beginMapsRescanWork()") < rescanFlow.indexOf("chrome.tabs.update"),
    "rescan phải bật wake trước khi điều hướng URL"
  );
  assert.match(rescanFlow, /finally\s*\{\s*endMapsRescanWork\(rescanWorkToken\)/);
  context.api.endMapsRescanWork(token);
});

test("cleanup cũ khóa mọi START mới cho tới khi dọn xong", () => {
  const ownership = section("function beginOperationTransition", "/** Ngân sách cho một lần thu danh sách");
  const completeSearch = section("async function handleScrapeComplete", "function dispatchRuntimeMessage");
  const completeRescan = section(
    "async function deliverRescanTerminalCompletion",
    "async function abortRescan"
  );
  const completeCell = section("async function completeCellAfterEnrich", "function runEnrichPhase");
  const recovery = section("async function recoverDurableWork", "function ensureServiceReady");
  const context = vm.createContext({});
  vm.runInContext(
    `
      let isAborting = false;
      let durableRecoveryBusy = false;
      const scrapeState = { running: false };
      const rescanState = { running: false };
      const operationTransitionTokens = new Set();
      ${ownership}
      this.api = {
        beginOperationTransition,
        endOperationTransition,
        claimOperationStart,
        transitionCount: () => operationTransitionTokens.size
      };
    `,
    context
  );

  const oldCleanup = context.api.beginOperationTransition("old-cleanup");
  assert.throws(
    () => context.api.claimOperationStart("search"),
    /đang hoàn tất lượt trước/
  );
  context.api.endOperationTransition(oldCleanup);

  const newStart = context.api.claimOperationStart("search");
  assert.equal(context.api.transitionCount(), 1);
  assert.throws(
    () => context.api.claimOperationStart("rescan"),
    /đang hoàn tất lượt trước/
  );
  context.api.endOperationTransition(newStart);
  assert.equal(context.api.transitionCount(), 0);

  assert.match(completeSearch, /beginOperationTransition\("complete-search"\)/);
  assert.match(completeSearch, /finally\s*\{\s*endOperationTransition\(transitionToken\)/);
  assert.match(completeRescan, /beginOperationTransition\("complete-rescan"\)/);
  assert.match(completeRescan, /finally\s*\{\s*endOperationTransition\(transitionToken\)/);
  assert.match(completeCell, /beginOperationTransition\("complete-empty-search"\)/);
  assert.match(recovery, /operationTransitionTokens\.size > 0/);
  assert.match(ownership, /durableRecoveryBusy/);
});

test("focus Maps khôi phục cửa sổ bị thu nhỏ", async () => {
  const source = section("function isValidWindowId", "async function createMapsTab");
  const calls = [];
  const chrome = {
    tabs: {
      update: async (tabId, options) => {
        calls.push(["tab", tabId, options]);
        return { id: tabId, windowId: 18 };
      },
      get: async () => ({ id: 7, windowId: 18 })
    },
    windows: {
      get: async (windowId) => {
        calls.push(["getWindow", windowId]);
        return { id: windowId, state: "minimized", focused: false };
      },
      update: async (windowId, options) => {
        calls.push(["window", windowId, options]);
      }
    }
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(`${source}\nthis.activateTabAndWindow = activateTabAndWindow;`, context);

  await context.activateTabAndWindow(7);

  assert.deepEqual(plain(calls), [
    ["tab", 7, { active: true, autoDiscardable: false }],
    ["getWindow", 18],
    ["window", 18, { focused: true, state: "normal" }]
  ]);
});

test("tạo tab Maps đúng cửa sổ Findmap, có dự phòng khi cửa sổ đã đóng", async () => {
  const source =
    section("function isValidWindowId", "async function getTabWindowId") +
    section("async function createMapsTab", "/**");

  const calls = [];
  const chrome = {
    tabs: {
      create: async (options) => {
        calls.push(["create", options]);
        if (options.windowId === 404) throw new Error("No window with id: 404");
        return { id: 91, windowId: options.windowId ?? 18 };
      },
      update: async (tabId, options) => {
        calls.push(["update", tabId, options]);
        return { id: tabId };
      }
    }
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(`${source}\nthis.createMapsTab = createMapsTab;`, context);

  const tab = await context.createMapsTab("https://www.google.com/maps/", 17);
  assert.equal(tab.windowId, 17);
  assert.deepEqual(plain(calls), [
    ["create", { url: "https://www.google.com/maps/", active: false, windowId: 17 }],
    ["update", 91, { autoDiscardable: false }]
  ]);

  calls.length = 0;
  const fallback = await context.createMapsTab("https://www.google.com/maps/", 404);
  assert.equal(fallback.windowId, 18);
  assert.equal(calls.length, 3);
  assert.deepEqual(plain(calls[1]), [
    "create",
    { url: "https://www.google.com/maps/", active: false }
  ]);
});

test("đổi vùng và đọc chi tiết chỉ điều hướng URL, không đẩy Maps về nền", () => {
  const searchFlow = section("async function runGridCell", "function getEnrichCheckpointKey");
  const enrichFlow = section("async function enrichPlaceByUrl", "async function handleCellListComplete");
  const rescanFlow = section("async function enrichRescanPlace", "async function runRescanPlacesLoop");

  assert.match(searchFlow, /navigateMapsTab\(\{ url \}\)/);
  assert.match(enrichFlow, /navigateMapsTab\(\{ url: href \}\)/);
  assert.doesNotMatch(enrichFlow, /ENRICH_ONE|url: searchUrl|findListItemForPlace|scrollToFindListItem/);
  assert.match(
    rescanFlow,
    /chrome\.tabs\.update\(rescanState\.mapsTabId,\s*\{\s*url: href,\s*autoDiscardable: false\s*\}\)/
  );
  assert.doesNotMatch(`${searchFlow}\n${enrichFlow}\n${rescanFlow}`, /active:\s*false/);
});

test("auto-focus chỉ là cơ chế khôi phục và bật/tắt không focus ngay", () => {
  const periodicFocus = section(
    "async function maybeFocusMapsTabForStall",
    "function isMapsAutoFocusEnabled"
  );
  const settingHandler = section(
    'if (message.action === "SET_MAPS_AUTO_FOCUS")',
    'if (message.action === "SET_MAPS_AUTO_REOPEN")'
  );

  assert.match(periodicFocus, /focusMapsTabForRecovery/);
  assert.doesNotMatch(settingHandler, /focusMapsTabForSearch|focusMapsTabForRecovery/);
  assert.match(webSearch, /saved == null \? true : saved === "1"/);
});

test("pha list cảnh báo khi rời Maps nhưng recovery vẫn chỉ focus sau 5 phút", () => {
  assert.match(content, /MAPS_TAB_HIDDEN/);
  assert.match(background, /Việc lấy danh sách địa điểm có thể bị gián đoạn/i);
  assert.match(background, /Hãy quay lại tab Google Maps/i);
  assert.match(content, /không có dữ liệu mới trong 5 phút/i);
  assert.doesNotMatch(content, /AudioContext|timdiemban-audio-unlock|requestAnimationFrame\(advance\)/);
  assert.match(
    `${webSearch}\n${webIndex}`,
    /(?:không phản hồi|không có dữ liệu mới) trong 5 phút/i
  );
  assert.match(webSearch, /mapsTabHiddenDuringList/);
});

test("đứng tạm ở 80 và 100 kết quả không bị coi là cuối danh sách", () => {
  const source = contentSection(
    "function updateEndMarkerConfirmation",
    "async function scrollFeed"
  );
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.updateEndMarkerConfirmation = updateEndMarkerConfirmation;`, context);

  const batches = [
    7, 14, 20, 27, 34, 40, 47, 54, 60, 67, 74,
    80, 80, 80,
    87, 94,
    100, 100, 100, 100,
    107, 114, 120, 120, 120
  ];
  let confirmations = 0;
  let previous = 0;
  let completedAt = null;

  for (let i = 0; i < batches.length; i++) {
    const count = batches[i];
    const state = context.updateEndMarkerConfirmation(confirmations, {
      grew: count > previous,
      loading: false,
      endMarker: count === 120
    });
    confirmations = state.confirmations;
    if (state.reachedEnd) completedAt = { index: i, count };
    if (count === 80 || count === 100) assert.equal(state.reachedEnd, false);
    previous = count;
  }

  assert.deepEqual(plain(completedAt), { index: batches.length - 1, count: 120 });
});

test("không có end marker thì hết thời gian vẫn là ô chưa hoàn tất", () => {
  const source = section("function isCompleteCellResult", "async function runGridCell");
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.isCompleteCellResult = isCompleteCellResult;`, context);

  assert.equal(context.isCompleteCellResult({ success: false, reachedEnd: false }), false);
  assert.equal(context.isCompleteCellResult({ success: true, reachedEnd: false }), false);
  assert.equal(context.isCompleteCellResult({ success: true, reachedEnd: true }), true);
});

test("ô chưa tới cuối không bị đánh dấu xong hoặc chuyển sang ô kế tiếp", () => {
  const retry = section("async function retryIncompleteGridCell", "function isCompleteCellResult");
  const runCell = section("async function runGridCell", "function getEnrichCheckpointKey");
  const handleList = section("async function handleCellListComplete", "async function completeCellAfterEnrich");

  assert.doesNotMatch(retry, /completedCells\.add/);
  assert.match(runCell, /if \(!isCompleteCellResult\(result\)\)/);
  assert.match(runCell, /await retryIncompleteGridCell/);
  assert.match(handleList, /if \(!reachedEnd\)/);
  assert.doesNotMatch(handleList, /completedCells\.add|runGridCell\(/);
});

test("mỗi ô phải cuộn lấy URL rồi mở tuần tự từng URL trước khi sang ô kế tiếp", () => {
  const collect = contentSection("async function scrollAndScrapePlaces", "async function waitForFeed");
  const handleList = section("async function handleCellListComplete", "async function completeCellAfterEnrich");
  const completeCell = section("async function completeCellAfterEnrich", "function continueGridAfterEnrich");
  const continueGrid = section("function continueGridAfterEnrich", "function runEnrichPhase");
  const enrich = section("function runEnrichPhase()", "async function closeMapsTabSafely");
  const enrichUrls = section("async function enrichPlacesInCell", "function pushLiveItemsToWeb");
  const contentEnrich = contentSection("function runEnrichPlaceMessage", "window.__timDiemBanWake");

  assert.doesNotMatch(collect, /scrapeItemInPlace\(/);
  assert.match(collect, /place\.href = listData\.href/);
  assert.match(collect, /reachedEnd: scrollOutcome\.reachedEnd/);
  assert.match(handleList, /scrapeState\.phase = "enrich"/);
  assert.match(handleList, /await persistScrapeCheckpoint\(\)/);
  assert.match(handleList, /await runEnrichPhase\(\)/);
  assert.doesNotMatch(handleList, /completedCells\.add|runGridCell\(/);

  const markDoneAt = completeCell.indexOf("scrapeState.completedCells.add(cellIndex)");
  const returnNextAt = completeCell.indexOf("return nextIndex");
  assert.ok(markDoneAt >= 0 && returnNextAt > markDoneAt);
  assert.doesNotMatch(completeCell, /runGridCell\(/);
  assert.match(continueGrid, /runGridCell\(nextIndex\)/);
  assert.match(
    enrich,
    /enrichRunPromise = null;\s*continueGridAfterEnrich\(nextIndex\)/,
    "phải nhả single-flight promise trước khi chạy ô kế tiếp"
  );

  assert.match(enrich, /Number\(place\._enrichCellIndex\) === Number\(cellIndex\)/);
  assert.match(
    enrich,
    /cellPlaces\.filter\([\s\S]*const key = getEnrichCheckpointKey\(place\)[\s\S]*!scrapeState\.enrichedPlaceKeys\.has\(key\)[\s\S]*!scrapeState\.failedEnrichKeys\.has\(key\)/
  );
  assert.doesNotMatch(enrich, /placeNeedsEnrich/);
  assert.match(enrichUrls, /await enrichPlaceByUrl\(place, params, progressText, pct, attempt\)/);
  assert.match(enrichUrls, /MAX_DIRECT_URL_RETRIES/);
  assert.doesNotMatch(enrichUrls, /ENRICH_ONE|findListItemForPlace|scrollToFindListItem|scrapeItemInPlace/);
  assert.match(contentEnrich, /thorough = false/);
  assert.match(contentEnrich, /fast: thorough \? false/);
  assert.match(contentEnrich, /needAddress: thorough \? true/);
  assert.match(contentEnrich, /needPhone: thorough \? true/);
  assert.match(enrich, /return completeCellAfterEnrich\(cellIndex\)/);
  assert.match(enrich, /scrapeState\.enrichedPlaceKeys/);
  assert.match(background, /enrichedPlaceKeys: \[\.\.\.scrapeState\.enrichedPlaceKeys\]/);
  assert.match(background, /scrapeState\.phase === "enrich"/);
});

test("trang chi tiết production đọc role=button giờ, bài đánh giá và Place ID !19s", () => {
  const detail = contentSection("function readHoursFromOverviewButton", "function isSafeExpandButton");
  const ratings = contentSection("function parseReviewCountText", "function unwrapGoogleUrl");

  assert.match(detail, /\[role=\\?"button\\?"\]/);
  assert.match(detail, /aria-label=\\?"Giờ\\?"/);
  assert.match(detail, /PF\?\.normalizeMapsHoursText/);
  assert.match(ratings, /bài\\s\+/);
  assert.match(ratings, /PF\?\.parseMapsRatingReviewLabels/);
  assert.match(content, /\^ChIJ[\s\S]*getCanonicalPlaceId\(listData\?\.href \|\| ""\)[\s\S]*getCanonicalPlaceId\(pageUrl\)/);
  assert.match(read("extension", "grid.js"), /!\(\?:1s\|19s\)\(ChIJ/);
});

test("hàng đợi pha 2 chỉ nhận URL chi tiết Google Maps", () => {
  const source = section("function normalizePlaceDetailUrl", "function preserveEnrichMetadata");
  const getCanonicalPlaceId = (raw) => {
    const decoded = decodeURIComponent(String(raw || ""));
    return (
      decoded.match(/!(?:1s|19s)(ChIJ[a-zA-Z0-9_-]+)/)?.[1] ||
      decoded.match(/[?&]query_place_id=(ChIJ[a-zA-Z0-9_-]+)/)?.[1] ||
      ""
    );
  };
  const context = vm.createContext({
    URL,
    getCanonicalPlaceId,
    getDedupeKey: (place) => `fb:${place?.name || ""}`
  });
  vm.runInContext(
    `${source}\nthis.api = { getPlaceDetailUrl, getStableEnrichKey };`,
    context
  );

  assert.equal(
    context.api.getPlaceDetailUrl({
      href: "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2!3m1!1sabc#details"
    }),
    "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2!3m1!1sabc"
  );
  assert.equal(
    context.api.getPlaceDetailUrl({ href: "/maps/place/Quan+Tra/@21.02,105.81/data=!4m2" }),
    "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2"
  );
  assert.equal(
    context.api.getPlaceDetailUrl({
      href: "https://www.google.com/maps/search/tra+da",
      mapsUrl: "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2?entry=ttu#details"
    }),
    "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2?entry=ttu"
  );
  assert.equal(context.api.getPlaceDetailUrl({ href: "https://example.com/maps/place/test" }), "");

  const firstKey = context.api.getStableEnrichKey({
    name: "Trùng tên",
    href: "https://www.google.com/maps/place/Diem+A/@21.02,105.81/data=!4m2?entry=ttu#details"
  });
  const sameKey = context.api.getStableEnrichKey({
    name: "Trùng tên",
    mapsUrl: "https://www.google.com/maps/place/Diem+A/@21.02,105.81/data=!4m2?hl=vi"
  });
  const secondKey = context.api.getStableEnrichKey({
    name: "Trùng tên",
    href: "https://www.google.com/maps/place/Diem+B/@21.03,105.82/data=!4m2"
  });
  assert.equal(firstKey, sameKey, "query/hash không được làm đổi enrich key");
  assert.notEqual(firstKey, secondKey, "hai URL khác nhau không được va chạm key vì trùng tên");

  const chijFromData = context.api.getStableEnrichKey({
    href:
      "https://www.google.com/maps/place/Ten-cu/@21.02,105.81/data=!4m5!3m4!1sChIJAbCd_123!8m2!3d21.02!4d105.81"
  });
  const sameChijFromOtherVariant = context.api.getStableEnrichKey({
    mapsUrl:
      "https://www.google.com/maps/place/Ten-hoan-toan-khac/@20.99,105.77/data=!4m5!3m4!19sChIJAbCd_123!8m2!3d20.99!4d105.77?entry=ttu"
  });
  assert.equal(chijFromData, "cid:chijabcd_123");
  assert.equal(
    chijFromData,
    sameChijFromOtherVariant,
    "cùng ChIJ phải dùng chung enrich key dù pathname và tọa độ URL khác nhau"
  );
});

test("checkpoint kiểu cũ được quay lại ô 1 để không bỏ pha click chi tiết", () => {
  const restore = section("function restoreScrapeStateFromCheckpoint", "async function clearScrapeCheckpoint");
  const lifecycle = require("../../extension/lifecycle.js");
  const scrapeState = {
    completedCells: new Set(),
    enrichedPlaceKeys: new Set(),
    mergedPlaces: new Map()
  };
  const context = vm.createContext({
    CELL_FLOW_VERSION: 3,
    PER_CELL_ENRICH_FLOW_VERSION: 2,
    DurableLifecycle: lifecycle,
    scrapeState,
    placesToMap: (places) => new Map((places || []).map((place, index) => [String(index), place])),
    currentSearch: null,
    lastScrapeProgressAt: 0
  });
  vm.runInContext(
    `${restore}\nthis.restoreScrapeStateFromCheckpoint = restoreScrapeStateFromCheckpoint;\n` +
      `this.nextPendingCellFromScrapeState = nextPendingCellFromScrapeState;`,
    context
  );

  const restored = context.restoreScrapeStateFromCheckpoint({
    running: true,
    searchParams: { searchId: "legacy-search" },
    gridIndex: 1,
    totalCells: 3,
    phase: "enrich",
    completedCells: [0],
    gridPoints: [{}, {}, {}],
    mergedPlaces: [{ name: "Điểm cũ" }]
  });

  assert.equal(restored, true);
  assert.equal(scrapeState.gridIndex, 0);
  assert.equal(scrapeState.phase, "grid");
  assert.deepEqual([...scrapeState.completedCells], []);
  assert.equal(context.nextPendingCellFromScrapeState(), 0);
  assert.match(background, /cellFlowVersion: CELL_FLOW_VERSION/);
  assert.match(restore, /hasPerCellEnrich/);
  assert.match(restore, /hasPerCellEnrich \? cp\.gridIndex \|\| 0 : 0/);
  assert.match(restore, /hasPerCellEnrich \? cp\.completedCells \|\| \[\] : \[\]/);
  assert.match(restore, /DurableLifecycle\.nextPendingCell\(\{[\s\S]*scrapeState\.gridIndex/);
});

test("resume checkpoint ô cuối rỗng kết thúc và dọn checkpoint thay vì lặp recovery", async () => {
  const source = section(
    "async function tryResumeFromCheckpoint",
    "async function finalizeFromCheckpoint"
  );
  const lifecycle = require("../../extension/lifecycle.js");
  const calls = [];
  const checkpoint = {
    running: true,
    savedAt: Date.now(),
    searchParams: { searchId: "empty-terminal" },
    mapsTabId: 17,
    gridIndex: 0,
    totalCells: 1,
    gridPoints: [{}],
    completedCells: [0],
    mergedPlaces: [],
    phase: "grid"
  };
  const scrapeState = {
    running: false,
    mapsTabId: null,
    totalCells: 0,
    mergedPlaces: new Map()
  };
  const context = vm.createContext({
    DurableLifecycle: lifecycle,
    scrapeState,
    pointsFinalized: false,
    getScrapeCheckpoint: async () => checkpoint,
    restoreScrapeStateFromCheckpoint: (saved) => {
      calls.push("restore");
      scrapeState.mapsTabId = saved.mapsTabId;
      scrapeState.totalCells = saved.totalCells;
      scrapeState.phase = saved.phase;
      scrapeState.completedCells = new Set(saved.completedCells);
      scrapeState.mergedPlaces = new Map();
      return true;
    },
    startScrapeKeepAlive: () => calls.push("keepalive:start"),
    stopScrapeKeepAlive: () => calls.push("keepalive:stop"),
    nextPendingCellFromScrapeState: () => 1,
    closeMapsTabSafely: async () => calls.push("tab:close"),
    resetScrapeState: async () => calls.push("state:reset"),
    chrome: {
      tabs: {
        get: async (tabId) => {
          calls.push(`tab:get:${tabId}`);
          return { id: tabId };
        }
      }
    }
  });
  vm.runInContext(`${source}\nthis.tryResumeFromCheckpoint = tryResumeFromCheckpoint;`, context);

  const resumed = await context.tryResumeFromCheckpoint();

  assert.equal(resumed, true, "checkpoint terminal đã được xử lý, không còn chờ recovery sau");
  assert.equal(scrapeState.running, false);
  assert.deepEqual(calls, [
    "restore",
    "keepalive:start",
    "tab:get:17",
    "keepalive:stop",
    "tab:close",
    "state:reset"
  ]);
});

test("feed instance cũ được đọc trước khi đổi vùng và chỉ bắt buộc đổi ở ô mới", () => {
  const runCell = section("async function runGridCell", "function getEnrichCheckpointKey");
  const readSignatureAt = runCell.indexOf('sendMapsMessage("GET_FEED_SIGNATURE"');
  const navigateAt = runCell.indexOf("await navigateMapsTab({ url })");
  const scrapeAt = runCell.indexOf('"SCRAPE_CELL_LIST"');
  const passSignatureAt = runCell.indexOf("previousFeedSignature", scrapeAt);
  const passInstanceAt = runCell.indexOf("previousFeedInstanceId", scrapeAt);
  const passRequireAt = runCell.indexOf("requireFeedChange", scrapeAt);

  assert.ok(readSignatureAt >= 0, "pha grid phải đọc chữ ký feed hiện tại");
  assert.ok(navigateAt > readSignatureAt, "phải đọc chữ ký trước khi navigate");
  assert.ok(scrapeAt > navigateAt, "chỉ scrape sau khi đã navigate sang vùng mới");
  assert.ok(passSignatureAt > scrapeAt, "request scrape phải mang previousFeedSignature");
  assert.ok(passInstanceAt > scrapeAt, "request scrape phải mang previousFeedInstanceId");
  assert.ok(passRequireAt > scrapeAt, "request scrape phải mang requireFeedChange");
  assert.match(runCell, /previousFeedInstanceId\s*=\s*String\(signature\?\.instanceId \|\| ""\)/);
  assert.match(runCell, /const requireFeedChange = cellIndex > 0 && !retryingSameCell/);
  assert.match(
    runCell,
    /retryingSameCell\s*=\s*[\s\S]*_cellRetryCounts[\s\S]*_cellRecoveryCounts/
  );

  const waitFeed = contentSection("async function waitForCellFeedReady", "let _lastKnownTotalCells");
  assert.match(waitFeed, /previousFeedSignature\s*\|\|\s*getFeedSignature\(getFeedPanel\(\)\)/);
  assert.match(waitFeed, /hasNewListEvidence\s*=\s*[\s\S]*finalSignatureChanged/);
  assert.match(
    waitFeed,
    /getResultItems\(feed\)\.length\s*>\s*0\s*&&\s*centerMatches\s*&&\s*hasNewListEvidence\s*&&\s*!isFeedLoading\(feed\)/
  );
});

test("watchdog vô hiệu hóa lease cũ trước khi abort và retry", () => {
  const watchdog = section(
    "async function maybeRecoverStalledScrape",
    "async function tryResumeFromCheckpoint"
  );
  const invalidateAt = watchdog.indexOf("scrapeState.cellGeneration = staleLease.cellGeneration + 1");
  const persistAt = watchdog.indexOf("await persistScrapeCheckpoint()", invalidateAt);
  const abortAt = watchdog.indexOf('action: "SCRAPE_ABORT"', persistAt);
  const retryAt = watchdog.indexOf('retryIncompleteGridCell(idx, "stall_watchdog")', abortAt);

  assert.ok(invalidateAt >= 0, "watchdog phải tăng generation của cell");
  assert.ok(persistAt > invalidateAt, "generation mới phải được persist");
  assert.ok(abortAt > persistAt, "chỉ abort request cũ sau khi đã invalidate");
  assert.ok(retryAt > abortAt, "watchdog chỉ tạo retry sau khi abort request cũ");
});

test("content Maps phiên bản cũ bị từ chối cả ở lần PING cuối", async () => {
  const source = section("async function ensureMapsContentReady", "async function sendMapsMessage");

  async function runCase(version) {
    let pingCount = 0;
    const calls = [];
    const chrome = {
      tabs: {
        sendMessage: async (_tabId, message) => {
          assert.equal(message.action, "PING");
          pingCount += 1;
          return { ok: true, v: version };
        },
        reload: async (tabId) => calls.push(["reload", tabId])
      },
      scripting: {
        executeScript: async (options) => calls.push(["inject", options.target.tabId])
      }
    };
    const context = vm.createContext({
      REQUIRED_CONTENT_VERSION: 72,
      chrome,
      markMapsControlledActivity: () => {},
      waitTabComplete: async () => {},
      sleep: async () => {}
    });
    vm.runInContext(`${source}\nthis.ensureMapsContentReady = ensureMapsContentReady;`, context);

    const ready = await context.ensureMapsContentReady(17);
    return { ready, pingCount, calls };
  }

  const outdated = await runCase(71);
  assert.equal(outdated.ready, false);
  assert.ok(outdated.pingCount > 1, "phải đi tới fallback cuối sau các lần thử khởi tạo lại");
  assert.deepEqual(outdated.calls[0], ["reload", 17]);

  const current = await runCase(72);
  assert.equal(current.ready, true);
  assert.equal(current.pingCount, 1);
  assert.deepEqual(current.calls, []);
});

test("pha enrich background là single-flight", async () => {
  const source = section("function runEnrichPhase()", "async function runEnrichPhaseInternal()");
  const pending = [];
  let runs = 0;
  const context = vm.createContext({
    enrichRunPromise: null,
    continueGridAfterEnrich: () => {},
    runEnrichPhaseInternal: () => {
      runs += 1;
      return new Promise((resolve) => pending.push(resolve));
    }
  });
  vm.runInContext(`${source}\nthis.runEnrichPhase = runEnrichPhase;`, context);

  const first = context.runEnrichPhase();
  const duplicate = context.runEnrichPhase();
  assert.equal(first, duplicate);
  assert.equal(runs, 1);

  pending.shift()();
  await first;
  await Promise.resolve();

  const next = context.runEnrichPhase();
  assert.notEqual(next, first);
  assert.equal(runs, 2);
  pending.shift()();
  await next;
});

test("pha enrich hai ô nhả promise cũ trước khi bắt đầu ô kế tiếp", async () => {
  const completeCell = section("async function completeCellAfterEnrich", "function continueGridAfterEnrich");
  const orchestration = section("function continueGridAfterEnrich", "async function closeMapsTabSafely");
  const enrichedCells = [];
  const activeAtGridStart = [];
  let finishSearch;
  const searchFinished = new Promise((resolve) => {
    finishSearch = resolve;
  });
  const scrapeState = {
    running: true,
    mapsTabId: 91,
    searchParams: { webUrl: "https://findmap.vn" },
    gridIndex: 0,
    totalCells: 2,
    completedCells: new Set(),
    enrichedPlaceKeys: new Set(),
    failedEnrichKeys: new Set(),
    enrichTotal: 0,
    _cellRetryCounts: {},
    _cellRecoveryCounts: {},
    _cellContinueFlags: {}
  };
  const places = [
    { name: "Ô 1", _enrichKey: "url:cell-1", _enrichCellIndex: 0 },
    { name: "Ô 2", _enrichKey: "url:cell-2", _enrichCellIndex: 1 }
  ];
  const sandbox = {
    scrapeState,
    enrichRunPromise: null,
    pointsFinalized: false,
    getFinalResultsList: () => places,
    getEnrichCheckpointKey: (place) => place._enrichKey,
    calcProgressPercent: () => 50,
    notifyProgress: () => {},
    scheduleSyncSnapshot: () => {},
    clearPendingCellPlaces: () => {},
    persistScrapeCheckpoint: async () => {},
    sendMapsMessage: async () => {},
    beginOperationTransition: () => Symbol("transition"),
    endOperationTransition: () => {},
    closeMapsTabSafely: async () => {},
    resetScrapeState: async () => {},
    chrome: { runtime: { sendMessage: () => {} } },
    console,
    abortSearch: async (_code, message) => {
      throw new Error(`Không được abort: ${message}`);
    },
    enrichPlacesInCell: async (cellPlaces, cellIndex) => {
      enrichedCells.push(cellIndex);
      for (const place of cellPlaces) scrapeState.enrichedPlaceKeys.add(place._enrichKey);
      return cellPlaces.length;
    },
    handleScrapeComplete: async () => {
      sandbox.pointsFinalized = true;
      scrapeState.running = false;
      finishSearch();
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    `${completeCell}\n${orchestration}\nthis.api = {\n` +
      `  runEnrichPhase,\n` +
      `  activePromise: () => enrichRunPromise\n` +
      `};`,
    context
  );
  sandbox.runGridCell = async (nextIndex) => {
    activeAtGridStart.push(context.api.activePromise());
    scrapeState.gridIndex = nextIndex;
    await context.api.runEnrichPhase();
  };

  const first = context.api.runEnrichPhase();
  await Promise.race([
    searchFinished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock enrich nhiều ô")), 250))
  ]);
  await first;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(enrichedCells, [0, 1]);
  assert.deepEqual([...scrapeState.completedCells], [0, 1]);
  assert.deepEqual(activeAtGridStart, [null], "promise ô cũ phải được nhả trước khi dispatch ô mới");
  assert.equal(context.api.activePromise(), null);
});

test("enrich dùng opId, hủy đúng thao tác và bỏ response sai opId", () => {
  const backgroundEnrich = section(
    "async function cancelActiveEnrichOperation",
    "async function markEnrichFailure"
  );
  const contentEnrich = contentSection("function cancelActiveEnrich", "window.__timDiemBanWake");
  const contentHandler = contentSection(
    'if (message.action === "ENRICH_PLACE")',
    'if (message.action === "ENRICH_ONE")'
  );

  assert.match(backgroundEnrich, /ENRICH_ABORT[\s\S]*data:\s*\{\s*opId\s*\}/);
  assert.match(backgroundEnrich, /response\?\.settled\s*===\s*true/);
  assert.match(backgroundEnrich, /reloadMapsAfterUnsettledEnrich\(tabId\)/);
  assert.ok(
    backgroundEnrich.indexOf("await cancelActiveEnrichOperation()") <
      backgroundEnrich.indexOf("await navigateMapsTab({ url: href })"),
    "phải xác nhận op cũ settled hoặc reload xong trước khi điều hướng URL mới"
  );
  assert.match(backgroundEnrich, /ENRICH_PLACE[\s\S]*thorough:\s*true,[\s\S]*opId/);
  assert.match(backgroundEnrich, /result\?\.opId\s*!==\s*opId\s*\|\|\s*result\?\.success\s*!==\s*true/);
  assert.match(contentEnrich, /activeEnrichTask\s*&&\s*activeEnrichOpId\s*===\s*opId/);
  assert.match(contentEnrich, /activeEnrichOpId\s*!==\s*opId/);
  assert.match(contentHandler, /ENRICH_ABORT[\s\S]*cancelActiveEnrich\(opId\)/);
  assert.match(contentHandler, /success:\s*settled,[\s\S]*settled,/);
});

test("abort enrich chưa settled luôn reload Maps trước URL tiếp theo", async () => {
  const source = section("const ENRICH_ABORT_TIMEOUT_MS", "async function markEnrichFailure");

  async function runCase(sendMessage, timeoutMs = 20) {
    const calls = [];
    const scrapeState = {
      mapsTabId: 7,
      _activeEnrichOpId: "op-old",
      _expectMapsNavigation: false
    };
    const context = vm.createContext({
      scrapeState,
      chrome: {
        tabs: {
          sendMessage: async (...args) => {
            calls.push(["abort", ...args]);
            return sendMessage();
          },
          reload: async (tabId) => calls.push(["reload", tabId])
        }
      },
      markMapsControlledActivity: (ms) => calls.push(["mark", ms]),
      waitTabComplete: async (tabId, ms) => calls.push(["wait", tabId, ms]),
      ensureMapsContentReady: async (tabId) => {
        calls.push(["ready", tabId]);
        return true;
      },
      sleep: async (ms) => calls.push(["sleep", ms]),
      bgLog: (line) => calls.push(["log", line]),
      beginMapsCellWork: () => Symbol("cell"),
      endMapsCellWork: () => {},
      getPlaceDetailUrl: () => "",
      crypto: { randomUUID: () => "uuid" },
      setTimeout,
      clearTimeout
    });
    vm.runInContext(
      `${source}\nthis.cancelActiveEnrichOperation = cancelActiveEnrichOperation;`,
      context
    );

    await context.cancelActiveEnrichOperation({ timeoutMs });
    return { calls, scrapeState };
  }

  const settled = await runCase(() => ({ success: true, opId: "op-old", settled: true }));
  assert.deepEqual(
    settled.calls.map(([name]) => name),
    ["abort"],
    "response settled không được reload"
  );
  assert.equal(settled.scrapeState._activeEnrichOpId, "");

  for (const [label, sendMessage, timeoutMs] of [
    ["unsettled", () => ({ success: true, opId: "op-old", settled: false }), 20],
    ["message fail", () => Promise.reject(new Error("port closed")), 20],
    ["timeout", () => new Promise(() => {}), 5]
  ]) {
    const recovered = await runCase(sendMessage, timeoutMs);
    const callNames = recovered.calls.map(([name]) => name);
    assert.deepEqual(
      callNames.filter((name) => ["reload", "wait", "ready"].includes(name)),
      ["reload", "wait", "ready"],
      `${label}: phải reload, chờ complete và khởi tạo content theo đúng thứ tự`
    );
    assert.equal(recovered.scrapeState._expectMapsNavigation, false);
    assert.equal(recovered.scrapeState._activeEnrichOpId, "");
  }
});

test("ENRICH_PLACE chưa settled dựng reload barrier trước URL kế tiếp", async () => {
  const source = section("async function enrichPlaceByUrl", "async function markEnrichFailure");
  const calls = [];
  let uuid = 0;
  let sendCount = 0;
  const scrapeState = {
    runId: "restart-run",
    gridIndex: 0,
    mapsTabId: 17,
    _activeEnrichOpId: ""
  };
  const context = vm.createContext({
    scrapeState,
    getPlaceDetailUrl: (place) => place.href,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    beginMapsCellWork: () => Symbol("cell-work"),
    endMapsCellWork: () => calls.push("cell:end"),
    cancelActiveEnrichOperation: async () => calls.push("enrich:cancel-old"),
    navigateMapsTab: async ({ url }) => calls.push(`navigate:${url}`),
    sleep: async () => {},
    sendMapsMessageWithTimeout: async (_action, data) => {
      sendCount += 1;
      calls.push(`send:${data.listData.href}`);
      if (sendCount === 1) {
        return { success: false, settled: false, opId: data.opId };
      }
      return {
        success: true,
        settled: true,
        opId: data.opId,
        place: { ...data.listData, phone: "0900000000" }
      };
    },
    reloadMapsAfterUnsettledEnrich: async (tabId) => calls.push(`reload:${tabId}`)
  });
  vm.runInContext(`${source}\nthis.enrichPlaceByUrl = enrichPlaceByUrl;`, context);

  let firstError = null;
  try {
    await context.enrichPlaceByUrl(
      { href: "https://www.google.com/maps/place/first" },
      {},
      "first",
      50,
      1
    );
  } catch (err) {
    firstError = err;
  }
  const second = await context.enrichPlaceByUrl(
    { href: "https://www.google.com/maps/place/second" },
    {},
    "second",
    60,
    1
  );

  const firstSendAt = calls.indexOf("send:https://www.google.com/maps/place/first");
  const reloadAt = calls.indexOf("reload:17");
  const secondNavigateAt = calls.indexOf("navigate:https://www.google.com/maps/place/second");
  assert.ok(firstSendAt >= 0 && reloadAt > firstSendAt, "response unsettled phải kích hoạt reload");
  assert.ok(reloadAt < secondNavigateAt, "URL sau chỉ được điều hướng khi reload barrier đã xong");
  assert.equal(second.phone, "0900000000");
  assert.equal(scrapeState._activeEnrichOpId, "");
  if (firstError) assert.match(firstError.message, /chưa dừng|tải lại/i);
});

test("URL enrich thiếu hoặc lỗi chỉ ghi failed, không ghi enriched", async () => {
  const source = section("async function markEnrichFailure", "function pushLiveItemsToWeb");
  const completed = [];
  const sent = [];
  const attempts = new Map();
  const scrapeState = {
    running: true,
    totalCells: 1,
    enrichedPlaceKeys: new Set(),
    failedEnrichKeys: new Set()
  };
  const context = vm.createContext({
    scrapeState,
    MAX_DIRECT_URL_RETRIES: 2,
    getEnrichCheckpointKey: (place) => place.name,
    getPlaceDetailUrl: (place) => place.href || "",
    bgLog: () => {},
    notifyPopup: () => {},
    notifyProgress: () => {},
    calcProgressPercent: () => 50,
    sleep: async () => {},
    persistEnrichAttemptProgress: async () => {},
    preserveEnrichMetadata: (place) => place,
    enrichPlaceByUrl: async (place) => {
      attempts.set(place.name, (attempts.get(place.name) || 0) + 1);
      if (place.name === "Lỗi") throw new Error("detail failed");
      return { ...place, phone: "0900000000" };
    },
    upsertMergedPlace: () => {},
    sendItemToWeb: (_webUrl, place) => sent.push(place.name),
    markEnrichAttemptComplete: async (place) => {
      scrapeState.enrichedPlaceKeys.add(place.name);
      completed.push(place.name);
    },
    console: { warn: () => {} }
  });
  vm.runInContext(`${source}\nthis.enrichPlacesInCell = enrichPlacesInCell;`, context);

  const done = await context.enrichPlacesInCell(
    [
      { name: "Thiếu URL" },
      { name: "Lỗi", href: "https://www.google.com/maps/place/loi" },
      { name: "Tốt", href: "https://www.google.com/maps/place/tot" }
    ],
    0,
    { webUrl: "https://findmap.vn" },
    0,
    3
  );

  assert.equal(done, 3);
  assert.deepEqual([...scrapeState.failedEnrichKeys], ["Thiếu URL", "Lỗi"]);
  assert.deepEqual([...scrapeState.enrichedPlaceKeys], ["Tốt"]);
  assert.deepEqual(completed, ["Tốt"]);
  assert.deepEqual(sent, ["Tốt"]);
  assert.equal(attempts.get("Lỗi"), 2);
  assert.equal(attempts.get("Tốt"), 1);
});

test("resume enrich coi failed key là terminal và giữ đúng processed checkpoint", async () => {
  const restore = section("function restoreScrapeStateFromCheckpoint", "function nextPendingCellFromScrapeState");
  const run = section("async function runEnrichPhaseInternal", "async function closeMapsTabSafely");
  const enrichedCalls = [];
  let completedCell = null;
  const scrapeState = {
    running: false,
    mapsTabId: null,
    searchParams: null,
    gridIndex: 0,
    totalCells: 0,
    completedCells: new Set(),
    enrichedPlaceKeys: new Set(),
    failedEnrichKeys: new Set(),
    mergedPlaces: new Map(),
    pendingCellPlaces: new Map(),
    _cellRetryCounts: {},
    _cellRecoveryCounts: {},
    _cellContinueFlags: {}
  };
  const placesToMap = (items) => new Map(items.map((place) => [place._enrichKey, place]));
  const context = vm.createContext({
    scrapeState,
    PER_CELL_ENRICH_FLOW_VERSION: 2,
    CELL_FLOW_VERSION: 3,
    placesToMap,
    activeMapsCellListToken: null,
    currentSearch: null,
    lastScrapeProgressAt: 0,
    getFinalResultsList: () => [...scrapeState.mergedPlaces.values()],
    getEnrichCheckpointKey: (place) => place._enrichKey,
    persistScrapeCheckpoint: async () => {},
    calcProgressPercent: () => 70,
    notifyProgress: () => {},
    sendMapsMessage: async () => {},
    enrichPlacesInCell: async (places, cellIndex, _params, processed, total) => {
      enrichedCalls.push({ keys: places.map((place) => place._enrichKey), cellIndex, processed, total });
      return total;
    },
    completeCellAfterEnrich: async (cellIndex) => {
      completedCell = cellIndex;
      return null;
    },
    handleScrapeComplete: async () => {}
  });
  vm.runInContext(
    `${restore}\n${run}\nthis.api = { restoreScrapeStateFromCheckpoint, runEnrichPhaseInternal };`,
    context
  );

  const restored = context.api.restoreScrapeStateFromCheckpoint({
    cellFlowVersion: 3,
    searchParams: { searchId: "resume-failed", webUrl: "https://findmap.vn" },
    mapsTabId: 17,
    gridIndex: 0,
    totalCells: 1,
    phase: "enrich",
    enrichTotal: 3,
    completedCells: [],
    enrichedPlaceKeys: ["cid:done"],
    failedEnrichKeys: ["cid:failed"],
    mergedPlaces: [
      { name: "Đã xong", _enrichKey: "cid:done", _enrichCellIndex: 0 },
      { name: "Lỗi terminal", _enrichKey: "cid:failed", _enrichCellIndex: 0 },
      { name: "Còn lại", _enrichKey: "cid:pending", _enrichCellIndex: 0 }
    ]
  });
  scrapeState.running = true;
  await context.api.runEnrichPhaseInternal();

  assert.equal(restored, true);
  assert.deepEqual(enrichedCalls, [
    { keys: ["cid:pending"], cellIndex: 0, processed: 2, total: 3 }
  ]);
  assert.equal(completedCell, 0);
  assert.deepEqual([...scrapeState.failedEnrichKeys], ["cid:failed"]);
});

test("reload Maps chỉ khôi phục, không abort bằng mã reload cũ", () => {
  const reload = section("async function handleMapsTabReloaded", "chrome.tabs.onUpdated.addListener");

  assert.doesNotMatch(reload, /MAPS_RELOAD_(?:IDLE|STOP|FAILED)/);
  assert.doesNotMatch(reload, /abortSearch\(\s*["']MAPS_RELOAD_/);
  assert.match(reload, /runEnrichPhase\(\)/);
  assert.match(reload, /runGridCell\(resumeAt\)/);
});

test("mỗi request danh sách kết thúc dưới giới hạn 5 phút của MV3", () => {
  const match = background.match(/const\s+CELL_LIST_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  assert.ok(match, "không tìm thấy CELL_LIST_TIMEOUT_MS");
  assert.ok(Number(match[1]) >= 240000, `timeout hiện tại là ${match[1]}ms`);
  assert.ok(Number(match[1]) < 300000, `timeout hiện tại là ${match[1]}ms`);
});

test("danh sách dài được checkpoint theo chunk rồi cuộn tiếp cùng ô", () => {
  const checkpoint = section("async function persistScrapeCheckpoint", "function restoreScrapeStateFromCheckpoint");
  const restore = section("function restoreScrapeStateFromCheckpoint", "function nextPendingCellFromScrapeState");
  const retry = section("async function retryIncompleteGridCell", "function isCompleteCellResult");
  const runCell = section("async function runGridCell", "function getEnrichCheckpointKey");

  assert.match(checkpoint, /pendingCellPlaces/);
  assert.match(checkpoint, /pendingCellIndex/);
  assert.match(checkpoint, /cellContinueFlags/);
  assert.match(restore, /hasChunkedCellList/);
  assert.match(retry, /reason === "chunk_budget"/);
  assert.match(retry, /continueFlags\[cellIndex\] = canContinueChunk/);
  assert.match(runCell, /resumeFromCurrent: continuingSameCell/);
  assert.match(runCell, /stagePendingCellPlaces\(cellIndex, stampedPlaces\)/);
  assert.ok(
    runCell.indexOf("stagePendingCellPlaces(cellIndex, stampedPlaces)") <
      runCell.indexOf("if (!isCompleteCellResult(result))"),
    "URL của chunk phải được lưu trước khi retry"
  );
});

test("waitTabComplete gắn listener trước khi re-check tabs.get", async () => {
  const source = section("async function waitTabComplete", "const EXT_QUEUE_KEY");
  const calls = [];
  const event = (name) => ({
    addListener: () => calls.push(`add:${name}`),
    removeListener: () => calls.push(`remove:${name}`)
  });
  const chrome = {
    tabs: {
      onUpdated: event("updated"),
      onRemoved: event("removed"),
      get: async () => {
        calls.push("get");
        return { status: "complete" };
      }
    }
  };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, Error });
  vm.runInContext(`${source}\nthis.waitTabComplete = waitTabComplete;`, context);

  await context.waitTabComplete(17, 100);

  assert.deepEqual(calls.slice(0, 3), ["add:updated", "add:removed", "get"]);
  assert.deepEqual(calls.slice(3), ["remove:updated", "remove:removed"]);
});

test("rescan delivery thất bại giữ nguyên placeIndex và retry qua alarm", async () => {
  const source =
    section("async function sendRescanDataWithRetry", "async function abortRescan") +
    section("async function runRescanPlacesLoop", "async function finishRescanNormal");
  const calls = [];
  const rescanState = {
    running: true,
    placeIndex: 0,
    done: 0,
    failed: 0,
    total: 1,
    places: [{ name: "A", href: "https://www.google.com/maps/place/A" }],
    webUrl: "https://findmap.vn",
    searchParams: {}
  };
  const context = vm.createContext({
    rescanState,
    enrichRescanPlace: async () => ({ name: "A", phone: "090" }),
    sendToWebPage: async () => (calls.push("deliver"), false),
    sleep: async () => {},
    persistRescanCheckpoint: async () => calls.push("checkpoint"),
    ensureDurableWorkAlarm: async () => calls.push("alarm"),
    markRescanDataActivity: () => {},
    console
  });
  vm.runInContext(`${source}\nthis.runRescanPlacesLoop = runRescanPlacesLoop;`, context);

  assert.equal(await context.runRescanPlacesLoop(), false);
  assert.equal(rescanState.placeIndex, 0);
  assert.equal(rescanState.done, 0);
  assert.equal(calls.filter((call) => call === "deliver").length, 4);
  assert.deepEqual(calls.slice(-2), ["checkpoint", "alarm"]);
});

test("rescan bỏ qua URL hỏng, tiếp tục hàng đợi và báo số lỗi", async () => {
  const source =
    section("async function sendRescanDataWithRetry", "async function abortRescan") +
    section("async function runRescanPlacesLoop", "async function finishRescanNormal");
  const rescanState = {
    running: true,
    placeIndex: 0,
    done: 0,
    failed: 0,
    total: 1,
    places: [{ name: "URL hỏng" }],
    webUrl: "https://findmap.vn",
    searchParams: {}
  };
  const context = vm.createContext({
    rescanState,
    enrichRescanPlace: async () => null,
    sendToWebPage: async () => true,
    sleep: async () => {},
    persistRescanCheckpoint: async () => true,
    ensureDurableWorkAlarm: async () => {},
    markRescanDataActivity: () => {},
    console
  });
  vm.runInContext(`${source}\nthis.runRescanPlacesLoop = runRescanPlacesLoop;`, context);

  assert.equal(await context.runRescanPlacesLoop(), true);
  assert.equal(rescanState.placeIndex, 1);
  assert.equal(rescanState.done, 1);
  assert.equal(rescanState.failed, 1);
  assert.match(webApp, /điểm không đọc được/);
});

test("rescan terminal resume gửi complete mà không mở lại Maps", async () => {
  const source = section("async function tryResumeRescanFromCheckpoint", "function resetRescanState");
  const calls = [];
  const state = { running: false, placeIndex: 0, places: null };
  const context = vm.createContext({
    scrapeState: { running: false },
    rescanState: state,
    getRescanCheckpoint: async () => ({ running: true, placeIndex: 1, places: [{ name: "A" }] }),
    restoreRescanStateFromCheckpoint: (checkpoint) => {
      state.running = true;
      state.placeIndex = checkpoint.placeIndex;
      state.places = checkpoint.places;
      return true;
    },
    ensureDurableWorkAlarm: async () => calls.push("alarm"),
    finishRescanNormal: async () => (calls.push("complete"), true),
    chrome: { tabs: { get: async () => { throw new Error("Maps must not open"); } } },
    isRescanAutoReopenEnabled: () => false,
    openRescanMapsTab: async () => { throw new Error("Maps must not open"); }
  });
  vm.runInContext(`${source}\nthis.tryResumeRescanFromCheckpoint = tryResumeRescanFromCheckpoint;`, context);

  assert.equal(await context.tryResumeRescanFromCheckpoint(), true);
  assert.deepEqual(calls, ["alarm", "complete"]);
});

test("rescan đã abort chỉ retry terminal payload, không chạy lại hàng đợi", async () => {
  const source = section("async function tryResumeRescanFromCheckpoint", "function resetRescanState");
  const calls = [];
  const state = { running: false, placeIndex: 0, places: null, _terminalCompletion: null };
  const terminalCompletion = {
    done: 2,
    failed: 1,
    total: 5,
    error: "Đã dừng quét lại",
    code: "MAPS_REOPEN_LIMIT",
    partial: true
  };
  const context = vm.createContext({
    scrapeState: { running: false },
    rescanState: state,
    getRescanCheckpoint: async () => ({
      running: true,
      placeIndex: 2,
      places: [{}, {}, {}, {}, {}],
      terminalCompletion
    }),
    restoreRescanStateFromCheckpoint: (checkpoint) => {
      state.running = true;
      state.placeIndex = checkpoint.placeIndex;
      state.places = checkpoint.places;
      state._terminalCompletion = checkpoint.terminalCompletion;
      return true;
    },
    ensureDurableWorkAlarm: async () => calls.push("alarm"),
    deliverRescanTerminalCompletion: async () => (calls.push("terminal"), true),
    finishRescanNormal: async () => { throw new Error("must not finish as normal"); },
    chrome: { tabs: { get: async () => { throw new Error("must not inspect Maps"); } } },
    isRescanAutoReopenEnabled: () => true,
    openRescanMapsTab: async () => { throw new Error("must not reopen Maps"); }
  });
  vm.runInContext(`${source}\nthis.tryResumeRescanFromCheckpoint = tryResumeRescanFromCheckpoint;`, context);

  assert.equal(await context.tryResumeRescanFromCheckpoint(), true);
  assert.deepEqual(calls, ["alarm", "terminal"]);
});

test("START_RESCAN dọn checkpoint main sau khi flush completion", () => {
  const start = section("async function handleStartRescan", "async function enrichRescanPlace");
  const flushAt = start.indexOf('flushPendingComplete("before_rescan")');
  const clearAt = start.indexOf("await clearScrapeCheckpoint()", flushAt);
  const staleAt = start.indexOf('"activeSearch", PENDING_SYNC_KEY', clearAt);
  assert.ok(flushAt >= 0 && clearAt > flushAt && staleAt > clearAt);
  assert.match(start, /if \(pendingComplete\.pending\)/);
});
