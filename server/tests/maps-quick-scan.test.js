const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const background = fs.readFileSync(path.join(rootDir, "extension", "background.js"), "utf8");

function section(start, end) {
  const from = background.indexOf(start);
  const to = background.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Missing background marker: ${start}`);
  assert.notEqual(to, -1, `Missing background marker: ${end}`);
  return background.slice(from, to);
}

test("quét nhanh sở hữu đúng hai tab Maps và cleanup đóng cả hai", () => {
  const runCell = section("async function runGridCell", "function normalizePlaceDetailUrl");
  const closeTabs = section("async function closeMapsTabSafely", "async function handleScrapeComplete");

  assert.match(runCell, /await openMapsScrapeTab\(url\)/);
  assert.match(runCell, /await openQuickEnrichTab\(url\)/);
  assert.equal((runCell.match(/openQuickEnrichTab\(/g) || []).length, 1);
  assert.match(
    closeTabs,
    /new Set\(\[scrapeState\.mapsTabId, scrapeState\.enrichTabId\]\.filter\(Number\.isInteger\)\)/
  );
  assert.match(closeTabs, /Promise\.all\(tabIds\.map/);
});

test("producer chuyển ô mà không chờ consumer xử lý hết URL", async () => {
  const source = section("async function handleQuickCellListComplete", "async function handleCellListComplete");
  const calls = [];
  let releaseConsumer;
  const consumer = new Promise((resolve) => {
    releaseConsumer = resolve;
  });
  const scrapeState = {
    running: true,
    quickScan: true,
    searchParams: { quickScan: true },
    mergedPlaces: new Map(),
    gridPoints: [{}, {}],
    gridIndex: 0,
    totalCells: 2,
    completedCells: new Set(),
    enrichTotal: 0,
    _cellContinueFlags: {},
    _cellRestartFlags: {},
    _cellResumeLeases: {}
  };
  const context = vm.createContext({
    scrapeState,
    pointsFinalized: false,
    bgLog: () => {},
    mergePlaces: () => scrapeState.mergedPlaces.set("a", { name: "A" }),
    clearPendingCellPlaces: () => {},
    scheduleLiveSearchBackup: () => {},
    getFinalResultsList: () => [...scrapeState.mergedPlaces.values()],
    calcProgressPercent: () => 30,
    buildProgressText: () => "progress",
    scheduleSyncSnapshot: () => {},
    notifyProgress: () => {},
    clearCellListProgress: () => {},
    persistScrapeCheckpoint: async () => calls.push("checkpoint"),
    runQuickEnrichPhase: () => {
      calls.push("consumer:start");
      return consumer;
    },
    waitForQuickQueueCapacity: async () => calls.push("queue:ok"),
    runGridCell: async (index) => calls.push(`producer:${index}`),
    abortSearch: async () => assert.fail("không được abort"),
    String,
    console
  });
  vm.runInContext(`${source}\nthis.handleQuickCellListComplete = handleQuickCellListComplete;`, context);

  await context.handleQuickCellListComplete({
    places: [{ name: "A" }],
    cellIndex: 0,
    totalCells: 2,
    reachedEnd: true
  });

  assert.ok(calls.indexOf("consumer:start") < calls.indexOf("producer:1"));
  assert.ok(calls.includes("producer:1"), "producer phải sang ô 2 khi consumer vẫn đang chạy");
  releaseConsumer(false);
});

test("consumer quét nhanh là single-flight", async () => {
  const source = section("function runQuickEnrichPhase()", "async function waitForQuickQueueCapacity");
  let runs = 0;
  const pending = [];
  const context = vm.createContext({
    scrapeState: {
      quickScan: true,
      searchParams: { quickScan: true },
      _enrichGeneration: 4
    },
    quickEnrichRunPromise: null,
    runQuickEnrichPhaseInternal: () => {
      runs += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
    Promise
  });
  vm.runInContext(`${source}\nthis.runQuickEnrichPhase = runQuickEnrichPhase;`, context);

  const first = context.runQuickEnrichPhase();
  const duplicate = context.runQuickEnrichPhase();
  assert.equal(first, duplicate);
  assert.equal(runs, 1);

  pending.shift()(false);
  await first;
  await Promise.resolve();
  const next = context.runQuickEnrichPhase();
  assert.notEqual(next, first);
  assert.equal(runs, 2);
  pending.shift()(false);
  await next;
});

test("hàng đợi URL suy ra bền vững từ snapshot và loại enriched/failed", () => {
  const source = section("function getQuickPendingEnrichPlaces", "async function ensureQuickEnrichTab");
  const places = [
    { _enrichKey: "a" },
    { _enrichKey: "b" },
    { _enrichKey: "c" }
  ];
  const context = vm.createContext({
    scrapeState: {
      quickScan: true,
      searchParams: { quickScan: true },
      mergedPlaces: new Map(places.map((place) => [place._enrichKey, place])),
      enrichedPlaceKeys: new Set(["a"]),
      failedEnrichKeys: new Set(["b"])
    },
    getEnrichCheckpointKey: (place) => place._enrichKey
  });
  vm.runInContext(`${source}\nthis.getQuickPendingEnrichPlaces = getQuickPendingEnrichPlaces;`, context);

  assert.deepEqual(
    Array.from(context.getQuickPendingEnrichPlaces(), (place) => place._enrichKey),
    ["c"]
  );
  assert.doesNotMatch(source, /getFinalResultsList/);
});

test("checkpoint quét nhanh lưu và phục hồi đủ hai tab cùng producer state", () => {
  const save = section("async function persistScrapeCheckpoint", "function restoreScrapeStateFromCheckpoint");
  const restore = section("function restoreScrapeStateFromCheckpoint", "async function clearScrapeCheckpoint");

  for (const field of [
    "quickScan",
    "quickProducerDone",
    "enrichTabId",
    "enrichWindowId",
    "enrichMapsReopenCount"
  ]) {
    assert.match(save, new RegExp(`${field}:`));
  }
  assert.match(restore, /scrapeState\.quickScan = cp\.quickScan === true/);
  assert.match(restore, /scrapeState\.quickProducerDone = scrapeState\.quickScan && cp\.quickProducerDone === true/);
  assert.match(restore, /scrapeState\.enrichTabId = cp\.enrichTabId \?\? null/);
  assert.match(restore, /scrapeState\._enrichGeneration = Number\(cp\.enrichGeneration \|\| 0\) \+ 1/);
});

test("chỉ hoàn tất khi producer xong và consumer không còn URL", async () => {
  const source = section("async function completeQuickScanIfReady", "async function runQuickEnrichPhaseInternal");
  let pending = [{}];
  let completed = 0;
  const scrapeState = {
    running: true,
    quickScan: true,
    quickProducerDone: false,
    searchParams: { quickScan: true },
    _enrichGeneration: 2,
    mapsTabId: 11,
    enrichTabId: 12
  };
  const context = vm.createContext({
    scrapeState,
    getQuickPendingEnrichPlaces: () => pending,
    getFinalResultsList: () => [{ name: "A" }],
    notifyProgress: () => {},
    closeMapsTabSafely: async () => {},
    resetScrapeState: async () => {},
    handleScrapeComplete: async () => {
      completed += 1;
    },
    chrome: {
      runtime: { sendMessage: () => {} },
      tabs: { sendMessage: async () => ({ success: true }) }
    },
    Promise,
    Number
  });
  vm.runInContext(`${source}\nthis.completeQuickScanIfReady = completeQuickScanIfReady;`, context);

  assert.equal(await context.completeQuickScanIfReady(2), false);
  scrapeState.quickProducerDone = true;
  assert.equal(await context.completeQuickScanIfReady(2), false);
  pending = [];
  assert.equal(await context.completeQuickScanIfReady(2), true);
  assert.equal(completed, 1);
});

test("mất tab list và tab enrich có recovery độc lập", () => {
  const listeners = section("chrome.windows.onRemoved.addListener", "function markMapsControlledActivity");
  const enrichLoss = section("async function handleQuickEnrichTabLost", "async function persistRescanCheckpoint");

  assert.match(listeners, /tabId === scrapeState\.mapsTabId/);
  assert.match(listeners, /tabId === scrapeState\.enrichTabId/);
  assert.match(listeners, /enqueueMapsTabRecovery\(\(\) => handleSearchMapsTabLost\(/);
  assert.match(listeners, /enqueueMapsTabRecovery\(\(\) => handleQuickEnrichTabLost\(/);
  assert.match(enrichLoss, /scrapeState\._enrichGeneration = Number\(scrapeState\._enrichGeneration \|\| 0\) \+ 1/);
  assert.match(enrichLoss, /await ensureQuickEnrichTab\(\)/);
  assert.match(enrichLoss, /runQuickEnrichPhase\(\)/);
});

test("quick enrich watchdog không ghi đè task mới sau pause/resume nhanh", () => {
  const recovery = section(
    "async function recoverStalledQuickEnrich",
    "async function maybeRecoverStalledScrape"
  );

  assert.match(recovery, /const staleTask = quickEnrichRunPromise/);
  assert.match(recovery, /stillOwnsObservedQuickEnrich/);
  assert.match(recovery, /stillOwnsQuickRecovery/);
  assert.match(recovery, /Number\(scrapeState\._enrichGeneration \|\| 0\) === recoveryGeneration/);
  assert.match(recovery, /if \(!stillOwnsQuickRecovery\(\)\) return false/);
  assert.match(
    recovery,
    /if \(quickEnrichRunPromise === staleTask\) quickEnrichRunPromise = null/
  );
  assert.doesNotMatch(recovery, /\n\s*quickEnrichRunPromise = null;/);
});

test("consumer quét nhanh không tạo snapshot kết quả theo từng URL", async () => {
  const source = section("async function runQuickEnrichPhaseInternal", "function runQuickEnrichPhase()");
  const place = { name: "A", href: "https://www.google.com/maps/place/A" };
  let processed = false;
  let finalListCalls = 0;
  const scrapeState = {
    running: true,
    quickScan: true,
    searchParams: { quickScan: true, webUrl: "https://findmap.vn" },
    mergedPlaces: new Map([
      ["a", place],
      ["b", { name: "B" }]
    ]),
    enrichTotal: 0,
    gridIndex: 0,
    totalCells: 1,
    _enrichGeneration: 5
  };
  const context = vm.createContext({
    scrapeState,
    ensureQuickEnrichTab: async () => true,
    getQuickPendingEnrichPlaces: () => (processed ? [] : [place]),
    getFinalResultsList: () => {
      finalListCalls += 1;
      throw new Error("hot path không được tạo snapshot");
    },
    notifyProgress: () => {},
    getPlaceDetailUrl: () => place.href,
    preserveEnrichMetadata: (value) => value,
    enrichQuickPlaceByUrl: async () => ({ ...place, phone: "0901234567" }),
    markEnrichFailure: async () => assert.fail("không được thất bại"),
    upsertMergedPlace: () => {},
    sendItemToWeb: () => {},
    markEnrichAttemptComplete: async () => {
      processed = true;
    },
    completeQuickScanIfReady: async () => "complete",
    MAX_DIRECT_URL_RETRIES: 3,
    sleep: async () => {},
    console,
    Error,
    Math,
    Number
  });
  vm.runInContext(`${source}\nthis.runQuickEnrichPhaseInternal = runQuickEnrichPhaseInternal;`, context);

  assert.equal(await context.runQuickEnrichPhaseInternal(5), "complete");
  assert.equal(finalListCalls, 0);
  assert.equal(scrapeState.enrichTotal, scrapeState.mergedPlaces.size);
  assert.doesNotMatch(source, /getFinalResultsList/);
});

test("upsert chi tiết giữ nguyên Map và giới hạn fallback near-duplicate", () => {
  const source = section("function getMergedPlaceCanonicalId", "async function persistScrapeCheckpoint");
  const records = Array.from({ length: 100 }, (_, index) => ({
    name: "Quán A",
    address: index === 99 ? "123 Đường Mẫu, Hà Nội" : `Địa chỉ ${index}`,
    key: `old:${index}`,
    match: index === 99
  }));
  const mergedPlaces = new Map(records.map((record) => [record.key, record]));
  let fullMapIterations = 0;
  const nativeEntries = mergedPlaces.entries.bind(mergedPlaces);
  mergedPlaces.entries = () => {
    fullMapIterations += 1;
    return nativeEntries();
  };
  const originalMap = mergedPlaces;
  let nearDuplicateChecks = 0;
  const scrapeState = {
    searchParams: { lat: 21, lng: 105, radius: 5 },
    gridPoints: [{ lat: 21, lng: 105 }],
    gridIndex: 0,
    mergedPlaces
  };
  const normalize = (value) => String(value || "").toLowerCase().trim();
  const context = vm.createContext({
    scrapeState,
    mergedPlaceLookupIndex: null,
    MERGED_PLACE_NEAR_DUPLICATE_CANDIDATE_LIMIT: 32,
    getCanonicalPlaceId: () => "",
    getDedupeKey: (place) => String(place.key || ""),
    normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
    normalizeName: normalize,
    normalizeAddress: normalize,
    resolvePlaceCoords: () => null,
    haversineKm: () => 999,
    isNearDuplicate: (record) => {
      nearDuplicateChecks += 1;
      return record.match === true;
    },
    mergePlaceRecord: (target, incoming) => Object.assign(target, incoming),
    isValidPlaceName: () => true,
    sanitizePlace: (place) => ({ ...place }),
    sanitizeFromList: () => null,
    String,
    Math
  });
  vm.runInContext(`${source}\nthis.upsertMergedPlace = upsertMergedPlace;`, context);

  const result = context.upsertMergedPlace({
    name: "Quán A",
    address: "123 Đường Mẫu, Hà Nội",
    phone: "0901234567",
    key: "cid:updated"
  });

  assert.equal(scrapeState.mergedPlaces, originalMap, "không được rebuild Map");
  assert.equal(scrapeState.mergedPlaces.size, 100, "record gần trùng phải được merge");
  assert.equal(result.phone, "0901234567");
  assert.equal(fullMapIterations, 1, "index chỉ rebuild một lần cho Map hiện tại");
  assert.ok(
    nearDuplicateChecks <= 64,
    `mỗi lookup chỉ được kiểm tra tối đa 32 ứng viên, thực tế ${nearDuplicateChecks}`
  );

  nearDuplicateChecks = 0;
  context.upsertMergedPlace({
    name: "Quán A",
    address: "123 Đường Mẫu, Hà Nội",
    phone: "0901234567",
    website: "https://example.com",
    key: "cid:updated"
  });
  assert.equal(nearDuplicateChecks, 0, "khóa ổn định phải đi thẳng lookup O(1)");
  assert.equal(fullMapIterations, 1, "upsert tiếp theo không được quét lại toàn Map");

  const replacement = new Map([
    [
      "cid:replacement",
      {
        name: "Quán B",
        address: "456 Đường Mẫu, Hà Nội",
        key: "cid:replacement"
      }
    ]
  ]);
  let replacementIterations = 0;
  const replacementEntries = replacement.entries.bind(replacement);
  replacement.entries = () => {
    replacementIterations += 1;
    return replacementEntries();
  };
  scrapeState.mergedPlaces = replacement;
  nearDuplicateChecks = 0;
  context.upsertMergedPlace({
    name: "Quán B",
    address: "456 Đường Mẫu, Hà Nội",
    phone: "0912345678",
    key: "cid:replacement"
  });
  context.upsertMergedPlace({
    name: "Quán B",
    address: "456 Đường Mẫu, Hà Nội",
    website: "https://replacement.example",
    key: "cid:replacement"
  });
  assert.equal(replacementIterations, 1, "Map restore/thay mới chỉ rebuild index một lần");
  assert.equal(nearDuplicateChecks, 0);

  assert.doesNotMatch(source, /dedupePlaces\(/);
  assert.doesNotMatch(source, /placesToMap\(/);

  const hotLookup = section("function findMergedPlaceEntry", "function storeMergedPlaceRecord");
  assert.doesNotMatch(hotLookup, /scrapeState\.mergedPlaces\.(entries|values)\(/);
  assert.match(hotLookup, /index\.byCanonicalId/);
  assert.match(hotLookup, /index\.byPhone/);
  assert.match(hotLookup, /index\.byName/);
});

test("pause, park và resume đẩy search_status ngay về Findmap", () => {
  const pause = section("async function pauseActiveSearch", "async function abandonActiveSearch");
  const park = section("async function parkSearchAfterResumeFailure", "async function tryResumeFromCheckpoint");
  const resumeMessage = section(
    'if (message.action === "RESUME_SEARCH")',
    'if (message.action === "START_RESCAN")'
  );
  const durableRecovery = section("async function recoverDurableWork", "function ensureServiceReady");

  assert.match(pause, /await pushSearchStatusToWeb\(status\)/);
  assert.match(park, /await pushSearchStatusToWeb\(status\)/);
  assert.match(resumeMessage, /sendResponse\(\{ success: ok, status \}\)/);
  assert.match(resumeMessage, /await pushSearchStatusToWeb\(status\)/);
  assert.match(durableRecovery, /if \(resumed\) \{\s*await pushSearchStatusToWeb\(\)/);
});

test("backpressure giới hạn queue nhưng không đổi logic lấy dữ liệu", () => {
  const source = section("async function waitForQuickQueueCapacity", "function pushLiveItemsToWeb");
  assert.match(background, /const QUICK_SCAN_QUEUE_LIMIT = 180/);
  assert.match(source, /getQuickPendingEnrichPlaces\(\)\.length >= QUICK_SCAN_QUEUE_LIMIT/);
  assert.match(source, /runQuickEnrichPhase\(\)\.catch/);
  assert.match(source, /await sleep\(1200\)/);
});

test("quét nhanh không có kết quả vẫn gửi complete về web", () => {
  const source = section(
    "async function completeQuickScanIfReady",
    "async function runQuickEnrichPhaseInternal"
  );

  assert.match(
    source,
    /if \(total === 0\) \{\s*await handleScrapeComplete\(\{ searchParams: scrapeState\.searchParams \}\)/
  );
  assert.doesNotMatch(source, /chrome\.runtime\.sendMessage\(\{\s*action: "SCRAPE_ERROR"/);
});
