const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..", "..");
const content = fs.readFileSync(path.join(rootDir, "extension", "content.js"), "utf8");

function section(start, end) {
  const from = content.indexOf(start);
  const to = content.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Missing content marker: ${start}`);
  assert.notEqual(to, -1, `Missing content marker: ${end}`);
  return content.slice(from, to);
}

function makeFeed(urls) {
  const links = urls.map((href) => ({ href, getAttribute: () => href }));
  return {
    items: links,
    querySelectorAll: () => links
  };
}

test("feed fingerprint includes every canonical URL and ignores DOM order", () => {
  const source = section("function hashFeedUrls", "/** Chờ Maps tải đúng vùng");
  const context = vm.createContext({
    URL,
    window: { location: { origin: "https://www.google.com" } },
    getFeedPanel: () => null,
    getResultItems: (feed) => feed.items
  });
  vm.runInContext(`${source}\nthis.getFeedSignature = getFeedSignature;`, context);

  const urls = Array.from(
    { length: 20 },
    (_, index) => `https://www.google.com/maps/place/store-${index}/data=!3d10!4d106?entry=ttu`
  );
  const original = context.getFeedSignature(makeFeed(urls));
  const reordered = context.getFeedSignature(makeFeed([...urls].reverse()));
  const changedAfterOldCutoff = [...urls];
  changedAfterOldCutoff[18] =
    "https://www.google.com/maps/place/replaced-store/data=!3d10!4d106?entry=ttu";

  assert.equal(reordered, original);
  assert.notEqual(context.getFeedSignature(makeFeed(changedAfterOldCutoff)), original);
  assert.match(original, /^20:20:[0-9a-f]{16}$/);
});

test("cell readiness distinguishes same-cell retry from cell transition and reload", async () => {
  const source = section("async function waitForCellFeedReady", "let _lastKnownTotalCells");
  let now = 0;
  const feed = { isConnected: true, scrollTop: 0 };
  const context = vm.createContext({
    CELL_FEED_WAIT_MS: 24000,
    CONTENT_INSTANCE_ID: "document-new",
    Date: { now: () => now },
    T: { scrollInit: 0 },
    _lastKnownTotalCells: 1,
    isAborted: false,
    window: { location: { href: "https://www.google.com/maps/@10,106,15z" } },
    sleep: async (ms) => {
      now += ms;
    },
    urlCenterMatchesCell: () => true,
    getFeedPanel: () => feed,
    getResultItems: () => [{}],
    getFeedSignature: () => "1:1:abc12345",
    isFeedLoading: () => false,
    waitForFeedContentReady: async () => true,
    sendProgress: () => {},
    calcProgressPercent: () => 0,
    tbLog: () => {}
  });
  vm.runInContext(`${source}\nthis.waitForCellFeedReady = waitForCellFeedReady;`, context);

  now = 0;
  const retryFeed = await context.waitForCellFeedReady(
    "",
    10,
    106,
    2,
    1000,
    3,
    "1:1:abc12345",
    false,
    "document-new"
  );
  assert.equal(retryFeed, feed);

  now = 0;
  await assert.rejects(
    context.waitForCellFeedReady(
      "",
      10,
      106,
      2,
      1000,
      3,
      "1:1:abc12345",
      true,
      "document-new"
    ),
    /Không tìm thấy danh sách/
  );

  now = 0;
  const reloadedFeed = await context.waitForCellFeedReady(
    "",
    10,
    106,
    2,
    1000,
    3,
    "1:1:abc12345",
    true,
    "document-old"
  );
  assert.equal(reloadedFeed, feed);
});

