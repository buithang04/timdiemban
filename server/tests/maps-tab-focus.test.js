const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const background = fs.readFileSync(
  path.join(rootDir, "extension", "background.js"),
  "utf8"
);

function section(start, end) {
  const from = background.indexOf(start);
  const to = background.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Không tìm thấy mốc bắt đầu: ${start}`);
  assert.notEqual(to, -1, `Không tìm thấy mốc kết thúc: ${end}`);
  return background.slice(from, to);
}

function loadMapsTabHelpers(chrome) {
  const source = section("function isValidWindowId", "async function openMapsScrapeTab");
  const context = vm.createContext({ chrome });
  vm.runInContext(
    `${source}\nthis.createFocusedMapsTab = createFocusedMapsTab;`,
    context
  );
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("helper tạo Maps active và focus đúng cửa sổ Findmap", async () => {
  const calls = [];
  const chrome = {
    tabs: {
      create: async (options) => {
        calls.push(["create", options]);
        return { id: 91, windowId: 17 };
      },
      update: async (tabId, options) => {
        calls.push(["update", tabId, options]);
        return { id: tabId, windowId: 17, active: true };
      }
    },
    windows: {
      update: async (windowId, options) => {
        calls.push(["window", windowId, options]);
        return { id: windowId, focused: true };
      }
    }
  };

  const { createFocusedMapsTab } = loadMapsTabHelpers(chrome);
  const tab = await createFocusedMapsTab("https://www.google.com/maps/", 17);

  assert.equal(tab.id, 91);
  assert.deepEqual(plain(calls), [
    ["create", { url: "https://www.google.com/maps/", active: true, windowId: 17 }],
    ["update", 91, { active: true, autoDiscardable: false }],
    ["window", 17, { focused: true }]
  ]);
});

test("cửa sổ Findmap không còn thì tạo Maps ở cửa sổ hiện tại", async () => {
  const creates = [];
  const chrome = {
    tabs: {
      create: async (options) => {
        creates.push(options);
        if (creates.length === 1) throw new Error("No window with id: 17");
        return { id: 92, windowId: 18 };
      },
      update: async (tabId) => ({ id: tabId, windowId: 18, active: true })
    },
    windows: { update: async () => ({ id: 18, focused: true }) }
  };

  const { createFocusedMapsTab } = loadMapsTabHelpers(chrome);
  const tab = await createFocusedMapsTab("https://www.google.com/maps/", 17);

  assert.equal(tab.id, 92);
  assert.deepEqual(plain(creates), [
    { url: "https://www.google.com/maps/", active: true, windowId: 17 },
    { url: "https://www.google.com/maps/", active: true }
  ]);
});

test("tìm kiếm luôn mở Maps foreground trong cửa sổ Findmap", () => {
  const create = section(
    "async function createFocusedMapsTab",
    "async function openMapsScrapeTab"
  );
  const open = section(
    "async function openMapsScrapeTab",
    "async function scrapeKeepAliveTick"
  );
  const rescanOpen = section(
    "async function openRescanMapsTab",
    "async function handleRescanMapsTabLost"
  );

  assert.match(create, /chrome\.tabs\.create\(createOptions\)/);
  assert.match(create, /active:\s*true/);
  assert.match(create, /activateTabAndWindow\(tab\.id\)/);
  assert.match(open, /getTabWindowId\(scrapeState\.webTabId\)/);
  assert.match(open, /createFocusedMapsTab\(url, preferredWindowId\)/);
  assert.doesNotMatch(open, /isMapsAutoFocusEnabled/);
  assert.match(rescanOpen, /findWebTab\(rescanState\.webUrl\)/);
  assert.match(rescanOpen, /createFocusedMapsTab/);
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
