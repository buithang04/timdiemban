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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFeed(urls) {
  const links = urls.map((href) => ({ href, getAttribute: () => href }));
  return {
    items: links,
    querySelectorAll: () => links
  };
}

test("visibilitychange báo hidden đúng pha list kèm lease và vẫn báo visible", () => {
  const source = section("function handleVisibilityChange", "document.addEventListener");
  const sent = [];
  const dispatched = [];
  const lease = { runId: "run-visible", cellGeneration: 6 };
  const document = {
    hidden: true,
    dispatchEvent: (event) => dispatched.push(event.type)
  };
  const context = vm.createContext({
    document,
    scrapeInProgress: true,
    activeCellTask: {},
    activeCellLease: lease,
    safeSend: (message) => sent.push(message),
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    }
  });
  vm.runInContext(`${source}\nthis.handleVisibilityChange = handleVisibilityChange;`, context);

  context.handleVisibilityChange();
  assert.deepEqual(plain(sent), [
    { action: "MAPS_TAB_HIDDEN", runId: "run-visible", cellGeneration: 6 }
  ]);

  document.hidden = false;
  context.handleVisibilityChange();
  assert.deepEqual(plain(sent[1]), {
    action: "MAPS_TAB_VISIBLE",
    runId: "run-visible",
    cellGeneration: 6
  });
  assert.deepEqual(dispatched, ["timdiemban-wake", "timdiemban-wake"]);

  sent.length = 0;
  document.hidden = true;
  context.activeCellTask = null;
  context.handleVisibilityChange();
  assert.deepEqual(sent, [], "hidden ngoài pha list không được phát cảnh báo");
});

test("list checkpoint gửi URL mới kèm lease và vị trí cuộn bền", () => {
  const source = section("function sendListCheckpoint", "function sendItem");
  const sent = [];
  const context = vm.createContext({
    activeCellLease: { runId: "run-checkpoint", cellGeneration: 9 },
    safeSend: (message) => sent.push(message)
  });
  vm.runInContext(`${source}\nthis.sendListCheckpoint = sendListCheckpoint;`, context);

  context.sendListCheckpoint(
    2,
    [{ name: "A", href: "https://www.google.com/maps/place/A" }],
    {
      totalNewPlaces: 17,
      scrollTop: 1234,
      scrollHeight: 5678,
      lastItemKey: "cid:chij-a"
    }
  );

  assert.deepEqual(plain(sent), [
    {
      action: "SCRAPE_CELL_LIST_CHECKPOINT",
      runId: "run-checkpoint",
      cellGeneration: 9,
      data: {
        cellIndex: 2,
        places: [{ name: "A", href: "https://www.google.com/maps/place/A" }],
        newPlacesCount: 1,
        totalNewPlaces: 17,
        scrollTop: 1234,
        scrollHeight: 5678,
        lastItemKey: "cid:chij-a"
      }
    }
  ]);

  context.sendListCheckpoint(2, [], { totalNewPlaces: 18 });
  assert.equal(sent.length, 1, "không gửi checkpoint rỗng");
});

test("getFeedPanel chọn result feed khi trang có nhiều role=feed", () => {
  const source = section("function sendItem", "/** Text trong button contact Maps");
  const placeLink = { href: "https://www.google.com/maps/place/Correct" };
  const makeRoleFeed = (links) => ({
    querySelector: (selector) =>
      selector.includes("/maps/place") ? links[0] || null : null,
    querySelectorAll: (selector) =>
      selector.includes("/maps/place") ? links : []
  });
  const reviewFeed = makeRoleFeed([]);
  const resultFeed = makeRoleFeed([placeLink]);
  const main = {
    querySelector: (selector) =>
      selector === 'div[role="feed"]' ? reviewFeed : null,
    querySelectorAll: (selector) =>
      selector.includes("/maps/place") ? [placeLink] : []
  };
  const document = {
    querySelector: (selector) => {
      if (selector === 'div[role="feed"]') return reviewFeed;
      if (selector === '[role="main"]') return main;
      return null;
    },
    querySelectorAll: (selector) =>
      selector.includes('[role="feed"]') ? [reviewFeed, resultFeed] : []
  };
  const context = vm.createContext({
    document,
    location: { pathname: "/maps/search/coffee" },
    window: { location: { pathname: "/maps/search/coffee" } },
    getResultItems: (feed) => feed.querySelectorAll("a[href*='/maps/place']")
  });
  vm.runInContext(`${source}\nthis.getFeedPanel = getFeedPanel;`, context);

  assert.equal(
    context.getFeedPanel(),
    resultFeed,
    "review feed đứng trước không được che result feed có URL địa điểm"
  );
});