test("canonical enrichment fails closed across ID kinds", () => {
  const strictNameSource = section("function strictNameMatch", "function isSponsoredPlace");
  const canonicalSource = section("function getRecordCanonicalPlaceId", "function cancelActiveEnrich");
  const canonicalFromUrl = (value) => {
    const url = String(value || "");
    const chij = url.match(/ChIJ[A-Za-z0-9_-]+/);
    if (chij) return chij[0];
    const slug = url.match(/\/maps\/place\/([^/@?]+)/);
    return slug ? `slug:${slug[1].toLowerCase()}@10.0000,106.0000` : "";
  };
  const slugFromUrl = (value) => {
    const match = String(value || "").match(/\/maps\/place\/([^/@?]+)/);
    return match ? match[1].toLowerCase().replace(/\+/g, " ") : "";
  };
  const context = vm.createContext({
    window: { location: { href: "" } },
    getCanonicalPlaceId: canonicalFromUrl,
    getPlaceSlug: slugFromUrl,
    normalizeName: (value) => String(value || "").toLowerCase().trim(),
    cleanPlaceName: (value) => String(value || "").trim()
  });
  vm.runInContext(
    `${strictNameSource}\n${canonicalSource}\nthis.enrichCanonicalMatches = enrichCanonicalMatches;`,
    context
  );

  const expected = {
    name: "Expected Coffee House",
    googlePlaceId: "ChIJ_EXPECTED",
    href: "https://www.google.com/maps/place/expected-coffee/data=!1sChIJ_EXPECTED"
  };

  context.window.location.href =
    "https://www.google.com/maps/place/other-coffee/@10,106,17z";
  assert.equal(
    context.enrichCanonicalMatches(expected, {
      name: "Expected Coffee House",
      googlePlaceId: "ChIJ_EXPECTED",
      mapsUrl: context.window.location.href
    }),
    false,
    "an inherited ChIJ must not hide a different actual slug"
  );

  context.window.location.href = "https://www.google.com/maps/place/other-coffee";
  assert.equal(
    context.enrichCanonicalMatches(expected, {
      name: "Expected Coffee House",
      googlePlaceId: "ChIJ_EXPECTED",
      mapsUrl: context.window.location.href
    }),
    false,
    "a bare wrong slug must not be bypassed by an inherited ChIJ"
  );

  context.window.location.href =
    "https://www.google.com/maps/place/expected-coffee/@10,106,17z";
  assert.equal(
    context.enrichCanonicalMatches(expected, {
      name: "Expected Coffee House",
      mapsUrl: context.window.location.href
    }),
    true
  );
  assert.equal(
    context.enrichCanonicalMatches(expected, {
      name: "Different Business Name",
      mapsUrl: context.window.location.href
    }),
    false
  );

  context.window.location.href =
    "https://www.google.com/maps/place/expected-coffee/data=!1sChIJ_OTHER";
  assert.equal(
    context.enrichCanonicalMatches(expected, {
      name: "Expected Coffee House",
      mapsUrl: context.window.location.href
    }),
    false
  );
});

test("feed-content wait honors the caller's absolute deadline", async () => {
  const source = section("async function waitForFeedContentReady", "/** Cuộn tới đáy");
  let now = 0;
  const feed = { isConnected: true, scrollHeight: 100 };
  const context = vm.createContext({
    Date: { now: () => now },
    isAborted: false,
    getFeedPanel: () => feed,
    getResultItems: () => [{}],
    isFeedLoading: () => true,
    sleep: async (ms) => {
      now += ms;
    }
  });
  vm.runInContext(`${source}\nthis.waitForFeedContentReady = waitForFeedContentReady;`, context);

  const ready = await context.waitForFeedContentReady(feed, 6000, 1000);
  assert.equal(ready, false);
  assert.equal(now, 1000);
  assert.match(content, /const CELL_FEED_WAIT_MS = 24000;/);
  assert.match(content, /const CELL_SCROLL_CHUNK_MS = 210000;/);
  assert.match(
    content,
    /sendResponse\(\{ success: true, signature: getFeedSignature\(\), instanceId: CONTENT_INSTANCE_ID \}\)/
  );
});

