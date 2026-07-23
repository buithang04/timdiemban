const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const Lifecycle = require("../../extension/lifecycle");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Không tìm thấy mốc bắt đầu: ${start}`);
  assert.notEqual(to, -1, `Không tìm thấy mốc kết thúc: ${end}`);
  return source.slice(from, to);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("checkpoint tìm kiếm chỉ hợp lệ khi còn mới và có đủ lưới", () => {
  const now = Date.now();
  const checkpoint = {
    running: true,
    savedAt: now,
    searchParams: { searchId: "search-1" },
    gridPoints: [{ lat: 10, lng: 106 }],
    totalCells: 1,
    gridIndex: 0,
    completedCells: []
  };

  assert.equal(Lifecycle.isRecoverableScrapeCheckpoint(checkpoint, now), true);
  assert.equal(
    Lifecycle.isRecoverableScrapeCheckpoint(
      { ...checkpoint, savedAt: now - Lifecycle.MAX_CHECKPOINT_AGE_MS - 1 },
      now
    ),
    false
  );
  assert.equal(Lifecycle.isRecoverableScrapeCheckpoint({ ...checkpoint, gridPoints: [] }, now), false);
  assert.equal(Lifecycle.isRecoverableScrapeCheckpoint({ ...checkpoint, totalCells: 0 }, now), false);
  assert.equal(
    Lifecycle.isRecoverableScrapeCheckpoint(
      { ...checkpoint, savedAt: now + Lifecycle.MAX_CLOCK_SKEW_MS + 1 },
      now
    ),
    false
  );
  assert.equal(Lifecycle.isRecoverableScrapeCheckpoint({ ...checkpoint, gridIndex: -1 }, now), false);
  assert.equal(Lifecycle.isRecoverableScrapeCheckpoint({ ...checkpoint, gridIndex: 2 }, now), false);
});

test("khôi phục tìm kiếm bỏ qua đúng các ô đã hoàn tất", () => {
  assert.equal(
    Lifecycle.nextPendingCell({ totalCells: 6, gridIndex: 1, completedCells: [1, 2, 3] }),
    4
  );
  assert.equal(
    Lifecycle.nextPendingCell({ totalCells: 3, gridIndex: 0, completedCells: [0, 1, 2] }),
    3
  );
});

test("checkpoint quét lại giữ đúng vị trí tiếp theo", () => {
  const now = Date.now();
  const checkpoint = {
    running: true,
    savedAt: now,
    webUrl: "https://findmap.vn",
    places: [{ name: "A" }, { name: "B" }],
    placeIndex: 1
  };
  assert.equal(Lifecycle.isRecoverableRescanCheckpoint(checkpoint, now), true);
  assert.equal(Lifecycle.isRecoverableRescanCheckpoint({ ...checkpoint, placeIndex: 2 }, now), true);
  assert.equal(Lifecycle.isRecoverableRescanCheckpoint({ ...checkpoint, placeIndex: 3 }, now), false);
  assert.equal(Lifecycle.isRecoverableRescanCheckpoint({ ...checkpoint, placeIndex: -1 }, now), false);
  assert.equal(
    Lifecycle.isRecoverableRescanCheckpoint(
      { ...checkpoint, savedAt: now + Lifecycle.MAX_CLOCK_SKEW_MS + 1 },
      now
    ),
    false
  );
});

test("service worker dùng alarm bền vững và không dùng vòng lặp 500ms", () => {
  const background = read("extension", "background.js");

  assert.match(background, /periodInMinutes:\s*DURABLE_WORK_PERIOD_MINUTES/);
  assert.match(background, /recoverDurableWork\("watchdog_alarm"\)/);
  assert.match(background, /ensureServiceReady\(`runtime_message:/);
  assert.match(background, /RESCAN_CHECKPOINT_KEY/);
  assert.doesNotMatch(background, /setInterval\(scrapeKeepAliveTick,\s*500\)/);
});