test("findDetailPaneH1 không dùng H1 ẩn hoặc stale ngoài viewport", () => {
  const source = section("function findDetailPaneFromH1", "function tabLabelText");
  const makeH1 = (text, rect) => ({
    textContent: text,
    isConnected: true,
    hidden: false,
    closest: () => null,
    getAttribute: () => "",
    getBoundingClientRect: () => rect
  });
  const stale = makeH1("Địa điểm cũ", {
    width: 280,
    height: 40,
    top: -500,
    bottom: -460,
    left: 0,
    right: 280
  });
  const current = makeH1("Địa điểm hiện tại", {
    width: 280,
    height: 40,
    top: 40,
    bottom: 80,
    left: 20,
    right: 300
  });
  const document = {
    h1s: [stale, current],
    querySelectorAll(selector) {
      return selector === "h1" ? this.h1s : [];
    },
    querySelector: () => null
  };
  const context = vm.createContext({
    document,
    window: {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    },
    cleanPlaceName: (value) => String(value || "").trim(),
    isSponsoredPlace: () => false
  });
  vm.runInContext(`${source}\nthis.findDetailPaneH1 = findDetailPaneH1;`, context);

  assert.equal(context.findDetailPaneH1(), current);
  document.h1s = [stale];
  assert.equal(context.findDetailPaneH1(), null, "không được fallback về H1 cũ đang ẩn");
});

test("end marker phải đúng nội dung và nằm sau kết quả cuối", () => {
  const source = section("const END_LIST_PATTERNS", "function isFeedLoading");
  const context = vm.createContext({
    Node: { DOCUMENT_POSITION_PRECEDING: 2 },
    isFeedLoading: () => false,
    getResultItems: (feed) => feed.items
  });
  vm.runInContext(`${source}\nthis.hasEndMarker = hasEndMarker;`, context);

  const makeNode = ({ text = "", role = "", legacy = false } = {}) => {
    const legacyText = { textContent: text };
    return {
      textContent: text,
      parentElement: null,
      getAttribute: (name) => (name === "role" ? role : name === "aria-label" ? "" : ""),
      matches: (selector) => selector === '[role="article"]' && role === "article",
      closest: () => null,
      querySelector: (selector) => (legacy && selector === "span.HlvSq" ? legacyText : null),
      querySelectorAll: () => [],
      compareDocumentPosition: () => 0
    };
  };
  const makeFeedWithMarker = ({ text, role = "", legacy = false, markerFirst = false }) => {
    const article = makeNode({ role: "article" });
    const marker = makeNode({ text, role, legacy });
    const fillers = Array.from({ length: 6 }, () => makeNode({ text: "filler" }));
    const children = markerFirst
      ? [marker, ...fillers, article]
      : [article, ...fillers, marker];
    const feed = {
      children,
      items: [article],
      querySelectorAll: (selector) => {
        if (selector === '[role="status"]' && role === "status") return [marker];
        if (selector.includes("fontBodyMedium") && legacy) return [marker];
        return [];
      }
    };
    for (const child of children) child.parentElement = feed;
    return feed;
  };
  const makeWrappedFeed = ({ wrapperAtTail, markerAfterArticle }) => {
    const article = makeNode({ role: "article" });
    const marker = makeNode({ text: "Bạn đã xem hết danh sách", role: "status" });
    const wrapper = makeNode({ text: "Bạn đã xem hết danh sách" });
    const fillers = Array.from({ length: 6 }, () => makeNode({ text: "filler" }));
    article.parentElement = wrapper;
    marker.parentElement = wrapper;
    marker.compareDocumentPosition = (other) =>
      other === article && markerAfterArticle ? context.Node.DOCUMENT_POSITION_PRECEDING : 0;
    const children = wrapperAtTail ? [...fillers, wrapper] : [wrapper, ...fillers];
    const feed = {
      children,
      items: [article],
      querySelectorAll: (selector) => (selector === '[role="status"]' ? [marker] : [])
    };
    for (const child of children) child.parentElement = feed;
    return feed;
  };

  assert.equal(
    context.hasEndMarker(
      makeFeedWithMarker({ text: "Mở cửa hôm nay", legacy: true })
    ),
    false,
    "class HlvSq với text thường không được kết thúc danh sách"
  );
  assert.equal(
    context.hasEndMarker(
      makeFeedWithMarker({ text: "Bạn đã xem hết danh sách", legacy: true, markerFirst: true })
    ),
    false,
    "marker hợp lệ nhưng nằm trước kết quả cuối không được chấp nhận"
  );
  assert.equal(
    context.hasEndMarker(
      makeFeedWithMarker({ text: "Bạn đã xem hết danh sách", role: "status" })
    ),
    true,
    "semantic role + text hợp lệ ở cuối feed phải được nhận"
  );
  assert.equal(
    context.hasEndMarker(
      makeFeedWithMarker({ text: "No more results" })
    ),
    true,
    "tail text hợp lệ không phụ thuộc class Maps phải được nhận"
  );
  assert.equal(
    context.hasEndMarker(makeWrappedFeed({ wrapperAtTail: true, markerAfterArticle: true })),
    true,
    "article cuối và marker trong cùng wrapper ở tail phải dùng document order"
  );
  assert.equal(
    context.hasEndMarker(makeWrappedFeed({ wrapperAtTail: false, markerAfterArticle: true })),
    false,
    "cùng wrapper đúng document order nhưng wrapper không ở tail vẫn phải bị từ chối"
  );
  assert.equal(
    context.hasEndMarker(makeWrappedFeed({ wrapperAtTail: true, markerAfterArticle: false })),
    false,
    "marker đứng trước article trong cùng wrapper không được kết thúc danh sách"
  );
});