test("hidden-tab feed scrolling is immediate and still nudges the loaded bottom", async () => {
  const source = section(
    "function updateEndMarkerConfirmation",
    "async function enrichAllWithDetails"
  );
  let now = 0;
  let scrollTop = 0;
  let loading = false;
  let loadingTriggered = false;
  const scrollCalls = [];
  const scrollAssignments = [];
  const feed = {
    isConnected: true,
    clientHeight: 500,
    scrollHeight: 1500,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      const before = scrollTop;
      const requested = Math.max(0, Number(value) || 0);
      const maxBefore = Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTop = Math.min(requested, maxBefore);
      if (before >= maxBefore - 40 && requested > before && !loadingTriggered) {
        loading = true;
        loadingTriggered = true;
      }
      scrollAssignments.push({ before, requested, after: scrollTop, maxBefore });
    },
    scrollBy(options) {
      const before = scrollTop;
      const maxBefore = Math.max(0, this.scrollHeight - this.clientHeight);
      const top = Number(options?.top) || 0;

      // A smooth scroll does not synchronously move a throttled hidden tab.
      if (options?.behavior !== "smooth") {
        this.scrollTop = before + top;
      }
      scrollCalls.push({
        behavior: options?.behavior,
        top,
        before,
        after: scrollTop,
        maxBefore
      });
    }
  };
  const context = vm.createContext({
    CELL_SCROLL_CHUNK_MS: 220000,
    T: { scroll: 150, scrollInit: 100 },
    Date: { now: () => now },
    document: { hidden: true },
    isAborted: false,
    getFeedPanel: () => feed,
    waitForFeed: async () => feed,
    waitForFeedContentReady: async () => {
      if (loading) {
        loading = false;
        feed.scrollHeight += 500;
      }
      return true;
    },
    isFeedLoading: () => loading,
    hasEndMarker: () => loadingTriggered && !loading,
    feedScrollStep: (panel, ratio, minPx) =>
      Math.max(panel.clientHeight * ratio, minPx),
    sleep: async (ms) => {
      now += ms;
    },
    tbLog: () => {}
  });
  vm.runInContext(`${source}\nthis.scrollFeed = scrollFeed;`, context);

  const outcome = await context.scrollFeed(
    feed,
    async () => ({ total: feed.scrollHeight > 1500 ? 5 : 3 }),
    { safetyMax: 20, maxMs: 20000 }
  );

  assert.equal(context.document.hidden, true);
  assert.equal(outcome.reachedEnd, true);
  assert.equal(outcome.reason, "end_marker");
  assert.equal(loadingTriggered, true, "an instant nudge at the loaded bottom must trigger loading");
  assert.ok(
    scrollAssignments.some(
      (assignment) =>
        assignment.before >= assignment.maxBefore - 40 &&
        assignment.requested > assignment.before
    ),
    "scrollFeed must synchronously nudge even when it is already at the bottom"
  );
  assert.ok(scrollCalls.length + scrollAssignments.length > 0);
  for (const call of scrollCalls) {
    assert.notEqual(call.behavior, "smooth");
    assert.equal(
      call.after,
      Math.max(0, Math.min(call.before + call.top, call.maxBefore)),
      "each scrollBy call must update scrollTop synchronously"
    );
  }
  for (const assignment of scrollAssignments) {
    assert.equal(
      assignment.after,
      Math.max(0, Math.min(assignment.requested, assignment.maxBefore)),
      "each scrollTop assignment must take effect synchronously"
    );
  }
});

test("chunk tiếp theo giữ vị trí cuộn và trả URL đã gom dù chưa tới cuối", () => {
  const scroll = section("function updateEndMarkerConfirmation", "async function enrichAllWithDetails");
  const collect = section("async function scrollAndScrapePlaces", "async function waitForFeed");
  const readiness = section("async function waitForCellFeedReady", "let _lastKnownTotalCells");

  assert.match(scroll, /if \(feed && !resumeFromCurrent\) \{/);
  assert.match(scroll, /reason = "chunk_budget"/);
  assert.match(collect, /maxMs: CELL_SCROLL_CHUNK_MS/);
  assert.match(collect, /resumeFromCurrent/);
  assert.match(readiness, /if \(!resumeFromCurrent\) \{\s*feed\.scrollTop = 0/);
  assert.match(readiness, /if \(!resumeFromCurrent\) feed\.scrollTop = 0/);
  assert.ok(
    collect.indexOf("for (const { listData, place } of pending.values())") <
      collect.indexOf("if (scrollOutcome.reachedEnd)"),
    "chunk chưa tới cuối vẫn phải trả các URL vừa gom cho background checkpoint"
  );
});
