const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const background = read("extension", "background.js");
const content = read("extension", "content.js");
const manifest = JSON.parse(read("extension", "manifest.json"));

function section(start, end) {
  const from = background.indexOf(start);
  const to = background.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Không tìm thấy mốc bắt đầu: ${start}`);
  assert.notEqual(to, -1, `Không tìm thấy mốc kết thúc: ${end}`);
  return background.slice(from, to);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBoostHelpers({ attachError } = {}) {
  const state = {
    attachCalls: [],
    commands: [],
    detachCalls: [],
    progress: [],
    onEvent: null,
    onDetach: null
  };
  const chrome = {
    debugger: {
      attach: async (target, version) => {
        state.attachCalls.push([target, version]);
        if (attachError) throw new Error(attachError);
      },
      detach: async (target) => {
        state.detachCalls.push(target);
      },
      sendCommand: async (target, method, params) => {
        state.commands.push([target.tabId, method, params]);
      },
      onEvent: {
        addListener: (fn) => {
          state.onEvent = fn;
        }
      },
      onDetach: {
        addListener: (fn) => {
          state.onDetach = fn;
        }
      }
    }
  };
  const context = vm.createContext({
    chrome,
    console,
    scrapeState: { running: true, gridIndex: 0, totalCells: 10 },
    rescanState: { running: false },
    notifyProgress: (pct, text) => state.progress.push(text),
    calcProgressPercent: () => 0
  });
  const source = section("const mapsBoost", "function isValidWindowId");
  vm.runInContext(
    `${source}
this.mapsBoost = mapsBoost;
this.enableMapsBoost = enableMapsBoost;
this.ensureMapsBoost = ensureMapsBoost;
this.disableMapsBoost = disableMapsBoost;
this.maybeReleaseMapsBoost = maybeReleaseMapsBoost;`,
    context
  );
  return { context, state };
}

test("manifest khai báo quyền debugger cho chế độ quét nền", () => {
  assert.ok(
    manifest.permissions.includes("debugger"),
    "thiếu quyền debugger — chế độ quét nền không hoạt động"
  );
});

test("bật chế độ quét nền: gắn debugger, giả lập focus và ép render khung hình", async () => {
  const { context, state } = loadBoostHelpers();

  const ok = await context.enableMapsBoost(7);

  assert.equal(ok, true);
  assert.deepEqual(plain(state.attachCalls), [[{ tabId: 7 }, "1.3"]]);
  const methods = state.commands.map(([, method]) => method);
  assert.ok(methods.includes("Emulation.setFocusEmulationEnabled"));
  assert.ok(methods.includes("Page.startScreencast"));
  assert.ok(methods.includes("Page.setWebLifecycleState"));

  const gesture = state.commands.find(([, m]) => m === "Runtime.evaluate");
  assert.ok(gesture, "phải phát user gesture để mở khóa AudioContext");
  assert.equal(gesture[2].userGesture, true);
  assert.match(gesture[2].expression, /timdiemban-audio-unlock/);
});

test("mỗi khung hình screencast đều được xác nhận để giữ nhịp render", async () => {
  const { context, state } = loadBoostHelpers();
  await context.enableMapsBoost(7);
  state.commands.length = 0;

  state.onEvent({ tabId: 7 }, "Page.screencastFrame", { sessionId: "s1" });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(plain(state.commands), [
    [7, "Page.screencastFrameAck", { sessionId: "s1" }]
  ]);
});

test("người dùng hủy gỡ lỗi: không gắn lại trong lượt quét và có thông báo hướng dẫn", async () => {
  const { context, state } = loadBoostHelpers();
  await context.enableMapsBoost(7);

  state.onDetach({ tabId: 7 }, "canceled_by_user");

  assert.equal(context.mapsBoost.attached, false);
  assert.equal(context.mapsBoost.unavailable, true);
  assert.equal(await context.enableMapsBoost(7), false);
  assert.equal(state.attachCalls.length, 1, "không được thử gắn lại sau khi người dùng hủy");
  assert.ok(state.progress.some((text) => /quét nền đã tắt/i.test(text)));
});

test("gắn debugger thất bại: trả false và không thử lại dồn dập", async () => {
  const { context, state } = loadBoostHelpers({ attachError: "Another debugger is attached" });

  assert.equal(await context.enableMapsBoost(7), false);
  assert.equal(await context.enableMapsBoost(7), false);
  assert.equal(state.attachCalls.length, 1, "phải có thời gian chờ giữa hai lần thử gắn");
});

test("tab Maps mở ở nền, ưu tiên chế độ quét nền và chỉ focus khi không gắn được", () => {
  const open = section("async function openMapsScrapeTab", "async function scrapeKeepAliveTick");
  const rescanOpen = section(
    "async function openRescanMapsTab",
    "async function handleRescanMapsTabLost"
  );

  assert.match(open, /createMapsTab\(url, preferredWindowId, \{ active: false \}\)/);
  assert.match(open, /enableMapsBoost\(tab\.id\)/);
  assert.match(open, /if \(!boosted\) await activateTabAndWindow\(tab\.id\)/);
  assert.doesNotMatch(open, /isMapsAutoFocusEnabled/);

  assert.match(rescanOpen, /createMapsTab\(/);
  assert.match(rescanOpen, /active: false/);
  assert.match(rescanOpen, /enableMapsBoost\(tab\.id\)/);
  assert.match(rescanOpen, /if \(!boosted\) await activateTabAndWindow\(tab\.id\)/);
});

test("dừng quét gỡ debugger ngay và dọn dẹp kể cả khi sync cuối lỗi", () => {
  const finalize = section("async function finalizeFromCheckpoint", "async function abortSearch");
  const abort = section("async function abortSearch", "async function cancelActiveSearch");
  const abandon = section("async function abandonActiveSearch", "async function ensureReadyForNewSearch");
  const complete = section(
    "async function handleScrapeComplete",
    "chrome.runtime.onMessage.addListener"
  );

  assert.match(finalize, /disableMapsBoost\(\)/);
  assert.match(abort, /disableMapsBoost\(\)/);
  assert.match(abandon, /disableMapsBoost\(\)/);
  assert.match(complete, /disableMapsBoost\(\)/);

  // Dọn dẹp phải nằm trong finally — lỗi giữa chừng không được làm kẹt debugger/tab
  assert.match(abort, /\} finally \{\s*isAborting = false;/);
  assert.match(complete, /\} finally \{[\s\S]*closeMapsTabSafely\(\);[\s\S]*resetScrapeState\(\);/);
});

test("không gắn lại debugger sau khi đã dừng quét (tick đang bay bị chặn)", async () => {
  const { context, state } = loadBoostHelpers();
  context.scrapeState.running = false;
  context.rescanState.running = false;

  assert.equal(await context.ensureMapsBoost(7), false);
  assert.equal(state.attachCalls.length, 0, "ensureMapsBoost không được attach khi đã dừng");
});

test("chế độ quét nền được duy trì suốt phiên và nhả khi kết thúc", () => {
  const keepalive = section("async function scrapeKeepAliveTick", "async function focusMapsTabForSearch");
  const navigate = section("async function navigateMapsTab", "async function handleMapsTabReloaded");
  const ready = section("async function ensureMapsContentReady", "async function sendMapsMessage");
  const rescanEnrich = section(
    "async function enrichRescanPlace",
    "async function runRescanPlacesLoop"
  );
  const resetScrape = section("function resetScrapeState", "function isMapsAutoReopenEnabled");
  const resetRescan = section("function resetRescanState", "async function abortRescan");

  assert.match(keepalive, /ensureMapsBoost\(scrapeState\.mapsTabId\)/);
  assert.match(keepalive, /!tab\.active && !boosted/);
  assert.match(navigate, /ensureMapsBoost\(scrapeState\.mapsTabId\)/);
  assert.match(ready, /ensureMapsBoost\(tabId\)/);
  assert.match(rescanEnrich, /ensureMapsBoost\(rescanState\.mapsTabId\)/);
  assert.match(resetScrape, /maybeReleaseMapsBoost\(\)/);
  assert.match(resetRescan, /maybeReleaseMapsBoost\(\)/);
});

test("tạo tab Maps ở nền đúng cửa sổ Findmap, có dự phòng khi cửa sổ đã đóng", async () => {
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

test("đổi vùng và enrich chỉ đổi URL, không đẩy Maps về nền", () => {
  const searchFlow = section("async function runGridCell", "function groupPlacesByEnrichCell");
  const enrichFlow = section("async function enrichPlaceByUrl", "async function handleCellListComplete");
  const rescanFlow = section("async function enrichRescanPlace", "async function runRescanPlacesLoop");

  assert.match(searchFlow, /navigateMapsTab\(\{ url \}\)/);
  assert.match(enrichFlow, /navigateMapsTab\(\{ url: href \}\)/);
  assert.match(enrichFlow, /navigateMapsTab\(\{ url: searchUrl \}\)/);
  assert.match(rescanFlow, /chrome\.tabs\.update\(rescanState\.mapsTabId, \{ url: href \}\)/);
  assert.doesNotMatch(`${searchFlow}\n${enrichFlow}\n${rescanFlow}`, /active:\s*false/);
});

test("auto-focus định kỳ vẫn là tùy chọn riêng và bật giữa phiên sẽ focus ngay", () => {
  const periodicFocus = section(
    "async function focusMapsTabForSearch",
    "function isMapsAutoFocusEnabled"
  );
  const settingHandler = section(
    'if (message.action === "SET_MAPS_AUTO_FOCUS")',
    'if (message.action === "SET_MAPS_AUTO_REOPEN")'
  );

  assert.match(periodicFocus, /if \(!isMapsAutoFocusEnabled\(\)\) return/);
  assert.match(periodicFocus, /activateTabAndWindow\(scrapeState\.mapsTabId\)/);
  assert.match(settingHandler, /if \(enabled\) focusMapsTabForSearch\(\)/);
});

test("content script nhận mở khóa âm thanh và tận dụng rAF khi tab ẩn", () => {
  assert.match(content, /timdiemban-audio-unlock/);
  assert.match(content, /requestAnimationFrame\(advance\)/);
  assert.match(content, /Bạn có thể chuyển sang tab khác để làm việc/);
  assert.doesNotMatch(content, /nếu tiến độ chậm, hãy đưa tab này lên trước/);
});