test("end marker semantic không cần text hiển thị", () => {
  const source = section("function readRatingAndReviews", "function isFeedLoading");
  const context = vm.createContext({
    Node: { DOCUMENT_POSITION_PRECEDING: 2 },
    isFeedLoading: () => false,
    getResultItems: (feed) => feed.items
  });
  vm.runInContext(`${source}\nthis.hasEndMarker = hasEndMarker;`, context);

  const makeSemanticFeed = (attribute, value) => {
    const article = {
      textContent: "Địa điểm",
      parentElement: null,
      matches: (selector) => selector === '[role="article"]',
      querySelectorAll: () => [],
      querySelector: () => null
    };
    const attrs = { [attribute]: value };
    const marker = {
      textContent: "",
      parentElement: null,
      getAttribute: (name) => attrs[name] || "",
      hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
      matches: () => false,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      compareDocumentPosition: (other) =>
        other === article ? context.Node.DOCUMENT_POSITION_PRECEDING : 0
    };
    const fillers = Array.from({ length: 5 }, () => ({
      textContent: "filler",
      parentElement: null,
      matches: () => false,
      querySelectorAll: () => []
    }));
    const children = [article, ...fillers, marker];
    const feed = {
      children,
      items: [article],
      querySelectorAll: (selector) => {
        if (attribute === "data-end-of-list" && selector === "[data-end-of-list]") return [marker];
        if (attribute === "data-testid" && selector.includes("data-testid")) return [marker];
        if (attribute === "data-item-id" && selector.includes("data-item-id")) return [marker];
        return [];
      }
    };
    for (const child of children) child.parentElement = feed;
    return feed;
  };

  for (const [attribute, value] of [
    ["data-end-of-list", "true"],
    ["data-testid", "end-of-list"],
    ["data-item-id", "end_of_list"]
  ]) {
    assert.equal(
      context.hasEndMarker(makeSemanticFeed(attribute, value)),
      true,
      `${attribute} semantic ở cuối feed phải đủ xác nhận end marker`
    );
  }
});

