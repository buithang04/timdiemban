const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const background = read("extension", "background.js");
const content = read("extension", "content.js");
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

test("tab Maps mở nền và chỉ được focus sau 5 phút không có dữ liệu mới", () => {
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

  const keepalive = section("async function scrapeKeepAliveTick", "function isMapsAutoFocusEnabled");
  assert.match(keepalive, /maybeFocusMapsTabForStall\(\)/);
  assert.doesNotMatch(keepalive, /mapsForeground|mapsTabInactiveSince|activateTabAndWindow/);
  assert.match(background, /MAPS_STALL_FOCUS_MS = 5 \* 60 \* 1000/);
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
  assert.match(complete, /\} finally \{[\s\S]*closeMapsTabSafely\(\);[\s\S]*resetScrapeState\(\);/);
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
  assert.match(progressHandler, /markMapsDataActivity\(\)/);
  assert.match(itemHandler, /markMapsDataActivity\(\)/);
  assert.match(directResponse, /markMapsDataActivity\(\)/);
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

test("content script cho phép Maps chạy nền và chỉ focus khi treo", () => {
  assert.match(content, /Bạn có thể làm việc ở tab khác/i);
  assert.match(content, /không phản hồi trong 5 phút/i);
  assert.doesNotMatch(content, /Hãy giữ tab Google Maps này ở phía trước/i);
  assert.doesNotMatch(content, /AudioContext|timdiemban-audio-unlock|requestAnimationFrame\(advance\)/);
  assert.match(`${webSearch}\n${webIndex}`, /không phản hồi trong 5 phút/i);
  assert.doesNotMatch(
    `${webSearch}\n${webIndex}`,
    /Hãy chuyển sang tab Google Maps|hãy đưa Maps lên trước|giữ tab đó ở phía trước/i
  );
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
  const completeCell = section("async function completeCellAfterEnrich", "async function runEnrichPhase");
  const enrich = section("async function runEnrichPhase", "async function closeMapsTabSafely");
  const enrichUrls = section("async function enrichPlacesInCell", "function pushLiveItemsToWeb");
  const contentEnrich = contentSection(
    'if (message.action === "ENRICH_PLACE")',
    'if (message.action === "ENRICH_ONE")'
  );

  assert.doesNotMatch(collect, /scrapeItemInPlace\(/);
  assert.match(collect, /place\.href = listData\.href/);
  assert.match(collect, /reachedEnd: scrollOutcome\.reachedEnd/);
  assert.match(handleList, /scrapeState\.phase = "enrich"/);
  assert.match(handleList, /await persistScrapeCheckpoint\(\)/);
  assert.match(handleList, /await runEnrichPhase\(\)/);
  assert.doesNotMatch(handleList, /completedCells\.add|runGridCell\(/);

  const markDoneAt = completeCell.indexOf("scrapeState.completedCells.add(cellIndex)");
  const nextCellAt = completeCell.indexOf("await runGridCell(nextIndex)");
  assert.ok(markDoneAt >= 0 && nextCellAt > markDoneAt);

  assert.match(enrich, /Number\(place\._enrichCellIndex\) === Number\(cellIndex\)/);
  assert.match(enrich, /cellPlaces\.filter\(\(place\) => getPlaceDetailUrl\(place\)\)/);
  assert.doesNotMatch(enrich, /placeNeedsEnrich/);
  assert.match(enrichUrls, /await enrichPlaceByUrl\(place, params, progressText, pct\)/);
  assert.match(enrichUrls, /MAX_DIRECT_URL_RETRIES/);
  assert.doesNotMatch(enrichUrls, /ENRICH_ONE|findListItemForPlace|scrollToFindListItem|scrapeItemInPlace/);
  assert.match(contentEnrich, /thorough = false/);
  assert.match(contentEnrich, /fast: thorough \? false/);
  assert.match(contentEnrich, /needAddress: thorough \? true/);
  assert.match(contentEnrich, /needPhone: thorough \? true/);
  assert.match(enrich, /await completeCellAfterEnrich\(cellIndex\)/);
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
  const source = section("function getPlaceDetailUrl", "function preserveEnrichMetadata");
  const context = vm.createContext({ URL });
  vm.runInContext(`${source}\nthis.getPlaceDetailUrl = getPlaceDetailUrl;`, context);

  assert.equal(
    context.getPlaceDetailUrl({
      href: "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2!3m1!1sabc#details"
    }),
    "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2!3m1!1sabc"
  );
  assert.equal(
    context.getPlaceDetailUrl({ href: "/maps/place/Quan+Tra/@21.02,105.81/data=!4m2" }),
    "https://www.google.com/maps/place/Quan+Tra/@21.02,105.81/data=!4m2"
  );
  assert.equal(context.getPlaceDetailUrl({ href: "https://www.google.com/maps/search/tra+da" }), "");
  assert.equal(context.getPlaceDetailUrl({ href: "https://example.com/maps/place/test" }), "");
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
    CELL_FLOW_VERSION: 2,
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
