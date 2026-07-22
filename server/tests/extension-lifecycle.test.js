const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const Lifecycle = require("../../extension/lifecycle");

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
  assert.equal(Lifecycle.isRecoverableRescanCheckpoint({ ...checkpoint, placeIndex: 2 }, now), false);
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
  assert.match(background, /delete durableParams\.places/);
  assert.match(background, /delete durableParams\.authToken/);
  assert.match(background, /delete durable\.authToken/);
});