test("address ưu tiên data-item-id và vẫn nhận copy-address aria", () => {
  const decode = section("function safeDecodeURIComponent", "function tbLog");
  const addressMeta = section("const ADDRESS_LABEL_PREFIXES", "function isMapsUiLabel");
  const addressParser = section("function parseAddressFromContactButton", "function isInFeedOrList");
  const context = vm.createContext({
    isOverviewContactButton: () => true,
    cleanAddressText: (value) => String(value || "").trim(),
    cleanLabel: (value, prefixes) => {
      let out = String(value || "");
      for (const prefix of prefixes) out = out.replace(prefix, "");
      return out.trim();
    },
    readIo6YTeFromButton: () => "",
    queryAddressBodyText: () => "",
    pickBestAddress: (...values) => values.find(Boolean) || ""
  });
  vm.runInContext(
    `${decode}\n${addressMeta}\n${addressParser}\n` +
      "this.parseAddressFromContactButton = parseAddressFromContactButton;",
    context
  );
  const makeButton = ({ itemId = "", ariaLabel = "" }) => ({
    getAttribute: (name) =>
      name === "data-item-id" ? itemId : name === "aria-label" ? ariaLabel : "",
    querySelector: () => null,
    querySelectorAll: () => []
  });

  assert.equal(
    context.parseAddressFromContactButton(
      makeButton({
        itemId: "address:12%20Đường%20Data",
        ariaLabel: "Địa chỉ: 99 Đường Aria"
      })
    ),
    "12 Đường Data",
    "data-item-id chính xác phải thắng aria-label"
  );
  assert.equal(
    context.parseAddressFromContactButton(
      makeButton({ ariaLabel: "Sao chép địa chỉ: 45 Phố Huế, Hà Nội" })
    ),
    "45 Phố Huế, Hà Nội",
    "aria-only copy-address phải là fallback hợp lệ"
  );
});

test("rating bỏ qua aria Sao chép và tiếp tục tới giá trị rating thật", () => {
  const source = section("function readRatingAndReviews", "const END_LIST_PATTERNS");
  const copyAddress = {
    textContent: "",
    getAttribute: (name) =>
      name === "aria-label" ? "Sao chép địa chỉ: 12 Đường A" : ""
  };
  const actualRating = {
    textContent: "4,7",
    getAttribute: () => ""
  };
  const root = {
    querySelector(selector) {
      if (selector.startsWith('[role="img"]')) return null;
      if (selector.startsWith('[aria-label*="sao"')) return copyAddress;
      if (selector === 'span[aria-hidden="true"]') return actualRating;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('aria-label*="sao"')) return [copyAddress];
      if (selector === 'span[aria-hidden="true"]') return [actualRating];
      return [];
    }
  };
  const context = vm.createContext({
    findDetailPaneH1: () => null,
    findRatingAndReviews: () => ({ rating: "", reviews: "" }),
    parseRatingText: (value) => {
      const match = String(value || "").trim().replace(",", ".").match(/^(\d(?:\.\d)?)/);
      return match ? match[1] : "";
    },
    parseReviewCountText: () => "",
    isDetailNavTab: () => false,
    document: root
  });
  vm.runInContext(`${source}\nthis.readRatingAndReviews = readRatingAndReviews;`, context);

  assert.equal(context.readRatingAndReviews(root).rating, "4.7");
});

test("tên list item ưu tiên aria-label của place link trước class Google", () => {
  const source = section("function extractListItemData", "async function waitForDetailPanel");
  const link = {
    href: "https://www.google.com/maps/place/Ten+Dung",
    textContent: "Tên link",
    getAttribute: (name) => (name === "aria-label" ? "Tên đúng từ aria" : "")
  };
  const wrongClassTitle = { textContent: "Tên sai từ fontHeadline" };
  const item = {
    textContent: "",
    querySelector: (selector) => {
      if (selector === "a[href*='/maps/place']") return link;
      if (selector.includes("fontHeadline")) return wrongClassTitle;
      return null;
    }
  };
  const context = vm.createContext({
    PF: null,
    isSponsoredItem: () => false,
    cleanPlaceName: (value) => String(value || "").trim(),
    isSponsoredPlace: () => false,
    getPlaceId: () => "place-id",
    readRatingFromListItem: () => ({ rating: "", reviews: "" }),
    parseListMeta: () => ({ category: "", address: "", listDistanceKm: null }),
    hasReliableAddress: () => false,
    stripNameFromAddress: (value) => value,
    isMergedNameMetaText: () => false,
    isGarbageAddressText: () => false,
    extractCoordsFromUrl: () => null,
    getGooglePlaceId: () => "place-id",
    pickBestPhoneCandidate: () => "",
    cleanAddressText: (value) => String(value || ""),
    getPlacePageUrl: () => "",
    buildPlaceMapsUrl: () => ""
  });
  vm.runInContext(`${source}\nthis.extractListItemData = extractListItemData;`, context);

  assert.equal(context.extractListItemData(item).name, "Tên đúng từ aria");
});

