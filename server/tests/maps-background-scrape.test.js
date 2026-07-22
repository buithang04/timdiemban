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

test("manifest không yêu cầu quyền debugger", () => {
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal((manifest.optional_permissions || []).includes("debugger"), false);
});

test("extension không còn gọi debugger hoặc cơ chế screencast", () => {
  assert.doesNotMatch(background, /chrome\.debugger|Page\.startScreencast|Emulation\.setFocus/);
  assert.doesNotMatch(content, /AudioContext|timdiemban-audio-unlock|antiThrottle|requestAnimationFrame/);
});

test("tab Maps luôn mở foreground và được focus lại khi cần", () => {
  const open = section("async function openMapsScrapeTab", "async function scrapeKeepAliveTick");
  const rescanOpen = section(
    "async function openRescanMapsTab",
    "async function handleRescanMapsTabLost"
  );

  assert.match(open, /createMapsTab\(url, preferredWindowId, \{ active: true \}\)/);
  assert.match(open, /await activateTabAndWindow\(tab\.id\)/);

  assert.match(rescanOpen, /createMapsTab\(/);
  assert.match(rescanOpen, /active: true/);
  assert.match(rescanOpen, /await activateTabAndWindow\(tab\.id\)/);

  const keepalive = section("async function scrapeKeepAliveTick", "async function focusMapsTabForSearch");
  assert.match(keepalive, /mapsWindow\?\.focused === true/);
  assert.match(keepalive, /mapsWindow\?\.state !== "minimized"/);
  assert.match(keepalive, /if \(!mapsForeground\)/);
  assert.match(keepalive, /isMapsAutoFocusEnabled\(\)/);
  assert.match(keepalive, /activateTabAndWindow\(scrapeState\.mapsTabId\)/);
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

test("watchdog, checkpoint và điều hướng giữ Maps foreground", () => {
  const keepalive = section("async function scrapeKeepAliveTick", "async function focusMapsTabForSearch");
  const navigate = section("async function navigateMapsTab", "async function handleMapsTabReloaded");
  const rescanEnrich = section(
    "async function enrichRescanPlace",
    "async function runRescanPlacesLoop"
  );

  assert.match(keepalive, /persistScrapeCheckpoint\(\)/);
  assert.match(navigate, /activateTabAndWindow\(scrapeState\.mapsTabId\)/);
  assert.match(rescanEnrich, /activateTabAndWindow\(rescanState\.mapsTabId\)/);
  assert.match(background, /WATCHDOG_ALARM/);
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

test("auto-focus bật mặc định và có thể đổi giữa phiên", () => {
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
  assert.match(webSearch, /saved == null \? true : saved === "1"/);
});

test("content script hướng dẫn giữ Maps foreground, không quảng cáo quét nền", () => {
  assert.match(content, /giữ tab Google Maps này ở phía trước/i);
  assert.doesNotMatch(content, /Bạn có thể chuyển sang tab khác để làm việc/);
  assert.doesNotMatch(content, /AudioContext|timdiemban-audio-unlock|requestAnimationFrame\(advance\)/);
});