test("checkpoint không nhân đôi danh sách rescan và không lưu auth token trong params", () => {
  const background = read("extension", "background.js");
  const persistRescan = section(
    background,
    "async function persistRescanCheckpoint",
    "async function getRescanCheckpoint"
  );
  const startRescan = section(
    background,
    "async function handleStartRescan",
    "async function doRescan"
  );
  assert.match(background, /delete durableParams\.places/);
  assert.match(background, /delete durableParams\.authToken/);
  assert.match(background, /delete durable\.authToken/);
  assert.match(
    persistRescan,
    /searchParams: toDurableSearchParams\(rescanState\.params\?\.searchParams \|\| \{\}\)/
  );
  assert.match(
    startRescan,
    /searchParams: toDurableSearchParams\(params\.searchParams \|\| \{\}\)/
  );
});

test("ghi và xóa checkpoint cùng đi qua hàng đợi serialize", () => {
  const background = read("extension", "background.js");
  const persistScrape = section(
    background,
    "async function persistScrapeCheckpoint",
    "function restoreScrapeStateFromCheckpoint"
  );
  const clearScrape = section(
    background,
    "async function clearScrapeCheckpoint",
    "async function getScrapeCheckpoint"
  );
  const persistRescan = section(
    background,
    "async function persistRescanCheckpoint",
    "async function getRescanCheckpoint"
  );
  const clearRescan = section(
    background,
    "async function clearRescanCheckpoint",
    "function restoreRescanStateFromCheckpoint"
  );

  assert.match(persistScrape, /return enqueueCheckpointMutation\(["']scrape["']/);
  assert.match(clearScrape, /return enqueueCheckpointMutation\(["']scrape["']/);
  assert.match(persistRescan, /return enqueueCheckpointMutation\(["']rescan["']/);
  assert.match(clearRescan, /return enqueueCheckpointMutation\(["']rescan["']/);
  assert.match(background, /await scrapeCheckpointQueue\.catch\(\(\) => \{\}\)[\s\S]*storage\.local\.get\(SCRAPE_CHECKPOINT_KEY\)/);
  assert.match(background, /await rescanCheckpointQueue\.catch\(\(\) => \{\}\)[\s\S]*storage\.local\.get\(RESCAN_CHECKPOINT_KEY\)/);
});

test("snapshot hoàn tất được lưu trước khi đóng Maps và recovery được ưu tiên", () => {
  const background = read("extension", "background.js");
  const complete = section(
    background,
    "async function handleScrapeComplete",
    "function dispatchRuntimeMessage"
  );
  const recover = section(background, "async function recoverDurableWork", "function ensureServiceReady");

  const prepareAt = complete.indexOf("await preparePendingComplete(completePayload)");
  const closeAt = complete.indexOf("await closeMapsTabSafely()", prepareAt);
  assert.ok(prepareAt >= 0 && closeAt > prepareAt);

  const flushAt = recover.indexOf("await flushPendingComplete(reason)");
  const scrapeAt = recover.indexOf("await getScrapeCheckpoint()", flushAt);
  const rescanAt = recover.indexOf("await getRescanCheckpoint()", scrapeAt);
  assert.ok(flushAt >= 0 && scrapeAt > flushAt && rescanAt > scrapeAt);
  assert.match(recover, /if \(pendingComplete\.pending\) return false/);
});

test("pending completion dùng marker compact sau khi snapshot recoverable đã lưu", async () => {
  const background = read("extension", "background.js");
  const source = section(
    background,
    "function buildPendingCompleteMetadata",
    "async function flushPendingComplete"
  );
  const calls = [];
  const stored = [];
  const scrapeState = {
    mergedPlaces: new Map(),
    phase: "grid",
    running: true,
    _pendingCompletion: null
  };
  const context = vm.createContext({
    PENDING_COMPLETE_VERSION: 2,
    PENDING_COMPLETE_KEY: "pendingComplete",
    SCRAPE_CHECKPOINT_KEY: "scrapeCheckpoint",
    scrapeState,
    Date,
    console,
    clearPendingSearchSync: async () => calls.push("clear-sync"),
    placesToMap: (places) => new Map(places.map((place, index) => [String(index), place])),
    persistScrapeCheckpoint: async (options) => {
      calls.push(["snapshot", options]);
      return true;
    },
    ensureDurableWorkAlarm: async () => calls.push("alarm"),
    chrome: {
      storage: {
        local: {
          set: async (record) => {
            const value = record.pendingComplete;
            if (JSON.stringify(value).length > 400) throw new Error("QUOTA_BYTES");
            calls.push("marker");
            stored.push(value);
          },
          remove: async () => {}
        }
      }
    }
  });
  vm.runInContext(`${source}\nthis.preparePendingComplete = preparePendingComplete;`, context);

  const results = Array.from({ length: 50 }, (_, index) => ({
    name: `Điểm ${index}`,
    address: "Địa chỉ đủ dài để mô phỏng payload lớn"
  }));
  const prepared = await context.preparePendingComplete({
    results,
    searchParams: { webUrl: "https://findmap.vn", searchId: "search-compact" },
    total: results.length,
    completedAt: "2026-07-22T00:00:00.000Z"
  });

  assert.equal(prepared, true);
  assert.deepEqual(plain(calls.slice(0, 3)), [
    "clear-sync",
    ["snapshot", { forceRecoverable: true }],
    "marker"
  ]);
  assert.equal(stored[0].source, "scrapeCheckpoint");
  assert.equal(stored[0].searchId, "search-compact");
  assert.equal("results" in stored[0], false);
  assert.equal("searchParams" in stored[0], false);
  assert.equal(scrapeState.phase, "pending_complete");
  assert.equal(scrapeState.mergedPlaces.size, results.length);
});

test("materialize completion đọc full results từ checkpoint và vẫn hỗ trợ payload legacy", () => {
  const background = read("extension", "background.js");
  const source = section(
    background,
    "function buildPendingCompleteMetadata",
    "async function persistPendingComplete"
  );
  const context = vm.createContext({
    PENDING_COMPLETE_VERSION: 2,
    SCRAPE_CHECKPOINT_KEY: "scrapeCheckpoint",
    countResultsWithPhone: (results) => results.filter((item) => item.phone).length
  });
  vm.runInContext(
    `${source}\nthis.materializeCompletePayloadFromCheckpoint = materializeCompletePayloadFromCheckpoint;` +
      `\nthis.isLegacyPendingComplete = isLegacyPendingComplete;`,
    context
  );

  const payload = context.materializeCompletePayloadFromCheckpoint(
    {
      searchParams: { webUrl: "https://findmap.vn", searchId: "search-1" },
      totalCells: 3,
      mergedPlaces: [{ name: "A", phone: "090" }, { name: "B" }],
      pendingCompletion: { partial: true, completedAt: "now" }
    },
    { searchId: "search-1" }
  );
  assert.equal(payload.results.length, 2);
  assert.equal(payload.searchParams.gridCells, 3);
  assert.equal(payload.searchParams.uniqueResults, 2);
  assert.equal(payload.uniquePhoneCount, 1);
  assert.equal(payload.partial, true);
  assert.equal(
    context.isLegacyPendingComplete({
      results: [],
      searchParams: { webUrl: "https://findmap.vn" }
    }),
    true
  );
});

test("recovery thử rescan sau khi main checkpoint không resume được", async () => {
  const background = read("extension", "background.js");
  const source = section(background, "async function recoverDurableWork", "function ensureServiceReady");
  const calls = [];
  const context = vm.createContext({
    durableRecoveryBusy: false,
    operationTransitionTokens: new Set(),
    scrapeState: { running: false },
    rescanState: { running: false },
    DurableLifecycle: {
      shouldAutoResumeScrapeCheckpoint: () => true,
      isRecoverableScrapeCheckpoint: () => true,
      isRecoverableRescanCheckpoint: () => true
    },
    flushPendingComplete: async () => ({ pending: false, delivered: false }),
    getScrapeCheckpoint: async () => (calls.push("get-main"), { running: true }),
    tryResumeFromCheckpoint: async () => (calls.push("resume-main"), false),
    ensureDurableWorkAlarm: async () => calls.push("alarm"),
    resetScrapeState: async (options) => calls.push(["reset-main", options]),
    getRescanCheckpoint: async () => (calls.push("get-rescan"), { running: true }),
    tryResumeRescanFromCheckpoint: async () => (calls.push("resume-rescan"), true),
    bgLog: () => {},
    clearDurableWorkAlarmIfIdle: async () => {},
    releaseDisplayKeepAwake: () => {},
    console: { log: () => {}, warn: () => {} }
  });
  vm.runInContext(`${source}\nthis.recoverDurableWork = recoverDurableWork;`, context);

  assert.equal(await context.recoverDurableWork("test"), true);
  assert.deepEqual(plain(calls), [
    "get-main",
    "resume-main",
    "alarm",
    ["reset-main", { preserveCheckpoint: true }],
    "get-rescan",
    "resume-rescan"
  ]);
});

test("auth token chỉ dùng để auth rồi bị xóa khỏi params bền", () => {
  const background = read("extension", "background.js");
  const start = section(
    background,
    "async function handleStartSearch",
    "async function sendMapsMessageToTab"
  );
  const authAt = start.indexOf("await checkAuthAndPoints(params.webUrl, params.authToken)");
  const deleteAt = start.indexOf("delete params.authToken", authAt);
  const stateAt = start.indexOf("scrapeState.searchParams = params", deleteAt);

  assert.ok(authAt >= 0, "START_SEARCH phải auth bằng token được truyền vào");
  assert.ok(deleteAt > authAt, "token chỉ được xóa sau khi auth xong");
  assert.ok(stateAt > deleteAt, "không được đưa token vào scrapeState");
});

test("URL rescan ngoài Google bị loại và URL hợp lệ được chuẩn hóa", () => {
  const background = read("extension", "background.js");
  const source = section(background, "function buildRescanHref", "async function recoverDurableWork");
  const vm = require("node:vm");
  const context = vm.createContext({ URL, encodeURIComponent, isNaN });
  vm.runInContext(`${source}\nthis.buildRescanHref = buildRescanHref;`, context);

  assert.equal(
    context.buildRescanHref({
      name: "Quán Trà",
      href: "https://evil.example/maps/place/stolen#fragment"
    }),
    "https://www.google.com/maps/search/Qu%C3%A1n%20Tr%C3%A0"
  );
  assert.equal(
    context.buildRescanHref({ href: "/maps/place/Quan+Tra#reviews" }),
    "https://www.google.com/maps/place/Quan+Tra"
  );
  assert.equal(
    context.buildRescanHref({ href: "https://www.google.com/maps/search/?api=1&query_place_id=ChIJ123#x" }),
    "https://www.google.com/maps/search/?api=1&query_place_id=ChIJ123"
  );
});

test("checkpoint tạm dừng chỉ cho resume thủ công, watchdog không tự chạy lại", () => {
  const lifecycle = require("../../extension/lifecycle.js");
  const base = {
    running: true,
    savedAt: Date.now(),
    searchParams: { searchId: "search-paused" },
    totalCells: 3,
    gridIndex: 1,
    gridPoints: [{}, {}, {}]
  };

  assert.equal(lifecycle.isRecoverableScrapeCheckpoint({ ...base, paused: true }), true);
  assert.equal(lifecycle.shouldAutoResumeScrapeCheckpoint({ ...base, paused: true }), false);
  assert.equal(lifecycle.shouldAutoResumeScrapeCheckpoint({ ...base, paused: false }), true);
});

test("durable recovery bỏ qua checkpoint đang tạm dừng", () => {
  const background = read("extension", "background.js");
  const recovery = section(background, "async function recoverDurableWork", "function ensureServiceReady");

  assert.match(recovery, /shouldAutoResumeScrapeCheckpoint\(scrapeCheckpoint\)/);
  assert.doesNotMatch(
    recovery,
    /isRecoverableScrapeCheckpoint\(scrapeCheckpoint\)[\s\S]{0,160}tryResumeFromCheckpoint\(\)/
  );
});