test("content không còn shortcut debug Ctrl+Shift+D hoặc toggle shield", () => {
  const shortcutStart = content.indexOf("function isDevToolsShortcut");
  const shortcutEnd = content.indexOf("function handleVisibilityChange", shortcutStart);
  const shortcuts =
    shortcutStart >= 0 && shortcutEnd > shortcutStart
      ? content.slice(shortcutStart, shortcutEnd)
      : "";
  assert.doesNotMatch(content, /toggleShieldPeek/);
  assert.doesNotMatch(content, /Ctrl\+Shift\+D/i);
  assert.doesNotMatch(shortcuts, /["']D["']/);
});

test("data-item-id malformed percent giữ raw thay vì làm vỡ trích xuất", () => {
  const decode = section("function safeDecodeURIComponent", "function tbLog");
  const address = section("function parseAddressFromContactButton", "function isInFeedOrList");
  const phone = section("function extractPhoneFromText", "function getOverviewContactSignature");
  const extractAll = section("function extractAllFromDetailPane", "function isOnResultList");
  const context = vm.createContext({
    PF: null,
    ADDRESS_LABEL_PREFIXES: [],
    PHONE_LABEL_PREFIXES: [],
    isAddressContactButton: () => true,
    isOverviewContactButton: () => true,
    extractAddressFromAriaLabel: () => "",
    cleanAddressText: (value) => String(value || "").trim(),
    cleanLabel: () => "",
    readIo6YTeFromButton: () => "",
    queryAddressBodyText: () => "",
    pickBestAddress: (...values) => values.find(Boolean) || "",
    normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
    formatPhoneVN: (value) => value,
    getPhoneContactMeta: (el) => ({ itemId: el.getAttribute("data-item-id") || "" }),
    extractPhoneFromAriaLabel: () => "",
    isHoursSubPanelOpen: () => false,
    isOverviewTabActive: () => true,
    findDetailPaneH1: () => null,
    getDetailPane: () => null,
    readAddressFromContactButtons: () => "",
    readPhoneFromContactButtons: () => "",
    readWebsite: () => "",
    isInSearchFeed: () => false,
    normalizeWebsiteUrl: () => "",
    readRatingAndReviews: () => ({ rating: "", reviews: "" })
  });
  vm.runInContext(
    `${decode}\n${address}\n${phone}\n${extractAll}\n` +
      "this.parseAddressFromContactButton = parseAddressFromContactButton;" +
      "this.parsePhoneFromContactButton = parsePhoneFromContactButton;" +
      "this.extractAllFromDetailPane = extractAllFromDetailPane;",
    context
  );

  const makeContact = (itemId) => ({
    textContent: "",
    getAttribute: (name) => (name === "data-item-id" ? itemId : ""),
    querySelector: () => null
  });
  assert.equal(
    context.parseAddressFromContactButton(makeContact("address:12% Đường A")),
    "12% Đường A"
  );
  assert.equal(
    context.parsePhoneFromContactButton(makeContact("phone:tel:0901234567%")),
    "0901234567"
  );

  const fallbackPhone = makeContact("phone:tel:0901234567%");
  const pane = { querySelectorAll: () => [fallbackPhone] };
  assert.equal(context.extractAllFromDetailPane(pane).phone, "0901234567%");
});

test("field selectors ưu tiên semantic và không xóa DOM Google Maps", () => {
  const contacts = section("const PHONE_CONTACT_SELECTOR", "function getPhoneContactMeta");
  const phone = section("function parsePhoneFromContactButton", "function getOverviewContactSignature");
  const hours = section("function readHoursFromOverviewButton", "function isSafeExpandButton");
  const website = section("function readWebsite", "async function waitForWebsite");
  const rating = section("function readRatingAndReviews", "const END_LIST_PATTERNS");
  const cleanup = section("function cleanupStaleDom", "async function prepareForNextListClick");

  assert.match(contacts, /ADDRESS_CONTACT_SELECTOR[\s\S]*\[data-item-id=\"address\"\]/);
  assert.doesNotMatch(contacts, /button\[data-item-id=\"address\"\]/);
  assert.ok(phone.indexOf('getAttribute("data-item-id")') < phone.indexOf("readIo6YTeFromButton"));
  assert.ok(hours.indexOf('getAttribute("aria-label")') < hours.indexOf('.ZDu9vd'));
  assert.ok(website.indexOf('a[data-item-id="authority"]') < website.indexOf("Io6YTe"));
  assert.ok(rating.indexOf('[role="img"]') < rating.indexOf('fontBody'));
  assert.doesNotMatch(cleanup, /\.remove\s*\(/);
  assert.doesNotMatch(cleanup, /m6QErb/);
});

test("enrich cũ nhận cancel signal và op mới không khởi động khi chờ timeout", async () => {
  const source = section("const ENRICH_PREVIOUS_TASK_WAIT_MS", "window.__timDiemBanWake");
  let resolveOld;
  let oldCancelMarker = null;
  let newEnrichCalls = 0;
  const oldPending = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const timeoutCalls = [];
  const context = vm.createContext({
    activeEnrichTask: null,
    activeEnrichOpId: "",
    activeEnrichCancelMarker: null,
    setTimeout: (callback, ms) => {
      timeoutCalls.push(ms);
      callback();
      return 1;
    },
    clearTimeout: () => {},
    getEnrichProfile: () => ({ fast: true, quick: true }),
    enrichPlaceOnPage: async (listData, _searchParams, _text, _percent, options) => {
      if (listData.name === "old") {
        oldCancelMarker = options.cancelMarker;
        return oldPending;
      }
      newEnrichCalls++;
      return { name: listData.name };
    },
    enrichCanonicalMatches: () => true
  });
  vm.runInContext(
    `${source}\nthis.runEnrichPlaceMessage = runEnrichPlaceMessage;`,
    context
  );

  const oldTask = context.runEnrichPlaceMessage({
    opId: "old-op",
    listData: { name: "old" },
    searchParams: {}
  });
  await Promise.resolve();

  const nextResult = await context.runEnrichPlaceMessage({
    opId: "new-op",
    listData: { name: "new" },
    searchParams: {}
  });

  assert.equal(oldCancelMarker.cancelled, true);
  assert.deepEqual(plain(nextResult), {
    success: false,
    settled: false,
    opId: "new-op",
    error: "Thao tác bổ sung trước chưa dừng; chưa bắt đầu thao tác mới."
  });
  assert.deepEqual(timeoutCalls, [8000]);
  assert.equal(newEnrichCalls, 0, "op mới không được gọi khi op cũ chưa settled");

  resolveOld({ name: "old" });
  await oldTask;
  const retryResult = await context.runEnrichPlaceMessage({
    opId: "new-op",
    listData: { name: "new" },
    searchParams: {}
  });
  assert.deepEqual(plain(retryResult), {
    success: true,
    place: { name: "new" },
    opId: "new-op"
  });
  assert.equal(newEnrichCalls, 1);

  const extract = section("async function extractPlaceDetails", "function mergePlaceData");
  const enrich = section("async function enrichPlaceOnPage", "/** Mở chi tiết bằng click");
  const abortHandler = section(
    'if (message.action === "ENRICH_ABORT")',
    'if (message.action === "ENRICH_ONE")'
  );
  assert.match(extract, /cancelMarker/);
  assert.match(extract, /throwIfEnrichCancelled\(cancelMarker\)/);
  assert.match(enrich, /cancelMarker/);
  assert.match(enrich, /throwIfEnrichCancelled\(cancelMarker\)/);
  assert.match(abortHandler, /waitForPreviousEnrichTask\(taskToSettle\)/);
  assert.match(abortHandler, /success:\s*settled/);
  assert.match(abortHandler, /settled:\s*false/);
  assert.match(abortHandler, /return true/);
});

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

test("visible feed scroll uses one 55-85% viewport rhythm split into smooth steps", async () => {
  const source = section(
    "function updateEndMarkerConfirmation",
    "async function enrichAllWithDetails"
  );
  let now = 0;
  let resultCount = 10;
  const pauses = [];
  const settleCalls = [];
  const scrollCalls = [];
  const feed = {
    isConnected: true,
    clientHeight: 1000,
    scrollHeight: 5000,
    scrollTop: 0,
    style: {},
    scrollBy({ top, behavior }) {
      this.scrollTop = Math.max(
        0,
        Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + Number(top || 0))
      );
      if (scrollCalls.length === 0) {
        this.scrollHeight += 400;
        resultCount += 3;
      }
      scrollCalls.push({ top, behavior, after: this.scrollTop });
    }
  };
  const context = vm.createContext({
    CELL_SCROLL_CHUNK_MS: 220000,
    T: { scroll: 150, scrollInit: 100 },
    Date: { now: () => now },
    document: { hidden: false },
    isAborted: false,
    getFeedPanel: () => feed,
    getResultItems: () => Array.from({ length: resultCount }, () => ({})),
    waitForFeed: async () => feed,
    waitForFeedContentReady: async (_feed, maxMs) => {
      settleCalls.push(maxMs);
      return true;
    },
    isFeedLoading: () => false,
    hasEndMarker: () => false,
    feedScrollStep: (panel, ratio, minPx) =>
      Math.max(panel.clientHeight * ratio, minPx),
    sleep: async (ms) => {
      pauses.push(ms);
      now += ms;
    },
    tbLog: () => {}
  });
  vm.runInContext("Math.random = () => 0.5", context);
  vm.runInContext(`${source}\nthis.scrollFeed = scrollFeed;`, context);

  const outcome = await context.scrollFeed(
    feed,
    async () => ({ total: resultCount }),
    { safetyMax: 1, maxMs: 20000 }
  );

  assert.equal(outcome.reason, "safety_limit");
  assert.ok(scrollCalls.length >= 4 && scrollCalls.length <= 6);
  assert.ok(scrollCalls.every((call) => call.behavior === "smooth"));
  const totalDistance = scrollCalls.reduce((sum, call) => sum + call.top, 0);
  assert.ok(totalDistance >= 550 && totalDistance <= 850);
  assert.equal(feed.scrollTop, totalDistance);
  assert.ok(
    scrollCalls.every((call) => call.top > 0 && call.top < totalDistance),
    "một nhịp cuộn phải được chia thành nhiều chuyển động nhỏ"
  );
  assert.ok(
    pauses.filter((ms) => ms >= 80 && ms <= 155).length >= scrollCalls.length,
    "mỗi chuyển động nhỏ phải có nhịp nghỉ jitter"
  );
  assert.ok(
    pauses.some((ms) => ms >= 650 && ms <= 1050),
    "DOM/result tăng phải có thêm thời gian settle"
  );
  assert.ok(
    settleCalls.includes(8000),
    "sau khi danh sách tăng phải dùng cửa sổ settle dài hơn"
  );
});

test("visible smooth scroll falls back when scrollTop does not move", async () => {
  const source = section(
    "function updateEndMarkerConfirmation",
    "async function enrichAllWithDetails"
  );
  let scrollTop = 100;
  const smoothCalls = [];
  const directAssignments = [];
  const feed = {
    isConnected: true,
    clientHeight: 800,
    scrollHeight: 4000,
    style: {},
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      scrollTop = Math.max(0, Math.min(3200, Number(value) || 0));
      directAssignments.push(scrollTop);
    },
    scrollBy(options) {
      smoothCalls.push(options);
      // Mô phỏng renderer tab nền bỏ qua smooth scroll.
    }
  };
  const context = vm.createContext({
    document: { hidden: false },
    isAborted: false,
    getResultItems: () => Array.from({ length: 8 }, () => ({}))
  });
  vm.runInContext("Math.random = () => 0.5", context);
  vm.runInContext(`${source}\nthis.scrollFeedLikeUser = scrollFeedLikeUser;`, context);

  const outcome = await context.scrollFeedLikeUser(
    feed,
    600,
    async () => true,
    false
  );

  assert.ok(smoothCalls.length >= 4 && smoothCalls.length <= 6);
  assert.ok(smoothCalls.every((call) => call.behavior === "smooth"));
  assert.equal(outcome.target, 700);
  assert.equal(outcome.after.scrollTop, 700);
  assert.equal(outcome.moved, true);
  assert.equal(outcome.usedDirectFallback, true);
  assert.ok(directAssignments.length > 0, "phải fallback setter khi smooth không di chuyển");
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
  assert.equal(outcome.newPlacesCount, 5);
  assert.equal(outcome.scrollHeight, 2000);
  assert.equal(outcome.suspendDetected, false);
  assert.equal(outcome.continuationRecommended, false);
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

test("renderer thức lại trả continuation và final-collect URL trước khi hết chunk", async () => {
  const source = section(
    "function updateEndMarkerConfirmation",
    "async function enrichAllWithDetails"
  );
  let now = 0;
  let injectedSuspend = false;
  let collectCalls = 0;
  const feed = {
    isConnected: true,
    clientHeight: 500,
    scrollHeight: 1800,
    scrollTop: 640,
    style: {},
    scrollBy({ top }) {
      this.scrollTop = Math.max(
        0,
        Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + Number(top || 0))
      );
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
    waitForFeedContentReady: async () => true,
    isFeedLoading: () => false,
    hasEndMarker: () => false,
    feedScrollStep: (panel, ratio, minPx) =>
      Math.max(panel.clientHeight * ratio, minPx),
    sleep: async (ms) => {
      now += ms;
      if (!injectedSuspend) {
        injectedSuspend = true;
        now += 30000;
      }
    },
    tbLog: () => {}
  });
  vm.runInContext(`${source}\nthis.scrollFeed = scrollFeed;`, context);

  const outcome = await context.scrollFeed(
    feed,
    async () => {
      collectCalls++;
      return { total: 4, lastItemKey: "cid:after-wake" };
    },
    { safetyMax: 20, maxMs: 200000 }
  );

  assert.equal(outcome.reachedEnd, false);
  assert.equal(outcome.reason, "renderer_suspended");
  assert.equal(outcome.continuationRecommended, true);
  assert.equal(outcome.suspendDetected, true);
  assert.equal(outcome.suspendCount, 1);
  assert.ok(outcome.suspendGapMs >= 30000);
  assert.equal(outcome.newPlacesCount, 4);
  assert.equal(outcome.lastItemKey, "cid:after-wake");
  assert.equal(outcome.scrollTop, feed.scrollTop);
  assert.equal(outcome.scrollHeight, feed.scrollHeight);
  assert.equal(collectCalls, 1, "phải đọc DOM một lần sau wake để giữ URL vừa lazy-load");
});

test("chunk tiếp theo giữ vị trí cuộn và trả URL đã gom dù chưa tới cuối", () => {
  const scroll = section("function updateEndMarkerConfirmation", "async function enrichAllWithDetails");
  const collect = section("async function scrollAndScrapePlaces", "async function waitForFeed");
  const readiness = section("async function waitForCellFeedReady", "let _lastKnownTotalCells");

  assert.match(scroll, /if \(feed && !resumeFromCurrent\) \{/);
  assert.match(scroll, /reason = "chunk_budget"/);
  assert.match(collect, /maxMs: CELL_SCROLL_CHUNK_MS/);
  assert.match(collect, /resumeFromCurrent/);
  assert.match(collect, /sendListCheckpoint\(cellIndex, checkpointPlaces/);
  assert.match(collect, /newPlacesCount: results\.length/);
  assert.match(collect, /lastItemKey: scrollOutcome\.lastItemKey/);
  assert.match(collect, /continuationRecommended: scrollOutcome\.continuationRecommended/);
  assert.match(readiness, /if \(!resumeFromCurrent\) \{\s*feed\.scrollTop = 0/);
  assert.match(readiness, /if \(!resumeFromCurrent\) feed\.scrollTop = 0/);
  assert.ok(
    collect.indexOf("for (const { listData, place } of pending.values())") <
      collect.indexOf("if (scrollOutcome.reachedEnd)"),
    "chunk chưa tới cuối vẫn phải trả các URL vừa gom cho background checkpoint"
  );
});
