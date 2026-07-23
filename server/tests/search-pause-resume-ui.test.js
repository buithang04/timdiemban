const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");

test("web có điều khiển tạm dừng, tiếp tục và bridge chuyển đúng action", () => {
  const html = read("web", "index.html");
  const search = read("web", "search.js");
  const bridge = read("extension", "web-bridge.js");

  assert.match(html, /id="pauseSearchBtn"/);
  assert.match(html, /id="resumeSearchBtn"/);
  assert.match(html, />Tạm dừng quét</);
  assert.match(html, />Tiếp tục quét</);
  assert.match(search, /postToExt\("PAUSE_SEARCH"/);
  assert.match(search, /postToExt\("RESUME_SEARCH"/);
  assert.match(bridge, /reply\("PAUSE_SEARCH", "pause_ack"/);
  assert.match(bridge, /reply\("RESUME_SEARCH", "resume_ack"/);
});

test("web coi paused là tiến trình còn sống và không dùng timeout tuyệt đối 45 phút", () => {
  const search = read("web", "search.js");
  const app = read("web", "app.js");

  assert.match(search, /status\?\.paused/);
  assert.match(search, /lastConfirmedAliveAt/);
  assert.match(search, /requestSearchStatusAsync/);
  assert.doesNotMatch(search, /45 \* 60 \* 1000/);
  assert.match(app, /extStatus\.paused/);
  assert.match(app, /function emitSearchFinished/);
  assert.match(app, /partialCode:/);
});

test("background lưu pause bền, resume đúng checkpoint và tab-loss không finalize partial", () => {
  const background = read("extension", "background.js");

  assert.match(background, /async function pauseActiveSearch/);
  assert.match(background, /paused:\s*scrapeState\.paused === true/);
  assert.match(background, /forceRecoverable:\s*true/);
  assert.match(background, /handleResumeSearch\(\)[\s\S]*allowPaused:\s*true/);
  assert.match(background, /message\.action === "PAUSE_SEARCH"/);
  assert.match(background, /canPause:/);
  assert.match(background, /pauseReason:/);

  const listLossStart = background.indexOf("async function handleSearchMapsTabLost");
  const listLossEnd = background.indexOf("async function handleQuickEnrichTabLost", listLossStart);
  const listLoss = background.slice(listLossStart, listLossEnd);
  assert.match(listLoss, /pauseActiveSearch/);
  assert.doesNotMatch(listLoss, /MAPS_REOPEN_LIMIT|MAPS_REOPEN_FAILED|TAB_MAPS_CLOSED/);

  const quickLossStart = listLossEnd;
  const quickLossEnd = background.indexOf("async function persistRescanCheckpoint", quickLossStart);
  const quickLoss = background.slice(quickLossStart, quickLossEnd);
  assert.match(quickLoss, /pauseActiveSearch/);
  assert.doesNotMatch(
    quickLoss,
    /TAB_ENRICH_MAPS_CLOSED|ENRICH_MAPS_REOPEN_LIMIT|ENRICH_MAPS_REOPEN_FAILED/
  );
});

test("sidebar dùng CTA tải extension và thao tác xóa dữ liệu vẫn còn ở toolbar", () => {
  const html = read("web", "index.html");
  const app = read("web", "app.js");
  const presence = read("web", "ext-presence.js");

  assert.match(html, /id="sidebarExtensionDownload"/);
  assert.match(html, /id="headerExtensionDownload"/);
  assert.match(html, /Tải extension/);
  assert.doesNotMatch(html, /id="sidebarExtensionDownload"[\s\S]{0,180}href="#"/);
  assert.doesNotMatch(html, /id="sidebarNewSearchBtn"/);
  assert.match(html, /id="resetBtn"/);
  assert.match(app, /resetBtn/);
  assert.match(presence, /sidebarExtensionDownload/);
  assert.match(presence, /headerExtensionDownload/);
  assert.match(presence, /EXTENSION_INSTALL_URL/);
});

test("Chrome Web Store có URL chính sách quyền riêng tư công khai", () => {
  const server = read("server", "server.js");
  const page = read("web", "privacy-policy.html");
  const policy = read("docs", "chrome-web-store", "privacy-policy.md");

  assert.match(server, /"\/chinh-sach-quyen-rieng-tu": "privacy-policy\.html"/);
  assert.match(server, /"\/privacy-policy": "privacy-policy\.html"/);
  assert.match(page, /Chính sách quyền riêng tư/);
  assert.match(page, /business@chatplus\.vn/);
  assert.match(policy, /https:\/\/findmap\.vn\/chinh-sach-quyen-rieng-tu/);
  assert.doesNotMatch(policy, /CẦN ĐIỀN|placeholder/i);
});

test("giao diện người dùng không còn nhận hoặc hiển thị log debug của tiến trình", () => {
  const html = read("web", "index.html");
  const search = read("web", "search.js");
  const bridge = read("extension", "web-bridge.js");
  const content = read("extension", "content.js");

  assert.doesNotMatch(html, /id="scrapeLog"|class="[^"]*scrape-log/);
  assert.doesNotMatch(search, /appendScrapeLog|event\.data\.type === "log"/);
  assert.doesNotMatch(bridge, /SEARCH_LOG|toPage\("log"/);
  assert.doesNotMatch(content, /action:\s*"SCRAPE_LOG"/);
});

test("batch nhiều từ khóa lưu checkpoint web để tiếp tục sau reload", () => {
  const search = read("web", "search.js");

  assert.match(search, /SEARCH_BATCH_RECOVERY_KEY/);
  assert.match(search, /function writeBatchRecovery/);
  assert.match(search, /delete baseParams\.authToken/);
  assert.match(search, /accountScope:/);
  assert.match(search, /activeSearchId:\s*searchParams\.searchId/);
  assert.match(search, /phase:\s*"starting"/);
  assert.match(search, /phase:\s*"running"/);
  assert.match(search, /continueRecoveredBatchAfterTerminal/);
  assert.match(search, /launchRecoveredBatch/);
  assert.match(search, /timdiemban:workspace-ready/);
  assert.doesNotMatch(search, /setTimeout\(\(\) => \{\s*handleSubmit[\s\S]{0,180}, 700\)/);
});

test("batch recovery retry đúng index khi reload ở starting và extension đang idle", () => {
  const source = read("web", "search.js");
  const from = source.indexOf("function reconcileBatchRecovery");
  const to = source.indexOf("function resetSearchRecovery", from);
  assert.notEqual(from, -1);
  assert.notEqual(to, -1);

  const launches = [];
  let state = {
    phase: "starting",
    activeSearchId: "search_batch_2",
    nextIndex: 2,
    keywords: ["a", "b", "c"],
    baseParams: {}
  };
  const context = vm.createContext({
    workspaceReady: true,
    readBatchRecovery: () => state,
    writeBatchRecovery: (next) => {
      state = next;
    },
    launchRecoveredBatch: (next) => launches.push(next.nextIndex)
  });
  vm.runInContext(`${source.slice(from, to)}\nthis.reconcileBatchRecovery = reconcileBatchRecovery;`, context);

  context.reconcileBatchRecovery({ running: false, stalled: false, paused: false, canResume: false });
  assert.deepEqual(launches, [2]);

  launches.length = 0;
  context.reconcileBatchRecovery({
    running: true,
    searchId: "search_batch_2"
  });
  assert.deepEqual(launches, []);
  assert.equal(state.phase, "running");
});

test("complete phục hồi chỉ tăng batch một lần và bỏ qua event trùng", () => {
  const source = read("web", "search.js");
  const from = source.indexOf("function continueRecoveredBatchAfterTerminal");
  const to = source.indexOf("function reconcileBatchRecovery", from);
  assert.notEqual(from, -1);
  assert.notEqual(to, -1);

  let state = {
    activeSearchId: "search_batch_0",
    currentIndex: 0,
    nextIndex: 0,
    keywords: ["a", "b"],
    baseParams: {},
    phase: "running"
  };
  const launches = [];
  const context = vm.createContext({
    readBatchRecovery: () => state,
    writeBatchRecovery: (next) => {
      state = next;
    },
    clearBatchRecovery: () => {
      state = null;
    },
    isUserCancelEnd: () => false,
    updateSearchProgress: () => {},
    showSearchStatus: () => {},
    launchRecoveredBatch: (next) => launches.push(next.nextIndex),
    Math,
    Number
  });
  vm.runInContext(
    `${source.slice(from, to)}\nthis.continueRecoveredBatchAfterTerminal = continueRecoveredBatchAfterTerminal;`,
    context
  );

  const payload = { type: "complete", searchId: "search_batch_0" };
  assert.equal(context.continueRecoveredBatchAfterTerminal(payload), true);
  assert.equal(state.nextIndex, 1);
  assert.equal(state.activeSearchId, "");
  assert.deepEqual(launches, [1]);
  assert.equal(context.continueRecoveredBatchAfterTerminal(payload), false);
  assert.deepEqual(launches, [1]);
});

test("pause/resume ACK áp toàn bộ search status và reset xóa checkpoint batch", () => {
  const search = read("web", "search.js");
  const app = read("web", "app.js");

  assert.match(search, /result\.status\) applySearchStatus\(result\.status\)/);
  assert.match(search, /requestResumeSearch\(\)[\s\S]*applySearchStatus\(status\)/);
  assert.match(search, /function resetSearchRecovery/);
  assert.match(search, /activeSearchEndWaiter\?\.cancel/);
  assert.match(app, /resetSearchRecovery\?\.\(\{ abandon: true \}\)/);
  assert.match(app, /extStatus\.canResume/);
});

test("workspace vẫn lưu metadata active khi chưa có dòng kết quả", () => {
  const app = read("web", "app.js");

  assert.match(app, /parsed\.data\.length \|\| parsed\.search/);
  assert.match(app, /if \(!data\.length && !payload\?\.search\) return false/);
  assert.match(app, /if \(!currentData\.length && !currentSearch\)/);
  assert.match(app, /timdiemban:workspace-ready/);
});

test("nút bắt đầu bị vô hiệu hóa thật khi form đang bận", () => {
  const search = read("web", "search.js");
  assert.match(search, /els\.startBtn\.disabled = locked/);
  assert.doesNotMatch(search, /els\.startBtn\.disabled = false/);
});
