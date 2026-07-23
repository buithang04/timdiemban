(function () {
  // Bump version mỗi lần sửa content — background sẽ reinject nếu Maps còn bản cũ
  const CONTENT_VERSION = 74;
  if (window.__timDiemBanLoaded && window.__timDiemBanVersion === CONTENT_VERSION) return;
  if (typeof window.__timDiemBanCleanup === "function") {
    try {
      window.__timDiemBanCleanup();
    } catch {}
  }
  window.__timDiemBanLoaded = true;
  window.__timDiemBanVersion = CONTENT_VERSION;

  const CONTENT_INSTANCE_ID =
    window.__timDiemBanDocumentInstanceId ||
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  window.__timDiemBanDocumentInstanceId = CONTENT_INSTANCE_ID;

  const RunLease = globalThis.TimDiemBanRunLease;

  let extAlive = true;
  function safeSend(message, cb) {
    if (!extAlive) return;
    try {
      if (!chrome?.runtime?.id) {
        extAlive = false;
        return;
      }
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.then === "function") {
        p.then(
          (resp) => {
            if (typeof cb === "function") {
              try {
                cb(resp);
              } catch {}
            }
          },
          (err) => {
            if (/context invalidated|extension context/i.test(String(err?.message || err))) {
              extAlive = false;
            }
          }
        );
        return;
      }
      chrome.runtime.sendMessage(message, (resp) => {
        try {
          if (chrome.runtime.lastError) {
            if (/context invalidated/i.test(chrome.runtime.lastError.message || "")) extAlive = false;
            return;
          }
        } catch {
          extAlive = false;
          return;
        }
        if (typeof cb === "function") {
          try {
            cb(resp);
          } catch {}
        }
      });
    } catch {
      extAlive = false;
    }
  }

  let scrapeInProgress = false;

  function sleep(ms) {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      let done = false;
      const step = () => {
        if (done) return;
        const left = deadline - Date.now();
        if (left <= 0) {
          done = true;
          return resolve();
        }
        let timer = null;
        let advanced = false;
        // Mỗi vòng chỉ đi tiếp đúng một lần dù timer, wake hay rAF đến trước.
        const advance = () => {
          if (advanced || done) return;
          advanced = true;
          clearTimeout(timer);
          document.removeEventListener("timdiemban-wake", advance);
          step();
        };
        const chunk = document.hidden ? Math.min(left, 350) : left;
        timer = setTimeout(advance, chunk);
        if (document.hidden) {
          document.addEventListener("timdiemban-wake", advance, { once: true });
        }
      };
      step();
    });
  }
  const T = {
    scroll: 150,
    scrollInit: 100,
    detail: 2800,
    detailPoll: 80,
    detailRetry: 4,
    contactWait: 2800,
    click: 120,
    coordWait: 2200
  };
  const CELL_FEED_WAIT_MS = 24000;
  // Chia pha cuộn thành chunk dưới 5 phút để service worker MV3 không giữ một request quá lâu.
  const CELL_SCROLL_CHUNK_MS = 210000;
  let isAborted = false;
  let activeCellLease = null;
  let activeCellTask = null;
  let activeEnrichTask = null;
  let activeEnrichOpId = "";
  let activeEnrichCancelMarker = null;
  let shieldEl = null;
  let blockKeysHandler = null;
  let shieldWebLabel = "";
  const shieldLogLines = [];
  const SHIELD_LOG_MAX = 14;

  // Google đôi khi phát ra data-item-id chứa phần trăm không hợp lệ; giữ raw thay vì làm hỏng cả lượt quét.
  function safeDecodeURIComponent(value) {
    const raw = String(value ?? "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function tbLog(msg, level = "log") {
    const text = String(msg || "");
    const line = `${new Date().toLocaleTimeString("vi-VN")} ${text}`;
    shieldLogLines.push(line);
    if (shieldLogLines.length > SHIELD_LOG_MAX) shieldLogLines.shift();
    if (level === "warn") console.warn("TimDiemBan:", text);
    else console.log("TimDiemBan:", text);
    appendShieldLog();
    safeSend({ action: "SCRAPE_LOG", line: text, ...(activeCellLease || {}) });
  }

  function appendShieldLog() {
    /* log chỉ ghi Console — không hiển thị trên overlay */
  }

  function isAllowedBrowserShortcut(e) {
    if (e.key === "F12") return true;
    if (e.ctrlKey && e.shiftKey && ["I", "J", "C", "K"].includes(e.key.toUpperCase())) return true;
    if (e.metaKey && e.altKey && e.key.toLowerCase() === "i") return true;
    return false;
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      if (activeCellTask && activeCellLease) {
        safeSend({ action: "MAPS_TAB_HIDDEN", ...activeCellLease });
      }
    } else if (scrapeInProgress) {
      safeSend({ action: "MAPS_TAB_VISIBLE", ...(activeCellLease || {}) });
    }
    document.dispatchEvent(new CustomEvent("timdiemban-wake", { bubbles: true }));
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  function createShield() {
    // Maps SPA có thể gỡ node khỏi DOM — tạo lại nếu đã bị detach
    if (shieldEl && document.contains(shieldEl)) {
      const title = shieldEl.querySelector(".shield-title");
      if (title) title.textContent = "Findmap đang quét Google Maps";
      shieldEl.dataset.contentVersion = String(CONTENT_VERSION);
      return shieldEl;
    }
    if (shieldEl && !document.contains(shieldEl)) {
      try {
        shieldEl.remove();
      } catch {}
      shieldEl = null;
    }
    shieldEl = document.createElement("div");
    shieldEl.id = "timdiemban-shield";
    shieldEl.dataset.contentVersion = String(CONTENT_VERSION);
    shieldEl.innerHTML = `
      <style>
        #timdiemban-shield {
          position: fixed; inset: 0; z-index: 2147483647;
          background: rgba(15, 23, 42, 0.82);
          display: flex; align-items: center; justify-content: center;
          font-family: "Segoe UI", system-ui, sans-serif;
          pointer-events: all !important; cursor: not-allowed; user-select: none;
        }
        #timdiemban-shield * { pointer-events: none; }
        #timdiemban-shield .shield-box {
          background: #fff; border-radius: 16px; padding: 32px 40px;
          max-width: 420px; width: 90%; text-align: center;
          box-shadow: 0 20px 60px rgba(0,0,0,0.35);
        }
        #timdiemban-shield .shield-icon { font-size: 48px; margin-bottom: 12px; }
        #timdiemban-shield .shield-title { font-size: 20px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
        #timdiemban-shield .shield-text { font-size: 14px; color: #64748b; margin-bottom: 20px; line-height: 1.5; }
        #timdiemban-shield .shield-bar-wrap { height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
        #timdiemban-shield .shield-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #2563eb, #3b82f6); border-radius: 4px; transition: width 0.3s; }
        #timdiemban-shield .shield-percent { font-size: 13px; color: #2563eb; font-weight: 600; }
        #timdiemban-shield .shield-warn { margin-top: 16px; font-size: 12px; color: #b45309; background: #fffbeb; padding: 8px 12px; border-radius: 8px; border: 1px solid #fde68a; }
        #timdiemban-shield .shield-hint { margin-top: 10px; font-size: 10px; color: #94a3b8; line-height: 1.4; }
      </style>
      <div class="shield-box">
        <div class="shield-title">Findmap đang quét Google Maps</div>
        <div class="shield-text" id="timdiemban-shield-text">Đang chuẩn bị thu thập thông tin điểm bán…</div>
        <div class="shield-bar-wrap"><div class="shield-bar" id="timdiemban-shield-bar"></div></div>
        <div class="shield-percent" id="timdiemban-shield-percent">0%</div>
        <div class="shield-warn" id="timdiemban-shield-warn">Trong lúc lấy danh sách URL, hãy giữ tab Google Maps ở phía trước. Khi chuyển sang đọc chi tiết từng URL, bạn có thể làm việc ở tab khác; nếu Google Maps không phản hồi trong 5 phút, tab mới được đưa lên để khôi phục.</div>
        <div class="shield-hint">Không đóng hoặc tải lại tab Google Maps cho đến khi Findmap báo hoàn tất.</div>
      </div>`;
    const block = (e) => { e.stopPropagation(); e.preventDefault(); };
    ["click", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel", "touchstart"].forEach(
      (ev) => shieldEl.addEventListener(ev, block, true)
    );
    document.documentElement.appendChild(shieldEl);
    return shieldEl;
  }

  function formatShieldWarn(webLabel) {
    const target = webLabel || "Findmap";
    return `Kết quả đang đồng bộ về ${target}. Hãy giữ Maps ở phía trước khi lấy danh sách URL; ở giai đoạn đọc chi tiết, bạn có thể dùng tab khác. Maps chỉ tự quay lại khi không có dữ liệu mới trong 5 phút.`;
  }

  function resolveWebLabel(webUrl) {
    if (!webUrl) return "";
    try {
      return new URL(webUrl).host;
    } catch {
      return String(webUrl).replace(/\/$/, "").replace(/^https?:\/\//i, "");
    }
  }

  function setShieldMeta({ webUrl, webLabel } = {}) {
    const label = webLabel || resolveWebLabel(webUrl);
    if (label) shieldWebLabel = label;
    const warn = shieldEl?.querySelector("#timdiemban-shield-warn");
    if (warn) warn.textContent = formatShieldWarn(label || shieldWebLabel);
  }

  function showShield(text, percent, meta) {
    createShield();
    if (meta) setShieldMeta(meta);
    shieldLogLines.length = 0;
    scrapeInProgress = true;
    updateShield(text, percent);
    blockKeysHandler = (e) => {
      if (isAllowedBrowserShortcut(e)) return;
      e.preventDefault();
    };
    document.addEventListener("keydown", blockKeysHandler, true);
  }

  function updateShield(text, percent) {
    createShield();
    if (!shieldEl) return;
    const textEl = shieldEl.querySelector("#timdiemban-shield-text");
    const barEl = shieldEl.querySelector("#timdiemban-shield-bar");
    const pctEl = shieldEl.querySelector("#timdiemban-shield-percent");
    if (textEl && text) textEl.textContent = text;
    if (percent != null) {
      const pct = Math.max(0, Math.min(100, Number(percent) || 0));
      if (barEl) barEl.style.width = `${pct}%`;
      if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    }
  }

  /** % tổng — ưu tiên hiển thị tiến độ trong ô hiện tại để không kẹt 1% khi có nhiều ô */
  function calcProgressPercent(cellIndex, totalCells, inCellRatio = 0) {
    if (!totalCells) return 0;
    const ratio = Math.max(0, Math.min(1, Number(inCellRatio) || 0));
    const idx = Math.max(0, Number(cellIndex) || 0);
    const doneCells = (idx / totalCells) * 92;
    const withinSpan = 92 / totalCells;
    const within = ratio * withinSpan;
    return Math.min(95, Math.max(0, Math.round(doneCells + within)));
  }

  function hideShield() {
    scrapeInProgress = false;
    shieldLogLines.length = 0;
    if (blockKeysHandler) {
      document.removeEventListener("keydown", blockKeysHandler, true);
      blockKeysHandler = null;
    }
    if (shieldEl) { shieldEl.remove(); shieldEl = null; }
  }

  function abortScrape() { isAborted = true; hideShield(); }

  function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function sendProgress(percent, text, options = {}) {
    updateShield(text, percent);
    safeSend({
      action: "SCRAPE_PROGRESS",
      percent,
      text,
      dataActivity: options.dataActivity === true,
      ...(activeCellLease || {})
    });
  }

  function sendListCheckpoint(cellIndex, places, progress = {}) {
    if (!Array.isArray(places) || places.length === 0) return;
    safeSend({
      action: "SCRAPE_CELL_LIST_CHECKPOINT",
      ...(activeCellLease || {}),
      data: {
        cellIndex,
        places,
        newPlacesCount: places.length,
        totalNewPlaces: Math.max(places.length, Number(progress.totalNewPlaces) || 0),
        scrollTop: Math.max(0, Number(progress.scrollTop) || 0),
        scrollHeight: Math.max(0, Number(progress.scrollHeight) || 0),
        lastItemKey: String(progress.lastItemKey || "")
      }
    });
  }

  function sendItem(result, searchParams, index, total) {
    if (result) result._webSent = true;
    safeSend({
      action: "SCRAPE_ITEM",
      ...(activeCellLease || {}),
      data: { result, searchParams, index, total, phase: result._phase || "list" }
    });
  }

  function getFeedPanel() {
    const feeds = Array.from(document.querySelectorAll('[role="feed"]'));
    for (const feed of feeds) {
      if (getResultItems(feed).length > 0) return feed;
    }

    for (const feed of feeds) {
      const label = [
        feed.getAttribute("aria-label") || "",
        feed.getAttribute("data-item-id") || "",
        feed.getAttribute("id") || ""
      ]
        .join(" ")
        .toLowerCase();
      if (/(?:kết quả|địa điểm|results?|places?)/i.test(label) && !/(?:đánh giá|reviews?)/i.test(label)) {
        return feed;
      }
    }

    const main = document.querySelector('[role="main"]');
    if (
      /\/maps\/search\//i.test(String(globalThis.location?.pathname || "")) &&
      main &&
      getResultItems(main).length > 0
    ) {
      return main;
    }
    return null;
  }

  /** Text trong button contact Maps — ưu tiên div.Io6YTe (fontBodyMedium) */
  function queryBodyText(el) {
    if (!el) return "";
    const io =
      el.querySelector(".Io6YTe") ||
      el.querySelector('[class*="Io6YTe"]') ||
      el.querySelector('[class*="fontBodyMedium"]') ||
      el.querySelector('[class*="fontBody"]') ||
      el.querySelector('[class*="bodyText"]');
    return (io?.textContent || el.textContent || "").trim();
  }

  function isInSearchFeed(el) {
    return !!el?.closest('[role="feed"]');
  }

  /** Gom text địa chỉ chỉ từ các dòng bên trong nút address (Io6YTe / fontBody*) */
  function queryAddressBodyText(btn) {
    if (!btn) return "";
    const parts = [];
    const seen = new Set();
    for (const io of btn.querySelectorAll(
      ":scope .Io6YTe, :scope [class*='Io6YTe'], :scope [class*='fontBodyMedium'], :scope [class*='fontBodySmall']"
    )) {
      const t = (io.textContent || "").trim();
      if (!t || t.length < 3 || seen.has(t)) continue;
      if (/^(giờ|hours|địa chỉ|address|sao chép|copy)$/i.test(t)) continue;
      if (isMapsUiLabel(t)) continue;
      seen.add(t);
      parts.push(t);
    }
    if (parts.length > 1) return parts.join(", ");
    if (parts.length === 1) return parts[0];
    return "";
  }

  function readIo6YTeFromButton(btn) {
    if (!btn) return "";
    const io =
      btn.querySelector(":scope .Io6YTe") ||
      btn.querySelector(':scope [class*="Io6YTe"]') ||
      btn.querySelector(':scope [class*="fontBodyMedium"]');
    return (io?.textContent || "").trim();
  }

  const PF = globalThis.PlaceFields;
  if (!PF) {
    console.warn("[Findmap] place-fields.js chưa load — parse địa chỉ/SĐT có thể sai");
  }

  const PHONE_CONTACT_SELECTOR = [
    '[data-item-id^="phone"]',
    'a[href^="tel:"]',
    '[aria-label^="số điện thoại" i]',
    '[aria-label^="điện thoại:" i]',
    '[aria-label^="phone:" i]',
    '[aria-label^="phone number:" i]',
    '[aria-label^="sao chép số điện thoại" i]',
    '[aria-label^="copy phone number" i]',
    '[aria-label^="gọi số điện thoại" i]',
    '[aria-label^="call phone" i]'
  ].join(", ");

  const ADDRESS_CONTACT_SELECTOR = [
    '[data-item-id="address"]',
    '[data-item-id^="address"]',
    '[aria-label^="địa chỉ:" i]',
    '[aria-label^="address:" i]',
    '[aria-label^="sao chép địa chỉ" i]',
    '[aria-label^="copy address" i]'
  ].join(", ");

  const OVERVIEW_CONTACT_SELECTOR = [
    ADDRESS_CONTACT_SELECTOR,
    PHONE_CONTACT_SELECTOR,
    '[data-item-id="authority"]',
    '[data-item-id^="authority"]',
    'a[aria-label*="Trang web"]',
    'a[aria-label*="Website"]'
  ].join(", ");

  function getPhoneContactMeta(el) {
    return {
      itemId: el?.getAttribute?.("data-item-id") || "",
      href: el?.getAttribute?.("href") || "",
      ariaLabel: el?.getAttribute?.("aria-label") || "",
      title: el?.getAttribute?.("title") || "",
      tooltip: el?.getAttribute?.("data-tooltip") || "",
      text: el?.textContent || ""
    };
  }

  /** Panel Tổng quan chứa address/phone/website của quán đang mở. */
  function findOverviewContactRoot() {
    const h1 = findDetailPaneH1();
    if (!h1) return null;

    let node = h1.parentElement;
    for (let i = 0; i < 28 && node; i++) {
      if (node.closest('[role="feed"]')) break;
      const hasContact = node.querySelector(OVERVIEW_CONTACT_SELECTOR);
      if (hasContact) return node;
      node = node.parentElement;
    }
    return null;
  }

  function isOverviewContactButton(btn) {
    if (!btn || isInSearchFeed(btn) || isDetailNavTab(btn)) return false;
    const root = findOverviewContactRoot();
    if (!root) return !btn.closest('[role="article"]');
    return root.contains(btn);
  }

  const ADDRESS_LABEL_PREFIXES = [
    /^Địa chỉ:\s*/i,
    /^Địa chỉ\s+/i,
    /^Address:\s*/i,
    /^Address\s+/i,
    /^Sao chép địa chỉ[:\s]*/i,
    /^Copy address[:\s]*/i,
    /^Copiar dirección[:\s]*/i,
    /^Adresse[:\s]*/i,
    /^Dirección[:\s]*/i
  ];

  /** Trích địa chỉ từ aria-label bắt đầu bằng "Địa chỉ:" */
  function extractAddressFromAriaLabel(btn) {
    if (!btn) return "";
    const label = (btn.getAttribute("aria-label") || "").trim();
    for (const prefix of ADDRESS_LABEL_PREFIXES) {
      if (prefix.test(label)) {
        return label.replace(prefix, "").trim();
      }
    }
    return "";
  }

  const PHONE_LABEL_PREFIXES = [
    /^Số\s+điện thoại:\s*/i,
    /^Số điện thoại:\s*/i,
    /^Điện thoại:\s*/i,
    /^Phone:\s*/i,
    /^Phone number:\s*/i,
    /^Sao chép số điện thoại[:\s]*/i,
    /^Copy phone number[:\s]*/i,
    /^Gọi\s+/i,
    /^Call\s+/i,
    /^Llamar\s+/i,
    /^Appeler\s+/i
  ];

  /** Trích SĐT từ aria-label bắt đầu bằng "Số điện thoại:" */
  function extractPhoneFromAriaLabel(btn) {
    if (!btn) return "";
    const label = (btn.getAttribute("aria-label") || "").trim();
    for (const prefix of PHONE_LABEL_PREFIXES) {
      if (prefix.test(label)) {
        const phone = label.replace(prefix, "").trim();
        return phone;
      }
    }
    return "";
  }

  function isAddressContactButton(btn) {
    if (!btn) return false;
    const id = (btn.getAttribute("data-item-id") || "").toLowerCase();
    if (id === "address" || id.startsWith("address")) return true;
    const label = (btn.getAttribute("aria-label") || "").trim();
    return ADDRESS_LABEL_PREFIXES.some((prefix) => prefix.test(label));
  }

  function isMapsUiLabel(text) {
    return PF ? PF.isMapsUiLabel(text) : false;
  }

  function isMapsUiChromeText(text) {
    return PF ? PF.isMapsUiChromeText(text) : false;
  }

  function stripPhoneFromAddress(text) {
    return PF ? PF.stripPhoneFromAddress(text) : String(text || "").trim();
  }

  function stripMapsUiChromeFromAddress(text) {
    return PF ? PF.stripMapsUiChromeFromAddress(text) : String(text || "").trim();
  }

  function isGarbageAddressText(text) {
    return PF ? PF.isGarbageAddressText(text) : !String(text || "").trim();
  }

  function addressCompletenessScore(text) {
    const t = cleanAddressText(stripRatingSuffix(text || ""));
    if (!t || isLikelyCategoryText(t) || isOpeningHoursText(t)) return -1;
    if (isMapsUiChromeText(t) || isMapsUiLabel(t)) return -1;
    let score = t.length;
    const commas = (t.match(/,/g) || []).length;
    score += commas * 18;
    if (/việt nam|vietnam/i.test(t)) score += 28;
    if (/\b\d{4,6}\b/.test(t)) score += 14;
    if (/quận|huyện|phường|thị xã|thành phố|tp\.|ward|district/i.test(t)) score += 16;
    if (/phố|đường(?!\s*đi)|đ\.|d\.|ngõ|ngh\.|ngách|hẻm|street|road|ave/i.test(t)) score += 12;
    if (typeof isValidAddressField === "function" && isValidAddressField(t)) score += 30;
    else if (isLikelyAddress(t)) score += 10;
    if (isStreetOnlyAddress(t)) score -= 45;
    return score;
  }

  /** Chỉ số nhà + tên đường, chưa có phường/quận/thành phố — ví dụ "442 Đ. Trường Chinh" */
  function isStreetOnlyAddress(text) {
    const t = cleanAddressText(stripRatingSuffix(text || ""));
    if (!t || t.length < 8) return false;
    if (/,/.test(t)) return false;
    if (
      /(quận|huyện|phường|thị xã|thành phố|tp\.|tỉnh|việt nam|vietnam|ward|district)/i.test(
        t
      )
    ) {
      return false;
    }
    return (
      /^\d+[\w\s./-]*?(đ\.|đường|phố|ngõ|ngách|hẻm|\bd\.|\bp\.)/i.test(t) ||
      /^\d+\s+[\p{L}]/u.test(t)
    );
  }

  function addressLooksComplete(text) {
    const t = cleanAddressText(stripRatingSuffix(text || ""));
    if (!t || t.length < 14) return false;
    if (isLikelyCategoryText(t) || isOpeningHoursText(t)) return false;
    if (isMapsUiChromeText(t) || isMapsUiLabel(t)) return false;
    if (isStreetOnlyAddress(t)) return false;
    if (t.length >= 50) return true;
    if (
      /,/.test(t) &&
      t.length >= 28 &&
      /(việt nam|vietnam|hà nội|hồ chí minh|đà nẵng|hải phòng|quận|huyện|phường|thành phố|thị xã|tỉnh)/i.test(
        t
      )
    ) {
      return true;
    }
    return addressCompletenessScore(t) >= 58;
  }

  function pickLongestAddress(...candidates) {
    let best = "";
    let bestScore = -1;
    for (const raw of candidates) {
      const t = cleanAddressText(stripRatingSuffix(raw || ""));
      if (!t || isLikelyCategoryText(t) || isOpeningHoursText(t) || isRatingReviewText(t)) continue;
      if (isMapsUiChromeText(t) || isMapsUiLabel(t)) continue;
      const score = addressCompletenessScore(t);
      if (score > bestScore || (score === bestScore && t.length > best.length)) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** Đọc địa chỉ từ data-item-id trước, rồi mới dùng aria/text semantic. */
  function parseAddressFromContactButton(btn) {
    if (!btn || !isAddressContactButton(btn) || !isOverviewContactButton(btn)) return "";

    const itemId = btn.getAttribute("data-item-id") || "";
    const itemAddr = itemId.match(/address:(.+)$/i);
    if (itemAddr) {
      return cleanAddressText(safeDecodeURIComponent(itemAddr[1]).trim());
    }

    const fromAriaLabel = extractAddressFromAriaLabel(btn);
    if (fromAriaLabel && fromAriaLabel.length > 5) {
      return cleanAddressText(fromAriaLabel);
    }

    const fromAria = cleanAddressText(cleanLabel(btn.getAttribute("aria-label") || "", ADDRESS_LABEL_PREFIXES));
    const fromIo = cleanAddressText(readIo6YTeFromButton(btn));
    const fromBody = cleanAddressText(queryAddressBodyText(btn));
    const best = pickBestAddress(fromAria, fromIo, fromBody);
    if (best) return best;
    return "";
  }

  function isInFeedOrList(el) {
    if (!el) return true;
    return !!el.closest('[role="feed"]');
  }

  function collectAddressCandidates() {
    const candidates = [];
    const seen = new Set();
    const selectors = ADDRESS_CONTACT_SELECTOR;

    const roots = [findOverviewContactRoot(), getDetailPane()].filter(Boolean);
    const triedRoots = new Set();
    for (const root of roots) {
      if (triedRoots.has(root)) continue;
      triedRoots.add(root);
      for (const btn of root.querySelectorAll(selectors)) {
        if (!btn || seen.has(btn) || !isOverviewContactButton(btn)) continue;
        seen.add(btn);
        const addr = parseAddressFromContactButton(btn);
        if (addr) candidates.push(addr);
      }
      if (candidates.length) return candidates;
    }

    for (const btn of document.querySelectorAll(selectors)) {
      if (!btn || seen.has(btn) || !isOverviewContactButton(btn)) continue;
      seen.add(btn);
      const addr = parseAddressFromContactButton(btn);
      if (addr) candidates.push(addr);
    }
    return candidates;
  }

  function extractPhoneFromText(text) {
    if (PF?.extractPhoneFromText) return PF.extractPhoneFromText(text);
    if (!text) return "";
    const matches = [...String(text).matchAll(/(?:\+?84|0)[\d\s.\-()]{8,18}/g)];
    let best = "";
    let bestLen = 0;
    for (const m of matches) {
      const raw = m[0].replace(/\s+/g, " ").trim();
      const digits = normalizePhone(raw);
      if (digits.length >= 9 && digits.length <= 12 && digits.length > bestLen) {
        bestLen = digits.length;
        best = raw;
      }
    }
    return best;
  }

  function pickBestPhoneCandidate(...candidates) {
    let best = "";
    let bestLen = 0;
    for (const raw of candidates) {
      if (!raw) continue;
      const fromText = extractPhoneFromText(raw);
      const candidate = fromText || String(raw).replace(/\s+/g, " ").trim();
      const digits = normalizePhone(candidate);
      if (digits.length >= 9 && digits.length <= 12 && digits.length > bestLen) {
        bestLen = digits.length;
        best = candidate;
      }
    }
    if (best && typeof formatPhoneVN === "function") {
      return formatPhoneVN(best);
    }
    return best;
  }

  function pickBestPhone(...candidates) {
    return pickBestPhoneCandidate(...candidates);
  }

  function isPhoneContactButton(btn) {
    if (!btn) return false;
    if (PF?.isPhoneContactMeta) return PF.isPhoneContactMeta(getPhoneContactMeta(btn));
    const itemId = (btn.getAttribute("data-item-id") || "").toLowerCase();
    if (itemId.startsWith("phone")) return true;
    const href = (btn.getAttribute("href") || "").toLowerCase();
    if (href.startsWith("tel:")) return true;
    const label = (btn.getAttribute("aria-label") || "").trim();
    return (
      /^(số\s*)?(điện thoại|phone)\s*:/i.test(label) ||
      /^(sao chép|copy)\s+(số\s+)?(điện thoại|phone)/i.test(label) ||
      /^(gọi|call)\s+/i.test(label)
    );
  }

  /** Đọc SĐT từ button/link liên hệ — ưu tiên tel:/phone:tel rồi aria-label. */
  function parsePhoneFromContactButton(btn) {
    if (!btn || !isPhoneContactButton(btn) || !isOverviewContactButton(btn)) return "";

    const fromMeta = PF?.extractPhoneFromContactMeta?.(getPhoneContactMeta(btn)) || "";
    if (normalizePhone(fromMeta).length >= 9) return fromMeta;

    const itemId = btn.getAttribute("data-item-id") || "";
    const telInId = itemId.match(/phone:tel:([^;]+)/i);
    if (telInId) {
      const fromId = pickBestPhoneCandidate(safeDecodeURIComponent(telInId[1]).trim());
      if (normalizePhone(fromId).length >= 9) return fromId;
    }
    const href = btn.getAttribute("href") || "";
    if (/^tel:/i.test(href)) {
      const fromHref = pickBestPhoneCandidate(href.replace(/^tel:/i, "").split(/[;?]/, 1)[0]);
      if (normalizePhone(fromHref).length >= 9) return fromHref;
    }

    // Ưu tiên cao nhất: aria-label="Số điện thoại: 0123456789" — bóc phần sau prefix
    const fromAriaLabel = extractPhoneFromAriaLabel(btn);
    if (normalizePhone(fromAriaLabel).length >= 9) {
      return pickBestPhoneCandidate(fromAriaLabel);
    }

    const ariaRaw = btn.getAttribute("aria-label") || "";
    const fromAria = pickBestPhoneCandidate(
      cleanLabel(ariaRaw, PHONE_LABEL_PREFIXES),
      extractPhoneFromText(ariaRaw)
    );
    if (normalizePhone(fromAria).length >= 9) return fromAria;

    const fromIo = pickBestPhoneCandidate(readIo6YTeFromButton(btn));
    if (normalizePhone(fromIo).length >= 9) return fromIo;
    return "";
  }

  function getOverviewContactSignature(root) {
    const pane = root || findOverviewContactRoot() || getDetailPane();
    if (!pane) return "";
    const parts = [];
    for (const el of pane.querySelectorAll(OVERVIEW_CONTACT_SELECTOR)) {
      if (isInSearchFeed(el) || isDetailNavTab(el)) continue;
      const meta = getPhoneContactMeta(el);
      parts.push(
        [
          meta.itemId,
          meta.href,
          meta.ariaLabel,
          meta.text.replace(/\s+/g, " ").trim().slice(0, 120)
        ].join("|")
      );
    }
    return parts.join("||");
  }

  async function waitForOverviewContactButtons(listData, maxMs = 6000) {
    const start = Date.now();
    let bestAddr = "";
    let bestPhone = pickBestPhone(listData?.phone || "");
    let bestWebsite = "";
    let revealRound = 0;
    let fieldsSeenAt = 0;
    let lastContactSignature = "";
    let contactStableAt = start;
    // Tăng thời gian chờ DOM render khi page nặng (dựa vào số node)
    const domHeavy = document.querySelectorAll("*").length > 8000;
    const effectiveMaxMs = domHeavy ? Math.max(maxMs, maxMs * 1.5) : maxMs;

    while (Date.now() - start < effectiveMaxMs) {
      if (listData && !verifyDetailMatchesList(listData)) {
        await sleep(domHeavy ? 200 : 120);
        continue;
      }
      if (isHoursSubPanelOpen()) await exitHoursSubPanelIfNeeded();
      if (!hasVisibleOverviewContactFields()) {
        await ensureOverviewTab();
        await sleep(domHeavy ? 250 : 150);
        continue;
      }
      if (!fieldsSeenAt) fieldsSeenAt = Date.now();

      const contactRoot = findOverviewContactRoot();
      await revealAddressIntoView(contactRoot);
      await revealPhoneButton(contactRoot);

      const now = Date.now();
      const contactSignature = getOverviewContactSignature(contactRoot);
      if (contactSignature !== lastContactSignature) {
        lastContactSignature = contactSignature;
        contactStableAt = now;
      }

      const addr = readAddressFromContactButtons();
      const phone = readPhoneFromContactButtons();
      const website = readWebsite(contactRoot || getDetailPane());
      if (addr) bestAddr = pickBestAddress(bestAddr, addr);
      if (normalizePhone(phone).length >= 9) bestPhone = pickBestPhone(bestPhone, phone);
      if (website) bestWebsite = website;

      const settleTime = domHeavy ? 800 : 500;
      const settled = fieldsSeenAt && now - fieldsSeenAt > settleTime;
      const phoneElementExists = overviewContactButtonExists("phone");
      const keepWaitingForPhone = PF?.shouldKeepWaitingForPhone
        ? PF.shouldKeepWaitingForPhone({
            needPhone: true,
            phone: bestPhone,
            phoneElementExists,
            elapsedMs: now - start,
            contactFieldsAgeMs: fieldsSeenAt ? now - fieldsSeenAt : 0,
            contactStableMs: now - contactStableAt,
            minAbsentWaitMs: domHeavy ? 2400 : 1800,
            stableWaitMs: domHeavy ? 1200 : 900,
            maxMs: effectiveMaxMs
          })
        : now - fieldsSeenAt < (domHeavy ? 2400 : 1800);
      const phoneMissing = settled && !phoneElementExists && !keepWaitingForPhone;
      const addrMissing = settled && !overviewContactButtonExists("address");

      const needPhone = normalizePhone(bestPhone).length < 9 && !phoneMissing;
      const needAddr =
        (!bestAddr || !addressLooksComplete(bestAddr) || isGarbageAddressText(bestAddr)) &&
        !addrMissing;
      // Website thường hiện sau address/phone — chờ thêm ngắn nếu vẫn trống
      const needWeb =
        !bestWebsite &&
        (!settled || overviewContactButtonExists("website") || Date.now() - fieldsSeenAt < settleTime + 900);

      if (!needPhone && !needAddr && !needWeb) break;
      if (!needAddr && addressLooksComplete(bestAddr) && !needPhone && bestWebsite) break;
      if (
        !needAddr &&
        addressLooksComplete(bestAddr) &&
        normalizePhone(bestPhone).length >= 9 &&
        (bestWebsite || Date.now() - fieldsSeenAt > settleTime + 900)
      ) {
        break;
      }

      if (revealRound < 6 && Date.now() - start > 300 + revealRound * 500) {
        await revealAddressIntoView(contactRoot);
        await revealPhoneButton(contactRoot);
        revealRound++;
      }
      await sleep(domHeavy ? 150 : 120);
    }

    const stillMatch = !listData || verifyDetailMatchesList(listData);

    // Retry cuối — đọc mọi biến thể aria/data-item-id/tel: trong pane đang khớp.
    if (stillMatch && (normalizePhone(bestPhone).length < 9 || !bestAddr)) {
      const pane = getDetailPane() || findOverviewContactRoot();
      if (pane) {
        for (const btn of pane.querySelectorAll(
          `button[aria-label], ${PHONE_CONTACT_SELECTOR}`
        )) {
          const label = btn.getAttribute("aria-label") || "";
          if (!bestAddr && /^(Địa chỉ|Address)\s*:/i.test(label)) {
            const addr = label.replace(/^(Địa chỉ|Address)\s*:\s*/i, "").trim();
            if (addr.length > 5) bestAddr = pickBestAddress(bestAddr, addr);
          }
          if (normalizePhone(bestPhone).length < 9 && isPhoneContactButton(btn)) {
            const ph = parsePhoneFromContactButton(btn);
            if (normalizePhone(ph).length >= 9) bestPhone = pickBestPhone(bestPhone, ph);
          }
        }
        if (!bestWebsite) bestWebsite = readWebsite(pane);
      }
    }

    return {
      address: stillMatch ? pickBestAddress(bestAddr, readAddressFromContactButtons()) : bestAddr,
      phone: stillMatch ? bestPhone || readPhoneFromContactButtons() : bestPhone,
      website: stillMatch ? bestWebsite || readWebsite(getDetailPane()) : bestWebsite
    };
  }

  async function revealAddressIntoView(pane) {
    const selectors = [ADDRESS_CONTACT_SELECTOR];
    const roots = [pane || findOverviewContactRoot() || getDetailPane()].filter(Boolean);
    const seen = new Set();
    for (const root of roots) {
      for (const sel of selectors) {
        for (const btn of root.querySelectorAll(sel)) {
          if (seen.has(btn) || !isOverviewContactButton(btn)) continue;
          seen.add(btn);
          try {
            btn.scrollIntoView({ block: "nearest", inline: "nearest" });
            btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          } catch {}
          await sleep(80);
          return true;
        }
      }
    }
    return false;
  }

  async function revealPhoneButton(pane) {
    const selectors = PHONE_CONTACT_SELECTOR.split(", ");
    const roots = [pane || findOverviewContactRoot() || getDetailPane()].filter(Boolean);
    const seen = new Set();
    for (const root of roots) {
      for (const sel of selectors) {
        for (const btn of root.querySelectorAll(sel)) {
          if (seen.has(btn) || !isOverviewContactButton(btn)) continue;
          seen.add(btn);
          try {
            btn.scrollIntoView({ block: "nearest", inline: "nearest" });
            btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          } catch {}
          await sleep(80);
          return true;
        }
      }
    }
    return false;
  }

  function readAddressFromContactButtons() {
    return pickBestAddress(...collectAddressCandidates());
  }

  function collectPhoneCandidates() {
    const candidates = [];
    const seen = new Set();
    const selectors = PHONE_CONTACT_SELECTOR;

    const roots = [findOverviewContactRoot(), getDetailPane()].filter(Boolean);
    const triedRoots = new Set();
    for (const root of roots) {
      if (triedRoots.has(root)) continue;
      triedRoots.add(root);
      for (const btn of root.querySelectorAll(selectors)) {
        if (!btn || seen.has(btn) || !isOverviewContactButton(btn)) continue;
        seen.add(btn);
        const phone = parsePhoneFromContactButton(btn);
        if (phone) candidates.push(phone);
      }
      if (candidates.length) return candidates;
    }

    for (const btn of document.querySelectorAll(selectors)) {
      if (!btn || seen.has(btn) || !isOverviewContactButton(btn)) continue;
      seen.add(btn);
      const phone = parsePhoneFromContactButton(btn);
      if (phone) candidates.push(phone);
    }
    return candidates;
  }

  function readPhoneFromContactButtons() {
    return pickBestPhoneCandidate(...collectPhoneCandidates());
  }

  /** Dòng mô tả trên card list (thường có dấu ·) — theo cấu trúc, không theo class cố định */
  function getListMetaBlocks(item) {
    const blocks = [];
    const seen = new Set();
    const article = item.matches?.('[role="article"]') ? item : item.closest('[role="article"]') || item;
    for (const el of article.querySelectorAll("span, div")) {
      const t = (el.textContent || "").trim();
      if (t.length < 4 || t.length > 220 || seen.has(t)) continue;
      if (t.includes("·") || /^\d[.,]\d\s*\(/.test(t) || /\d[\d.,]*\s*km$/i.test(t)) {
        seen.add(t);
        blocks.push(el);
      }
    }
    for (const el of item.querySelectorAll(".W4Efsd, .rgFiGf, .UAO9ze")) {
      if (!blocks.includes(el)) blocks.push(el);
    }
    return blocks;
  }

  function readRatingFromListItem(item) {
    let rating = "";
    let reviews = "";

    for (const star of item.querySelectorAll('[role="img"][aria-label]')) {
      const aria = star.getAttribute("aria-label") || "";
      const starM = aria.match(/(\d[.,]\d)\s*(sao|stars?)/i);
      if (starM) rating = starM[1].replace(",", ".");
      const revM = aria.match(/([\d.,]+)\s*((?:bài\s+)?đánh giá|reviews?|nhận xét)/i);
      if (revM) reviews = revM[1].replace(/[,\s.]/g, "");
    }

    const rrInText = (item.textContent || "").match(/(\d[.,]\d)\s*\(([\d.,\s]+)\)/);
    if (rrInText) {
      if (!rating) rating = rrInText[1].replace(",", ".");
      if (!reviews) {
        let rv = rrInText[2].trim();
        if (/^\d{1,3}\.\d{3}$/.test(rv)) rv = rv.replace(".", "");
        reviews = rv.replace(/[,\s]/g, "");
      }
    }

    if (!rating) {
      for (const span of item.querySelectorAll('span[aria-hidden="true"]')) {
        const r = parseRatingText(span.textContent);
        if (r) {
          rating = r;
          break;
        }
      }
    }

    if (!reviews) {
      for (const s of item.querySelectorAll("span, button")) {
        const rc =
          parseReviewCountText(s.textContent) || parseReviewCountText(s.getAttribute("aria-label") || "");
        if (rc) {
          reviews = rc;
          break;
        }
      }
    }

    return { rating, reviews };
  }

  function findDetailPaneFromH1(h1) {
    if (!h1) return null;
    let el = h1.parentElement;
    for (let i = 0; i < 14 && el; i++) {
      if (el.getAttribute("role") === "feed") return null;
      if (
        el.querySelector(OVERVIEW_CONTACT_SELECTOR)
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return h1.parentElement?.parentElement;
  }

  function getDetailRoot() {
    const h1 = findDetailPaneH1();
    if (h1) {
      let el = h1.parentElement;
      for (let i = 0; i < 8 && el; i++) {
        if (el.querySelector('[role="feed"]')) break;
        if (el.querySelector(OVERVIEW_CONTACT_SELECTOR)) {
          return el;
        }
        el = el.parentElement;
      }
    }
    return (
      document.querySelector('div[role="main"]') ||
      document.querySelector(".bJzME") ||
      document.body
    );
  }

  function findDetailPaneH1() {
    // Maps giữ pane cũ trong DOM; chỉ chấp nhận H1 thật sự giao với viewport hiện tại.
    const allH1 = document.querySelectorAll("h1");
    for (const h1 of allH1) {
      if (h1.closest('[role="feed"]')) continue;
      if (h1.isConnected === false || h1.hidden || h1.closest('[aria-hidden="true"]')) continue;
      const style = window.getComputedStyle?.(h1);
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
        continue;
      }
      const text = cleanPlaceName(h1.textContent?.trim() || "");
      if (!text || text.length === 0 || isSponsoredPlace(text)) continue;
      const rect = h1.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      ) {
        return h1;
      }
    }
    return null;
  }

  function tabLabelText(el) {
    return ((el?.getAttribute("aria-label") || "") + " " + (el?.textContent || "")).trim().toLowerCase();
  }

  function isOverviewTabLabel(label) {
    const t = (label || "").trim().toLowerCase();
    return t === "tổng quan" || t === "overview" || t.startsWith("tổng quan") || t.startsWith("overview");
  }

  function isDetailNavTab(el) {
    if (!el) return false;
    const label = tabLabelText(el);
    if (el.getAttribute("role") === "tab") {
      return !isOverviewTabLabel(label);
    }
    if (el.closest('[role="tablist"]')) {
      return !isOverviewTabLabel(label);
    }
    return /^(thực đơn|menu|bài đánh giá|reviews?|giới thiệu|about|ảnh|photos?)$/.test(label);
  }

  function isPlaceSubTabButton(btn) {
    if (!btn) return false;
    const label = tabLabelText(btn);
    return (
      isOverviewTabLabel(label) ||
      /^(thực đơn|menu|bài đánh giá|reviews?|giới thiệu|about)$/.test(label)
    );
  }

  /** Hàng tab Tổng quan / Thực đơn / Bài đánh giá / Giới thiệu dưới tên quán */
  function findPlaceTabRow() {
    const h1 = findDetailPaneH1();
    if (!h1) return null;

    let node = h1.parentElement;
    for (let depth = 0; depth < 22 && node; depth++) {
      if (node.querySelector('[role="feed"]')) break;

      for (const container of node.querySelectorAll("div")) {
        if (container.closest('[role="feed"]')) continue;
        const buttons = [...container.querySelectorAll(":scope > button, :scope > div > button")].filter(
          (b) => !b.closest('[role="feed"]')
        );
        if (buttons.length < 3 || buttons.length > 8) continue;
        const labels = buttons.map(tabLabelText);
        const hasOverview = labels.some(isOverviewTabLabel);
        const hasOther = labels.some((l) => /thực đơn|menu|bài đánh giá|reviews?|giới thiệu|about/.test(l));
        if (hasOverview && hasOther) {
          return { container, buttons };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function getSelectedPlaceTab() {
    const row = findPlaceTabRow();
    if (row) {
      for (const btn of row.buttons) {
        if (btn.getAttribute("aria-selected") === "true") return btn;
        if (btn.getAttribute("aria-current") === "page") return btn;
        if (btn.getAttribute("aria-pressed") === "true") return btn;
      }

      const container = row.container;
      const indicators = [...container.querySelectorAll("div")].filter((d) => {
        const s = d.getAttribute("style") || "";
        return /left:\s*\d/.test(s) && (s.includes("width") || d.clientWidth > 8);
      });
      if (indicators.length) {
        const indicator = indicators[indicators.length - 1];
        const indLeft = parseFloat((indicator.style.left || "0").replace("px", "")) || 0;
        const cRect = container.getBoundingClientRect();
        let best = null;
        let bestDist = Infinity;
        for (const btn of row.buttons) {
          const r = btn.getBoundingClientRect();
          const center = r.left - cRect.left + r.width / 2;
          const dist = Math.abs(center - indLeft);
          if (dist < bestDist) {
            bestDist = dist;
            best = btn;
          }
        }
        if (best && bestDist < 120) return best;
      }

      for (const btn of row.buttons) {
        const fw = parseInt(window.getComputedStyle(btn).fontWeight, 10) || 400;
        if (fw >= 600) return btn;
      }
    }

    for (const tab of document.querySelectorAll('[role="tab"]')) {
      if (tab.closest('[role="feed"]')) continue;
      if (tab.getAttribute("aria-selected") === "true") return tab;
    }
    return null;
  }

  function getSelectedTabLabel() {
    const sel = getSelectedPlaceTab();
    return sel ? tabLabelText(sel) : "";
  }

  function hasPlaceTabBar() {
    return !!(findPlaceTabRow() || document.querySelector('[role="tablist"] [role="tab"]'));
  }

  function findOverviewTab() {
    const row = findPlaceTabRow();
    if (row) {
      const tab = row.buttons.find((b) => isOverviewTabLabel(tabLabelText(b)));
      if (tab) return tab;
    }
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      if (tab.closest('[role="feed"]')) continue;
      if (isOverviewTabLabel(tabLabelText(tab))) return tab;
    }
    const h1 = findDetailPaneH1();
    const scope = h1?.closest('[role="main"]') || document.querySelector('[role="main"]') || document.body;
    for (const btn of scope.querySelectorAll("button")) {
      if (btn.closest('[role="feed"]')) continue;
      if (!isPlaceSubTabButton(btn)) continue;
      if (isOverviewTabLabel(tabLabelText(btn))) return btn;
    }
    return null;
  }

  function hasVisibleOverviewContactFields() {
    const pane = findOverviewContactRoot() || getDetailPane();
    if (!pane) return false;
    const sels = [OVERVIEW_CONTACT_SELECTOR];
    for (const sel of sels) {
      for (const el of pane.querySelectorAll(sel)) {
        if (!isOverviewContactButton(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }

  /**
   * Kiểm tra một loại nút liên hệ (địa chỉ / SĐT) CÓ tồn tại trong pane không.
   * Chỉ dùng để phát hiện phần tử đã có; quyết định "không có SĐT" còn phải chờ
   * vùng liên hệ ổn định vì Maps thường render phone sau address.
   */
  function overviewContactButtonExists(kind) {
    const pane = findOverviewContactRoot() || getDetailPane();
    if (!pane) return false;
    if (kind === "website" || kind === "authority") {
      for (const el of pane.querySelectorAll(
        'a[data-item-id="authority"], a[data-item-id^="authority"], button[data-item-id="authority"], a[aria-label*="Trang web"], a[aria-label*="Website"]'
      )) {
        if (!isInSearchFeed(el)) return true;
      }
      return false;
    }
    const sel =
      kind === "phone"
        ? PHONE_CONTACT_SELECTOR
        : ADDRESS_CONTACT_SELECTOR;
    for (const el of pane.querySelectorAll(sel)) {
      if (!isOverviewContactButton(el)) continue;
      if (kind !== "phone" || isPhoneContactButton(el)) return true;
    }
    return false;
  }

  function isOverviewTabActive() {
    if (isHoursSubPanelOpen()) return false;
    if (hasPlaceTabBar()) {
      const label = getSelectedTabLabel();
      if (label) return isOverviewTabLabel(label) && hasVisibleOverviewContactFields();
      return false;
    }
    return hasVisibleOverviewContactFields();
  }

  async function ensureOverviewTab() {
    for (let attempt = 0; attempt < 6; attempt++) {
      await exitHoursSubPanelIfNeeded();
      if (isOverviewTabActive() && hasVisibleOverviewContactFields()) return true;

      const row = findPlaceTabRow();
      const tab = findOverviewTab() || row?.buttons?.[0];

      if (tab) {
        try {
          tab.scrollIntoView({ block: "nearest", inline: "center" });
          await sleep(120);
          tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          tab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          tab.click();
        } catch {}
        await sleep(450);
        await exitHoursSubPanelIfNeeded();
        if (isOverviewTabActive() && hasVisibleOverviewContactFields()) return true;
      }
      await sleep(400);
    }
    return isOverviewTabActive() && hasVisibleOverviewContactFields();
  }

  function isHoursSubPanelOpen() {
    if (isHoursSubPanelOpenByUrl()) return true;

    for (const h of document.querySelectorAll("h1, h2")) {
      if (h.closest('[role="feed"]')) continue;
      const t = cleanPlaceName(h.textContent?.trim() || "");
      if (/^giờ$/i.test(t) || /^hours$/i.test(t)) return true;
    }

    const snippet = (document.body?.innerText || "").slice(0, 2500).toLowerCase();
    if (
      /đề xuất giờ khác|suggest.*hours|đồ ăn giao tận nơi|đồ ăn mang đi/.test(snippet) &&
      !hasVisibleOverviewContactFields()
    ) {
      return true;
    }

    return false;
  }

  function isHoursSubPanelOpenByUrl() {
    const url = decodeURIComponent(window.location.href || "").toLowerCase();
    return url.includes("/place/") && /\/hours\b/.test(url);
  }

  function findHoursBackButton() {
    const selectors = [
      'button[aria-label*="Quay lại"]',
      'button[aria-label*="Trở lại"]',
      'button[aria-label*="Back"]',
      'button[jsaction*="back"]'
    ];
    for (const sel of selectors) {
      for (const btn of document.querySelectorAll(sel)) {
        if (btn.closest('[role="feed"]')) continue;
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return btn;
      }
    }
    return null;
  }

  async function exitHoursSubPanelIfNeeded() {
    if (!isHoursSubPanelOpen()) return false;

    tbLog("Đang trở về thông tin tổng quan.", "warn");

    for (let attempt = 0; attempt < 8; attempt++) {
      if (!isHoursSubPanelOpen() && hasVisibleOverviewContactFields()) return true;

      const backBtn = findHoursBackButton();
      if (backBtn) {
        try {
          backBtn.click();
        } catch {}
        await sleep(550);
        if (!isHoursSubPanelOpen()) continue;
      }

      const tab = findOverviewTab();
      if (tab) {
        try {
          tab.click();
        } catch {}
        await sleep(550);
      }

      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );
      await sleep(400);

      if (isHoursSubPanelOpenByUrl()) {
        try {
          window.history.back();
        } catch {}
        await sleep(600);
      }
    }

    const ok = !isHoursSubPanelOpen() && hasVisibleOverviewContactFields();
    if (!ok) tbLog("Chưa mở được thông tin tổng quan.", "warn");
    return ok;
  }

  async function ensureDetailOverviewReadyQuick(listData) {
    await exitHoursSubPanelIfNeeded();
    for (let attempt = 0; attempt < 10; attempt++) {
      if (listData && !verifyDetailMatchesList(listData)) {
        await sleep(120);
        continue;
      }
      const tab = findOverviewTab();
      if (tab && !isOverviewTabActive()) {
        try {
          tab.click();
        } catch {}
        await sleep(280);
      }
      if (hasVisibleOverviewContactFields()) return true;
      if (findDetailPaneH1() && !isHoursSubPanelOpen()) {
        await sleep(180);
        if (hasVisibleOverviewContactFields()) return true;
      }
      await sleep(140);
    }
    return hasVisibleOverviewContactFields();
  }

  async function ensureDetailOverviewReady(quick = false, listData = null) {
    if (quick) return ensureDetailOverviewReadyQuick(listData);
    await exitHoursSubPanelIfNeeded();
    await ensureOverviewTab();
    if (isHoursSubPanelOpen()) await exitHoursSubPanelIfNeeded();
    if (listData) {
      for (let i = 0; i < 12 && !verifyDetailMatchesList(listData); i++) {
        await sleep(120);
      }
    }
    for (let i = 0; i < 10 && !hasVisibleOverviewContactFields(); i++) {
      await sleep(150);
    }
    return isOverviewTabActive() && hasVisibleOverviewContactFields();
  }

  function readOverviewSnapshot(pane) {
    pane = pane || getDetailPane();
    if (!pane || isHoursSubPanelOpen()) {
      return { phone: "", address: "", website: "", rating: "", reviews: "" };
    }
    const scanned = extractAllFromDetailPane(pane);
    const rr = readRatingAndReviews(pane);
    return {
      phone: scanned.phone || readPhone(pane),
      address: scanned.address || readAddress(pane),
      website: scanned.website || readWebsite(pane),
      rating: scanned.rating || rr.rating || "",
      reviews: scanned.reviews || rr.reviews || ""
    };
  }

  function finalizeEnrichedRecord(base, listData, extracted) {
    const out = {
      ...base,
      name: cleanPlaceName(extracted?.name || listData?.name || base?.name),
      phone:
        typeof formatPhoneVN === "function"
          ? formatPhoneVN(pickBetterPhone(base?.phone, extracted?.phone))
          : pickBetterPhone(base?.phone, extracted?.phone),
      address: pickBestAddress(stripPhoneFromAddress(extracted?.address || ""), stripPhoneFromAddress(base?.address || "")),
      rating: pickBetterRating(
        pickBetterRating(listData?.rating, extracted?.rating),
        base?.rating
      ),
      reviews:
        typeof pickBetterReviews === "function"
          ? pickBetterReviews(
              pickBetterReviews(listData?.reviews, extracted?.reviews),
              base?.reviews
            )
          : extracted?.reviews || listData?.reviews || base?.reviews || "",
      website: extracted?.website || base?.website || listData?.website || "",
      hours: extracted?.hours || base?.hours || listData?.hours || "",
      category: listData?.category || extracted?.category || base?.category || ""
    };
    return out;
  }

  function readHoursFromOverviewButton(pane) {
    pane = pane || getDetailPane();
    if (!pane || isHoursSubPanelOpen()) return "";
    let ohBtn = pane.querySelector(
      'button[data-item-id^="oh"], [role="button"][data-item-id^="oh"], button[aria-label^="Giờ"], button[aria-label^="Hours"]'
    );
    if (!ohBtn) {
      for (const candidate of pane.querySelectorAll('button, [role="button"]')) {
        const label = candidate.getAttribute("aria-label") || "";
        const rowText = candidate.textContent || "";
        const hasHoursIcon = !!candidate.querySelector(
          '[aria-label="Giờ"], [aria-label="Hours"], [aria-label="Opening hours"]'
        );
        if (
          (hasHoursIcon || /^(Giờ|Hours?)\b/i.test(label)) &&
          isOpeningHoursText(`${label} ${rowText}`)
        ) {
          ohBtn = candidate;
          break;
        }
      }
    }
    if (!ohBtn) return "";
    const statusText =
      ohBtn.getAttribute("aria-label") ||
      ohBtn.querySelector('[data-item-id^="oh"], [id*="hour" i], [aria-label^="Giờ"], [aria-label^="Hours"]')?.textContent ||
      ohBtn.querySelector(".ZDu9vd")?.textContent ||
      queryBodyText(ohBtn);
    const hours = PF?.normalizeMapsHoursText
      ? PF.normalizeMapsHoursText(statusText)
      : String(statusText || "").replace(/\s+/g, " ").trim();
    return /^(giờ|hours?)$/i.test(hours) ? "" : hours;
  }

  function isSafeExpandButton(btn) {
    return false;
  }

  function parseRatingText(text) {
    const t = (text || "").trim().replace(",", ".");
    const m = t.match(/^(\d+(?:\.\d+)?)/);
    if (!m) return "";
    const n = parseFloat(m[1]);
    if (n >= 1 && n <= 5) return String(n);
    return "";
  }

  function parseReviewCountText(text) {
    const t = (text || "").trim();
    const kMatch = t.match(
      /^([\d.,]+)\s*([kK])(?:\s*((?:bài\s+)?đánh giá|reviews?|nhận xét))?$/i
    );
    if (kMatch) {
      const n = parseFloat(kMatch[1].replace(",", "."));
      if (!isNaN(n)) return String(Math.round(n * 1000));
    }
    const paren = t.match(/^\(([\d.,\s]+)\)$/);
    if (paren) {
      let rv = paren[1].trim();
      if (/^\d{1,3}\.\d{3}$/.test(rv)) rv = rv.replace(".", "");
      return rv.replace(/\s/g, "").replace(/,/g, "");
    }
    const label = t.match(
      /([\d.,]+)\s*([kK])?\s*((?:bài\s+)?đánh giá|reviews?|nhận xét)/i
    );
    if (label) {
      let num = label[1].replace(",", ".");
      if (label[2] && /k/i.test(label[2])) {
        const n = parseFloat(num);
        return isNaN(n) ? "" : String(Math.round(n * 1000));
      }
      if (/^\d{1,3}\.\d{3}$/.test(label[1])) return label[1].replace(".", "");
      return label[1].replace(/,/g, "");
    }
    const num = t.match(/^([\d.,]+)$/);
    if (num) {
      if (/^\d{1,3}\.\d{3}$/.test(num[1])) return num[1].replace(".", "");
      return num[1].replace(/,/g, "");
    }
    return "";
  }

  function findRatingAndReviews(h1) {
    if (!h1) return { rating: "", reviews: "" };
    let ancestor = h1.parentElement;

    for (let depth = 0; depth < 12; depth++) {
      if (!ancestor) break;
      if (ancestor.querySelector('[role="feed"]')) break;

      const fromLabels = PF?.parseMapsRatingReviewLabels?.(
        [...ancestor.querySelectorAll('[role="img"][aria-label]')].map(
          (el) => el.getAttribute("aria-label") || ""
        )
      );
      if (fromLabels?.rating && fromLabels?.reviews) return fromLabels;

      for (const span of ancestor.querySelectorAll('span[aria-hidden="true"]')) {
        const rating = parseRatingText(span.textContent);
        if (!rating) continue;

        let reviews = "";
        let reviewAncestor = span.parentElement;
        for (let i = 0; i < 6 && reviewAncestor; i++) {
          for (const s of reviewAncestor.querySelectorAll("span, button")) {
            const fromText = parseReviewCountText(s.textContent);
            if (fromText) {
              reviews = fromText;
              break;
            }
            const aria = s.getAttribute("aria-label") || "";
            const fromAria = parseReviewCountText(aria) ||
              (aria
                .match(/([\d.,]+)\s*((?:bài\s+)?đánh giá|reviews?|nhận xét)/i)?.[1]
                ?.replace(/,/g, "") || "");
            if (fromAria) {
              reviews = fromAria;
              break;
            }
          }
          if (reviews) break;
          reviewAncestor = reviewAncestor.parentElement;
        }
        return { rating, reviews };
      }

      for (const img of ancestor.querySelectorAll('[role="img"][aria-label], [role="img"]')) {
        const aria = img.getAttribute("aria-label") || "";
        const starM = aria.match(/(\d[.,]\d)\s*(sao|star)/i);
        if (starM) {
          const reviewM = aria.match(
            /([\d.,]+)\s*((?:bài\s+)?đánh giá|reviews?|nhận xét)/i
          );
          return {
            rating: starM[1].replace(",", "."),
            reviews: reviewM ? reviewM[1].replace(/,/g, "") : ""
          };
        }
      }

      ancestor = ancestor.parentElement;
    }
    return { rating: "", reviews: "" };
  }

  function unwrapGoogleUrl(href) {
    if (!href) return "";
    try {
      const u = new URL(href, window.location.origin);
      if (u.hostname.includes("google.") && u.searchParams.has("q")) {
        const q = u.searchParams.get("q");
        if (q && /^https?:\/\//i.test(q)) return q;
        if (q && q.includes(".") && !/\s/.test(q) && !/google\.com\/maps/i.test(q)) {
          return q.startsWith("http") ? q : `https://${q}`;
        }
      }
      // URL đích thật (không phải Maps) — hostname không chứa path /maps
      if (/^https?:\/\//i.test(u.href) && !/google\.[^/]*$/i.test(u.hostname)) {
        return u.href;
      }
      if (/^https?:\/\//i.test(u.href) && !/\/maps(\/|$)/i.test(u.pathname)) {
        // google.com ngoài /maps (hiếm) — bỏ qua, chỉ nhận domain ngoài
        if (!u.hostname.includes("google.")) return u.href;
      }
    } catch {}
    if (/^https?:\/\//i.test(href) && !/google\.[^/]*\/maps/i.test(href)) return href;
    return "";
  }

  function normalizeWebsiteUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/google\.[^/]*\/maps/i.test(s)) return "";
    const unwrapped = unwrapGoogleUrl(s) || s;
    if (!unwrapped || /google\.[^/]*\/maps/i.test(unwrapped)) return "";
    if (/^https?:\/\//i.test(unwrapped)) return unwrapped;
    if (unwrapped.includes(".") && !/\s/.test(unwrapped)) {
      return `https://${unwrapped.replace(/^\/+/, "")}`;
    }
    return "";
  }

  function readWebsite(scope) {
    const root = scope || getDetailPane() || document;
    const selectors = [
      'a[data-item-id="authority"]',
      'a[data-item-id^="authority"]',
      'button[data-item-id="authority"]',
      'button[data-item-id^="authority"]',
      'a[aria-label^="Trang web:"]',
      'a[aria-label^="Website:"]',
      'a[aria-label*="Trang web"]',
      'a[aria-label*="Website"]',
      'a[data-tooltip="Mở trang web"]'
    ];
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        if (isInSearchFeed(el)) continue;
        const href = el.getAttribute("href") || el.getAttribute("data-url") || "";
        const fromHref = normalizeWebsiteUrl(href);
        if (fromHref) return fromHref;

        const label = (el.getAttribute("aria-label") || "").trim();
        const fromLabel = label.replace(/^(Trang web|Website)\s*:\s*/i, "").trim();
        const labeled = normalizeWebsiteUrl(fromLabel);
        if (labeled) return labeled;

        const io =
          el.querySelector(
            '[data-item-id], [id*="website" i], [aria-label*="trang web" i], [aria-label*="website" i]'
          ) || el.querySelector(".Io6YTe, [class*='Io6YTe'], [class*='fontBody']") || el;
        const text = (io?.textContent || el.textContent || "").trim();
        const fromText = normalizeWebsiteUrl(text);
        if (fromText) return fromText;
      }
    }
    // Nút "Mở trang web" cạnh authority (cùng khối RcCsl)
    for (const a of root.querySelectorAll('a[href^="http"]')) {
      if (a.closest('[role="feed"]') || isInSearchFeed(a)) continue;
      const label = (a.getAttribute("aria-label") || a.getAttribute("data-tooltip") || "").toLowerCase();
      if (label.includes("mở trang web") || label.includes("open website") || label.includes("website") || label.includes("trang web")) {
        const u = normalizeWebsiteUrl(a.getAttribute("href") || a.href || "");
        if (u) return u;
      }
    }
    return "";
  }

  async function waitForWebsite(maxMs = 1600, scope = null, cancelMarker = null) {
    const start = Date.now();
    let best = "";
    while (Date.now() - start < maxMs) {
      throwIfEnrichCancelled(cancelMarker);
      const pane = scope || findOverviewContactRoot() || getDetailPane();
      best = readWebsite(pane) || best;
      if (best) return best;
      // Website thường nằm thấp hơn trong panel — scroll nhẹ vùng liên hệ
      try {
        const root = findOverviewContactRoot() || pane;
        const link =
          root?.querySelector('[data-item-id="authority"], [aria-label*="Trang web"], [aria-label*="Website"]') ||
          null;
        link?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      } catch {}
      await sleep(140);
    }
    throwIfEnrichCancelled(cancelMarker);
    return best || readWebsite(getDetailPane());
  }

  function readRatingAndReviews(scope) {
    const h1 = findDetailPaneH1();
    const fromH1 = findRatingAndReviews(h1);
    if (fromH1.rating) return fromH1;

    const root = scope || document;
    let rating = "";
    const ratingSelectors = [
      '[role="img"][aria-label*="sao" i], [role="img"][aria-label*="star" i]',
      '[aria-label*="sao" i], [aria-label*="star" i]',
      'span[aria-hidden="true"]',
      '[class*="fontBody"] span'
    ];
    const seenRatingNodes = new Set();
    for (const selector of ratingSelectors) {
      for (const candidate of root.querySelectorAll(selector)) {
        if (seenRatingNodes.has(candidate)) continue;
        seenRatingNodes.add(candidate);
        const aria = candidate.getAttribute?.("aria-label") || "";
        if (/^(?:sao chép|copy)\b/i.test(aria.trim())) continue;
        rating = parseRatingText(aria || candidate.textContent) || "";
        if (rating) break;
      }
      if (rating) break;
    }

    let reviews = "";
    const reviewBtn = root.querySelector(
      'button[aria-label*="đánh giá"]:not([role="tab"]), button[aria-label*="review"]:not([role="tab"]), button[aria-label*="nhận xét"]:not([role="tab"])'
    );
    if (reviewBtn && !isDetailNavTab(reviewBtn)) {
      reviews =
        parseReviewCountText(reviewBtn.getAttribute("aria-label")) ||
        parseReviewCountText(reviewBtn.textContent);
    }
    return { rating, reviews };
  }

  const END_LIST_PATTERNS = [
    /bạn đã xem hết danh sách/i,
    /đã xem hết danh sách/i,
    /xem hết danh sách này/i,
    /xem hết danh sách/i,
    /kết thúc danh sách/i,
    /hết danh sách/i,
    /you.?ve reached the end/i,
    /reached the end of the list/i,
    /end of the list/i,
    /no more results/i,
    /no results found/i,
    /không còn kết quả/i,
    /hết kết quả/i,
    /has llegado al final/i,
    /fin de la liste/i,
    /ende der liste/i,
    /リストの最後/i,
    /목록의 끝/i,
    /到达列表末尾/i
  ];

  function textHasEndMarker(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 5) return false;
    return END_LIST_PATTERNS.some((p) => p.test(t));
  }

  function isEndMarkerNearFeedEnd(feed, marker) {
    const children = Array.from(feed?.children || []);
    let directChild = marker;
    while (directChild?.parentElement && directChild.parentElement !== feed) {
      directChild = directChild.parentElement;
    }
    const directIndex = children.indexOf(directChild);
    const resultItems = getResultItems(feed);
    if (resultItems.length && directIndex >= 0) {
      const lastResult = resultItems[resultItems.length - 1];
      let lastResultDirect = lastResult;
      while (lastResultDirect?.parentElement && lastResultDirect.parentElement !== feed) {
        lastResultDirect = lastResultDirect.parentElement;
      }
      const lastResultIndex = children.indexOf(lastResultDirect);
      if (lastResultIndex >= 0 && directIndex < lastResultIndex) return false;
      if (
        lastResultIndex >= 0 &&
        directIndex === lastResultIndex &&
        (typeof marker?.compareDocumentPosition !== "function" ||
          !(marker.compareDocumentPosition(lastResult) &
            (globalThis.Node?.DOCUMENT_POSITION_PRECEDING || 2)))
      ) {
        return false;
      }
    }
    if (directIndex >= 0 && directIndex >= children.length - 5) return true;
    return false;
  }

  function hasEndMarker(feed) {
    if (!feed) return false;
    // KHÔNG check khi feed đang loading — chờ load xong trước
    if (isFeedLoading(feed)) return false;

    const candidates = [];
    const seen = new Set();
    const semanticSelectors = [
      "[data-end-of-list]",
      '[data-testid*="end-of-list" i]',
      '[data-item-id*="end_of_list" i]',
      '[data-item-id*="end-of-list" i]',
      '[id*="end_of_list" i]',
      '[id*="end-of-list" i]',
      '[role="status"]',
      '[aria-label*="end of the list" i]',
      '[aria-label*="hết danh sách" i]'
    ];
    for (const selector of semanticSelectors) {
      for (const node of feed.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    }
    // Một số Maps builds không gắn role/data cho marker; chỉ quét 5 node cuối,
    // tránh bắt chữ "hết danh sách" nằm trong nội dung một card ở giữa feed.
    const tailChildren = Array.from(feed.children || []).slice(-5);
    for (const child of tailChildren) {
      if (child.matches?.('[role="article"]')) continue;
      if (String(child.textContent || "").trim().length <= 180) {
        if (!seen.has(child)) {
          seen.add(child);
          candidates.push(child);
        }
      }
      for (const node of child.querySelectorAll?.('[role="status"], [aria-label], [data-item-id], [id], p, span') || []) {
        if (seen.has(node) || node.closest?.('[role="article"]')) continue;
        if (String(node.textContent || node.getAttribute?.("aria-label") || "").trim().length > 180) continue;
        seen.add(node);
        candidates.push(node);
      }
    }
    // Class của Maps chỉ là fallback; nội dung vẫn phải khớp end-marker đã biết.
    for (const node of feed.querySelectorAll('p.fontBodyMedium, p[class*="fontBodyMedium"]')) {
      if (seen.has(node)) continue;
      seen.add(node);
      candidates.push(node);
    }

    for (const candidate of candidates) {
      const legacyText = candidate.querySelector?.("span.HlvSq")?.textContent || "";
      const texts = [
        candidate.getAttribute?.("aria-label") || "",
        candidate.getAttribute?.("data-end-of-list") || "",
        candidate.getAttribute?.("data-testid") || "",
        candidate.getAttribute?.("data-item-id") || "",
        candidate.getAttribute?.("id") || "",
        legacyText,
        candidate.textContent || ""
      ];
      const normalizedTexts = texts.map((text) => String(text || "").replace(/[_-]+/g, " "));
      const explicitEndFlag =
        candidate.hasAttribute?.("data-end-of-list") &&
        !/^(?:false|0|off)$/i.test(candidate.getAttribute("data-end-of-list") || "");
      const semanticAttributeEnd = normalizedTexts.some((text) =>
        /\b(?:end of (?:the )?list|no more results|hết danh sách)\b/i.test(text)
      );
      if (!explicitEndFlag && !semanticAttributeEnd && !normalizedTexts.some(textHasEndMarker)) continue;
      if (isEndMarkerNearFeedEnd(feed, candidate)) return true;
    }

    return false;
  }

  function isFeedLoading(feed) {
    if (!feed) return false;
    const main = feed.closest('[role="main"]') || document.querySelector('[role="main"]') || document;
    if (main.querySelector('[role="progressbar"]')) return true;
    if (feed.querySelector('[role="progressbar"]')) return true;
    const busy = main.querySelector('[aria-busy="true"]');
    if (busy && feed.contains(busy)) return true;
    const snippet = (feed.innerText || "").slice(0, 800).toLowerCase();
    if (/\b(đang tải|loading)\b/.test(snippet)) return true;
    const tail = (feed.innerText || "").slice(-500).toLowerCase();
    if (/\b(đang tải thêm|loading more|tải thêm|fetching)\b/.test(tail)) return true;
    for (const art of feed.querySelectorAll('div[role="article"]')) {
      if (art.querySelector("a[href*='/maps/place']")) continue;
      const t = (art.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 4) return true;
    }
    return false;
  }

  /** Chờ sau cuộn: hết spinner + số dòng & chiều cao list ổn định trước khi đọc DOM. */
  async function waitForFeedContentReady(feed, maxMs = 6000, deadline = Infinity) {
    if (!feed) return false;
    const start = Date.now();
    const effectiveDeadline = Math.min(
      start + Math.max(0, Number(maxMs) || 0),
      Number.isFinite(deadline) ? deadline : Infinity
    );
    let lastCount = -1;
    let lastHeight = -1;
    let stableRounds = 0;

    while (Date.now() < effectiveDeadline) {
      if (isAborted) return false;
      feed = getFeedPanel() || feed;
      if (!feed?.isConnected) return false;

      if (isFeedLoading(feed)) {
        const remainingMs = Math.max(0, effectiveDeadline - Date.now());
        if (!remainingMs) break;
        await waitForFeedSettled(feed, Math.min(4000, remainingMs), effectiveDeadline);
        stableRounds = 0;
        lastCount = -1;
        lastHeight = -1;
        continue;
      }

      const count = getResultItems(feed).length;
      const height = feed.scrollHeight;

      if (count > 0 && count === lastCount && height === lastHeight) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastCount = count;
        lastHeight = height;
      }

      // Ổn định 2 lần → OK
      if (stableRounds >= 2) {
        const remainingMs = Math.max(0, effectiveDeadline - Date.now());
        if (!remainingMs) break;
        await sleep(Math.min(150, remainingMs));
        if (!isFeedLoading(feed)) return true;
        stableRounds = 1;
      }

      const remainingMs = Math.max(0, effectiveDeadline - Date.now());
      if (!remainingMs) break;
      await sleep(Math.min(180, remainingMs));
    }

    return !isAborted && !isFeedLoading(feed);
  }

  async function waitForFeedSettled(feed, maxMs = 5000, deadline = Infinity) {
    const start = Date.now();
    const effectiveDeadline = Math.min(
      start + Math.max(0, Number(maxMs) || 0),
      Number.isFinite(deadline) ? deadline : Infinity
    );
    while (Date.now() < effectiveDeadline) {
      if (!isFeedLoading(feed)) {
        const remainingMs = Math.max(0, effectiveDeadline - Date.now());
        if (!remainingMs) break;
        await sleep(Math.min(120, remainingMs));
        if (!isFeedLoading(feed)) return true;
      }
      const remainingMs = Math.max(0, effectiveDeadline - Date.now());
      if (!remainingMs) break;
      await sleep(Math.min(200, remainingMs));
    }
    return !isFeedLoading(feed);
  }

  /** Cuộn tới đáy và chờ Google Maps render thông báo "hết danh sách". */
  async function nudgeFeedToBottom(feed, settleMs = 4000) {
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    await sleep(250);
    if (isFeedLoading(feed)) await waitForFeedSettled(feed, settleMs);
    feed.scrollTop = Math.max(0, feed.scrollHeight - Math.max(feed.clientHeight * 0.3, 150));
    await sleep(200);
    feed.scrollTop = feed.scrollHeight;
    await sleep(300);
    if (isFeedLoading(feed)) await waitForFeedSettled(feed, settleMs);
  }

  function feedScrollStep(feed, ratio = 0.55, minPx = 220) {
    return Math.max(feed.clientHeight * ratio, minPx);
  }

  function findListItemForPlace(place, feed) {
    if (!feed || !place) return null;
    const slug = getPlaceSlug(place.href || place.mapsUrl || "");
    const name = normalizeName(place.name);
    for (const item of getResultItems(feed)) {
      const ld = extractListItemData(item);
      if (!ld?.name) continue;
      if (slug && getPlaceSlug(ld.href) === slug) return item;
      if (name && normalizeName(ld.name) === name) return item;
      if (isNearDuplicate(place, ld)) return item;
    }
    return null;
  }

  async function scrollToFindListItem(place, feed, maxMs = 22000) {
    feed = getFeedPanel() || feed;
    if (!feed) return null;

    let item = findListItemForPlace(place, feed);
    if (item) {
      feed.scrollTop = Math.max(0, item.offsetTop - 80);
      await sleep(T.click);
      return item;
    }

    feed.scrollTop = 0;
    await sleep(T.scrollInit);
    const start = Date.now();

    for (let attempt = 0; attempt < 50 && Date.now() - start < maxMs; attempt++) {
      if (isAborted) return null;
      feed = getFeedPanel();
      if (!feed) return null;

      item = findListItemForPlace(place, feed);
      if (item) {
        feed.scrollTop = Math.max(0, item.offsetTop - 80);
        await sleep(T.click);
        return item;
      }

      const maxScroll = Math.max(0, feed.scrollHeight - feed.clientHeight);
      const atBottom = feed.scrollTop >= maxScroll - 40;
      if (atBottom) {
        await nudgeFeedToBottom(feed, Math.min(7000, maxMs - (Date.now() - start)));
        item = findListItemForPlace(place, feed);
        if (item) {
          feed.scrollTop = Math.max(0, item.offsetTop - 80);
          await sleep(T.click);
          return item;
        }
        if (hasEndMarker(feed)) break;
      }

      const step = feedScrollStep(feed, 0.42, 180);
      feed.scrollTop = atBottom ? feed.scrollHeight : Math.min(feed.scrollTop + step, feed.scrollHeight);
      await waitForFeedContentReady(feed, Math.min(9000, maxMs - (Date.now() - start)));
    }
    return null;
  }

  /**
   * Xác thực CHẶT: panel chi tiết đang mở có đúng là quán trong list không.
   *
   * Nguyên nhân "địa chỉ/SĐT lung tung": trước đây hàm này khớp quá lỏng
   * (urlMatchesPlace fallback về bất kỳ URL có tọa độ, namesLikelyMatch khớp
   * theo tiền tố 6 ký tự) nên khi Maps chưa chuyển xong sang quán mới, code đọc
   * nhầm pane của quán TRƯỚC. Giờ ưu tiên so khớp slug /maps/place/<slug> —
   * slug có mặt ở cả href trong list lẫn URL chi tiết và khác nhau giữa các quán.
   */
  function verifyDetailMatchesList(listData) {
    if (!listData?.name) return true;

    const expSlug = normalizeName(getPlaceSlug(listData.href || listData.mapsUrl || ""));
    const urlSlug = normalizeName(getPlaceSlug(window.location.href));
    if (expSlug && urlSlug) return expSlug === urlSlug;

    // Chưa có slug (VD còn ở URL search) — so canonical id (ChIJ.../slug).
    const expectedCid = (getCanonicalPlaceId(listData.href || "") || listData.googlePlaceId || "").toLowerCase();
    const urlCid = getCanonicalPlaceId(window.location.href).toLowerCase();
    if (expectedCid && urlCid) return expectedCid === urlCid;

    // Fallback cuối: khớp tên H1 chi tiết một cách chặt (không dùng tiền tố ngắn).
    const h1 = findDetailPaneH1();
    return !!(h1?.textContent && strictNameMatch(h1.textContent, listData.name));
  }

  function getResultItems(feed) {
    let items = Array.from(feed.querySelectorAll('div[role="article"]')).filter((el) =>
      el.querySelector("a[href*='/maps/place']")
    );
    if (items.length > 0) return items;

    const seen = new Set();
    items = [];
    for (const link of feed.querySelectorAll("a[href*='/maps/place']")) {
      const row =
        link.closest('[role="article"]') ||
        link.closest('[jsaction]') ||
        link.parentElement?.parentElement?.parentElement;
      if (row && !seen.has(row)) {
        seen.add(row);
        items.push(row);
      }
    }
    return items;
  }

  function getPlaceId(href) {
    return getGooglePlaceId(href) || (href ? href.split("?")[0] : "");
  }

  function getPlaceSlug(url) {
    if (!url) return "";
    try {
      const m = decodeURIComponent(url).match(/\/maps\/place\/([^/@?]+)/);
      if (m) return decodeURIComponent(m[1]).toLowerCase().replace(/\+/g, " ").trim();
    } catch {}
    return "";
  }

  function urlMatchesPlace(url, listData) {
    if (!url || !url.includes("/place/")) return false;
    const slugA = getPlaceSlug(listData?.href || "");
    const slugB = getPlaceSlug(url);
    if (slugA && slugB && slugA === slugB) return true;

    const expectedCid =
      getCanonicalPlaceId(listData?.href || "") || listData?.googlePlaceId || "";
    const urlCid = getCanonicalPlaceId(url);
    if (expectedCid && urlCid && expectedCid.toLowerCase() === urlCid.toLowerCase()) {
      return true;
    }

    const h1 = findDetailPaneH1();
    if (h1 && listData?.name && namesLikelyMatch(h1.textContent, listData.name)) {
      return true;
    }
    return !!extractCoordsFromUrl(url);
  }

  function collectCoordCandidates() {
    const candidates = [];
    const seen = new Set();
    const add = (c) => {
      if (!c || c.lat == null || c.lng == null || isNaN(c.lat)) return;
      const key = `${c.lat.toFixed(5)}|${c.lng.toFixed(5)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(c);
    };

    add(extractCoordsFromUrl(window.location.href));
    const root = getDetailRoot();
    const shareInput =
      root?.querySelector('input[readonly][value*="maps"]') ||
      root?.querySelector('input[value*="!3d"]');
    if (shareInput?.value) add(extractCoordsFromUrl(shareInput.value));
    return candidates;
  }

  function pickValidCoords(candidates, centerLat, centerLng, radiusKm) {
    for (const c of candidates) {
      if (!c || c.lat == null || c.lng == null || isNaN(c.lat)) continue;
      if (centerLat != null && centerLng != null && radiusKm != null) {
        const dist = haversineDistance(centerLat, centerLng, c.lat, c.lng);
        if (dist > radiusKm + 0.2) continue;
      }
      return { lat: c.lat, lng: c.lng, exact: true };
    }
    return null;
  }

  async function waitForPlaceCoords(listData, searchParams, maxMs = T.coordWait) {
    const centerLat = searchParams?.lat;
    const centerLng = searchParams?.lng;
    const radiusKm = searchParams?.radius;
    const start = Date.now();
    let last = null;

    while (Date.now() - start < maxMs) {
      if (!window.location.href.includes("/place/")) {
        await sleep(120);
        continue;
      }

      const picked = pickValidCoords(collectCoordCandidates(), centerLat, centerLng, radiusKm);
      if (picked) {
        if (
          last &&
          Math.abs(last.lat - picked.lat) < 0.00003 &&
          Math.abs(last.lng - picked.lng) < 0.00003
        ) {
          return picked;
        }
        last = picked;
      }
      await sleep(120);
    }

    return (
      pickValidCoords(collectCoordCandidates(), centerLat, centerLng, radiusKm) || {
        lat: null,
        lng: null,
        exact: false
      }
    );
  }

  function stripVisitedLinkSuffix(name) {
    let raw = (name || "").trim();
    if (!raw) return "";

    raw = raw.normalize("NFC");
    const parts = raw.split(/[\s·•・∙●◦\u00b7\u30fb\u2022\u2219\uff65]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const last = parts[parts.length - 1].normalize("NFD");
      // "đ" không có decomposition NFD (không tách được dấu) — phải thay tay trước khi so khớp.
      if (/duong\s+lien\s+ket|visited\s+link/i.test(last.replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d"))) {
        raw = parts.slice(0, -1).join(" ").trim();
      }
    }

    raw = raw
      .replace(/[\s·•・∙●◦\-–—]*đường\s+liên\s+kết\s+đã\s+truy\s*cập.*$/giu, "")
      .replace(/[\s·•・∙●◦\-–—]*visited\s+link.*$/giu, "")
      .trim();

    const folded = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase();
    if (/duong\s+lien\s+ket\s+da\s+truy\s+cap/.test(folded)) {
      raw = raw.replace(/[\s·•・∙●◦\-–—]*đường\s+liên\s+kết\s+đã\s+truy\s*cập.*$/giu, "").trim();
    }
    if (/visited\s+link/.test(folded)) {
      raw = raw.replace(/[\s·•・∙●◦\-–—]*visited\s+link.*$/giu, "").trim();
    }
    return raw.trim();
  }

  function cleanPlaceName(name) {
    let raw = stripVisitedLinkSuffix(name);
    if (!raw) return "";

    raw = raw
      .replace(/^được tài trợ\s*[-·•]?\s*/gi, "")
      .replace(/\s*[-·•]\s*được tài trợ\s*$/gi, "")
      .replace(/^sponsored\s*[-·•]?\s*/gi, "")
      .replace(/\s*[-·•]\s*sponsored\s*$/gi, "")
      .replace(/^quảng cáo\s*[-·•]?\s*/gi, "")
      .trim();

    return stripVisitedLinkSuffix(raw);
  }

  function namesLikelyMatch(a, b) {
    const na = normalizeName(cleanPlaceName(a));
    const nb = normalizeName(cleanPlaceName(b));
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const minLen = Math.min(na.length, nb.length);
    if (minLen >= 6 && na.slice(0, minLen) === nb.slice(0, minLen)) return true;
    return false;
  }

  /**
   * Khớp tên CHẶT — dùng để xác thực đúng quán (tránh "Tạp hóa ..." khớp lung tung).
   * Chỉ chấp nhận: bằng nhau, hoặc chuỗi ngắn (đủ dài ≥10 ký tự) nằm trọn trong chuỗi dài.
   * KHÔNG dùng khớp theo tiền tố ngắn như namesLikelyMatch.
   */
  function strictNameMatch(a, b) {
    const na = normalizeName(cleanPlaceName(a));
    const nb = normalizeName(cleanPlaceName(b));
    if (!na || !nb) return false;
    if (na === nb) return true;
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    if (shorter.length >= 10 && longer.includes(shorter)) return true;
    return false;
  }

  function isSponsoredPlace(name) {
    const n = cleanPlaceName(name).toLowerCase();
    if (!n) return true;
    return n === "được tài trợ" || n === "sponsored" || n === "quảng cáo";
  }

  function isSponsoredItem(item) {
    const t = (item.textContent || "").toLowerCase();
    if (/được tài trợ|\bsponsored\b|quảng cáo/.test(t)) return true;
    return !!item.querySelector(
      '[aria-label*="Được tài trợ"], [aria-label*="tài trợ"], [aria-label*="Sponsored"]'
    );
  }

  function getItemTrackKey(listData) {
    const cid =
      getCanonicalPlaceId(listData.href || "") ||
      getCanonicalPlaceId(listData.mapsUrl || "") ||
      listData.googlePlaceId;
    if (cid) return `cid:${String(cid).toLowerCase()}`;
    const name = normalizeName(listData.name);
    const phone = normalizePhone(listData.phone);
    if (name && phone.length >= 9) return `np:${name}|${phone}`;
    const hrefFull = listData.href || listData.mapsUrl || "";
    const coordM =
      hrefFull.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
      hrefFull.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (name && coordM) {
      return `coord:${name}|${Number(coordM[1]).toFixed(4)}|${Number(coordM[2]).toFixed(4)}`;
    }
    // Slug + tọa độ — không dùng slug trần (chuỗi cửa hàng cùng tên)
    if (hrefFull.includes("/maps/place/") && coordM) {
      const slug = hrefFull.match(/\/maps\/place\/([^/@?]+)/);
      if (slug) {
        return `place:${decodeURIComponent(slug[1]).toLowerCase()}@${Number(coordM[1]).toFixed(4)},${Number(coordM[2]).toFixed(4)}`;
      }
    }
    const addr = (listData.address || "").trim();
    if (name && addr.length > 8) return `na:${name}|${addr.slice(0, 60)}`;
    return `name:${name}|${(listData.address || "").slice(0, 40)}`;
  }

  function isAlreadyCollected(listData, seenTrack, seenKeys, seenCanonical, results) {
    if (isSponsoredPlace(listData.name)) return true;
    const track = getItemTrackKey(listData);
    if (seenTrack.has(track)) return true;
    const cid = getCanonicalPlaceId(listData.href || "") || listData.googlePlaceId;
    if (cid && seenCanonical.has(cid.toLowerCase())) return true;
    const key = getDedupeKey(listData);
    if (seenKeys.has(key)) return true;
    return results.some((r) => isNearDuplicate(r, listData));
  }

  function markCollected(listData, data, seenTrack, seenKeys, seenCanonical) {
    seenTrack.add(getItemTrackKey(listData));
    seenTrack.add(getItemTrackKey(data));
    seenKeys.add(getDedupeKey(data));
    const cid =
      getCanonicalPlaceId(data.mapsUrl || data.href || "") ||
      data.googlePlaceId ||
      getCanonicalPlaceId(listData.href || "");
    if (cid) seenCanonical.add(cid.toLowerCase());
  }

  function getDetailPane() {
    const feed = getFeedPanel();
    const h1 = findDetailPaneH1();
    const fromH1 = findDetailPaneFromH1(h1);
    if (fromH1 && (!feed || !feed.contains(fromH1))) return fromH1;

    const main = document.querySelector('[role="main"]') || document.body;
    for (const el of main.querySelectorAll("div")) {
      if (el === feed || el.getAttribute("role") === "feed") continue;
      if (feed && feed.contains(el)) continue;
      if (el.querySelector(OVERVIEW_CONTACT_SELECTOR)) return el;
    }
    return getDetailRoot();
  }

  async function revealContactButtons(pane) {
    await ensureDetailOverviewReady(true);
    const root = pane || getDetailPane();
    if (!root) return;
    await revealPhoneButton(root);
    const sels = PHONE_CONTACT_SELECTOR.split(", ");
    for (const sel of sels) {
      for (const btn of root.querySelectorAll(sel)) {
        if (btn.closest('[role="feed"]') || isDetailNavTab(btn)) continue;
        if (!isPhoneContactButton(btn)) continue;
        try {
          btn.scrollIntoView({ block: "nearest", inline: "nearest" });
          btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        } catch {}
        await sleep(60);
      }
    }
    await exitHoursSubPanelIfNeeded();
  }

  function extractAllFromDetailPane(pane) {
    if (isHoursSubPanelOpen()) {
      return { phone: "", website: "", address: "", rating: "", reviews: "" };
    }
    if (!isOverviewTabActive() && !findDetailPaneH1()) {
      return { phone: "", website: "", address: "", rating: "", reviews: "" };
    }
    pane = pane || getDetailPane();
    const out = { phone: "", website: "", address: "", rating: "", reviews: "" };
    if (!pane) return out;

    out.address = readAddressFromContactButtons(pane);
    out.phone = readPhoneFromContactButtons(pane);
    out.website = readWebsite(pane);

    if (!out.address || !out.phone || !out.website) {
      for (const el of pane.querySelectorAll("[data-item-id], a[href], button")) {
        if (isInSearchFeed(el)) continue;
        const id = (el.getAttribute("data-item-id") || "").toLowerCase();
        const href = el.getAttribute("href") || "";
        const label = el.getAttribute("aria-label") || "";

        if (!out.phone) {
          const phoneM = id.match(/phone:tel:([^;]+)/i);
          if (phoneM) out.phone = safeDecodeURIComponent(phoneM[1]);
          if (href.startsWith("tel:") && !out.phone) {
            out.phone = href.replace(/^tel:/i, "").trim();
          }
        }

        if (!out.website && (id.includes("authority") || /website|trang web|mở trang web/i.test(label))) {
          const u = normalizeWebsiteUrl(href || el.querySelector("a")?.getAttribute("href") || "");
          if (u) out.website = u;
        }

        if (!out.address && id.startsWith("address")) {
          const t = parseAddressFromContactButton(el);
          if (t) out.address = pickBestAddress(out.address, t);
        }
      }
    }

    if (!out.website) out.website = readWebsite(pane);

    const rr = readRatingAndReviews(pane);
    out.rating = rr.rating;
    out.reviews = rr.reviews;

    return out;
  }

  function isOnResultList() {
    const feed = getFeedPanel();
    if (!feed || getResultItems(feed).length === 0) return false;
    // Split-pane Maps: list vẫn hiện bên cạnh panel chi tiết — đủ để click quán tiếp.
    return true;
  }

  function isFullPagePlaceOnly() {
    const feed = getFeedPanel();
    const itemCount = feed ? getResultItems(feed).length : 0;
    return itemCount === 0 && !!findDetailPaneH1();
  }

  // Hook giữ lại để không đổi flow, nhưng tuyệt đối không xóa DOM do Google Maps sở hữu.
  function cleanupStaleDom() {
    // Google Maps owns these panes; removing host nodes can corrupt SPA navigation state.
  }

  async function prepareForNextListClick(options = {}) {
    const { searchUrl, cellLat, cellLng, cellIndex = 0, maxBackMs = 4500 } = options;

    // Dọn DOM cũ mỗi 10 lần click để tránh tràn
    if (!prepareForNextListClick._count) prepareForNextListClick._count = 0;
    prepareForNextListClick._count++;
    if (prepareForNextListClick._count % 10 === 0) {
      cleanupStaleDom();
    }

    if (isOnResultList()) return true;

    const backOk = await backToResultListBounded(maxBackMs);
    if (backOk || isOnResultList()) return true;

    if (searchUrl) {
      try {
        const target = searchUrl.split("#")[0];
        const here = window.location.href.split("#")[0];
        if (here !== target) {
          window.location.assign(searchUrl);
          await waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex, 14000);
        }
        if (isOnResultList()) {
          tbLog("Đã khôi phục danh sách kết quả.");
          return true;
        }
      } catch {}
    }

    if (!isOnResultList()) {
      tbLog("Chưa trở về được danh sách. Findmap sẽ chuyển sang điểm bán tiếp theo.", "warn");
    }
    return isOnResultList();
  }

  async function expandDetailPanel() {
    await ensureDetailOverviewReady();
  }

  async function scrollDetailPanel() {
    await ensureDetailOverviewReady();
    const pane = getDetailPane();
    if (pane) {
      try {
        pane.scrollTop = 0;
        await sleep(120);
        pane.scrollTop = pane.scrollHeight;
      } catch {}
    }
    await sleep(300);
  }

  function buildDetailRecord(listData, details, searchParams, cellLat, cellLng) {
    let data = mergePlaceData(listData, details);
    data.name = cleanPlaceName(data.name);
    data.rating = pickBetterRating(listData.rating, details.rating || data.rating);
    data.reviews = details.reviews || data.reviews || listData.reviews || "";
    data.href = data.href || listData.href;
    data._phase = "detail";

    const sanitized = sanitizePlace(
      data,
      searchParams.lat,
      searchParams.lng,
      searchParams.radius,
      cellLat,
      cellLng
    );
    if (sanitized) return sanitized;

    const fallback = sanitizeFromList(
      data,
      searchParams.lat,
      searchParams.lng,
      searchParams.radius,
      cellLat,
      cellLng,
      true
    );
    const record = fallback || { ...data };
    record.phone = data.phone || record.phone || "";
    record.website = data.website || record.website || "";
    record.address = data.address || record.address || "";
    record.rating = data.rating || listData.rating || record.rating || "";
    record.reviews = data.reviews || listData.reviews || record.reviews || "";
    record.hours = data.hours || record.hours || "";
    record.href = record.href || listData.href;
    record._phase = "detail";
    if (typeof sanitizeAddressField === "function") {
      record.address = sanitizeAddressField(record.address);
    }
    return record;
  }

  async function backToResultList(maxMs = 6500) {
    if (isOnResultList()) return true;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );

      const backBtn = document.querySelector(
        'button[aria-label="Back"], button[aria-label="Quay lại"], button[aria-label="Trở lại"], ' +
          'button[aria-label*="Quay lại"], button[aria-label*="kết quả tìm kiếm"], button[jsaction*="back"]'
      );
      if (backBtn && !backBtn.closest('[role="feed"]')) {
        backBtn.click();
      } else if (isFullPagePlaceOnly()) {
        try {
          window.history.back();
        } catch {}
      }
      await sleep(280);
      if (isOnResultList()) return true;
    }
    return isOnResultList();
  }

  async function backToResultListBounded(maxMs = 2800) {
    await Promise.race([backToResultList(maxMs), sleep(maxMs + 200)]);
    return isOnResultList();
  }

  function cleanLabel(text, prefixes) {
    let s = text || "";
    for (const p of prefixes) s = s.replace(p, "");
    return s.trim();
  }

  function readPhone(root) {
    const scopes = [];
    const detailRoot = root || getDetailRoot();
    if (detailRoot) scopes.push(detailRoot);
    const main = document.querySelector('div[role="main"]');
    if (main && !scopes.includes(main)) scopes.push(main);

    for (const scope of scopes) {
      const fromBtn = readPhoneFromContactButtons(scope);
      if (fromBtn) {
        return typeof formatPhoneVN === "function" && normalizePhone(fromBtn).length >= 9
          ? formatPhoneVN(fromBtn)
          : fromBtn;
      }

    }
    return "";
  }

  function readAddress(root) {
    const scopes = [];
    const detailRoot = root || getDetailRoot();
    if (detailRoot) scopes.push(detailRoot);
    const main = document.querySelector('div[role="main"]');
    if (main && !scopes.includes(main)) scopes.push(main);

    for (const scope of scopes) {
      const fromBtn = readAddressFromContactButtons(scope);
      if (fromBtn) return fromBtn;
    }
    return "";
  }

  async function extractContactQuick(options = {}) {
    const { needPhone = true, needAddress = true, maxMs = 2800, cancelMarker = null } = options;
    throwIfEnrichCancelled(cancelMarker);
    await ensureDetailOverviewReady(true);
    let phone = "";
    let address = "";
    let lastAddrLen = 0;
    let addrStableRounds = 0;
    let phoneRevealCount = 0;
    const start = Date.now();

    while (Date.now() - start < maxMs) {
      throwIfEnrichCancelled(cancelMarker);
      if (isHoursSubPanelOpen()) await exitHoursSubPanelIfNeeded();
      const pane = getDetailPane();

      if (needPhone && normalizePhone(phone).length < 9) {
        if (phoneRevealCount === 0 && Date.now() - start > 150) {
          await revealPhoneButton(pane);
          phoneRevealCount++;
          await sleep(140);
        } else if (phoneRevealCount === 1 && Date.now() - start > 900) {
          await revealContactButtons(pane);
          phoneRevealCount++;
          await sleep(180);
        }
        phone = pickBestPhone(
          phone,
          readPhoneFromContactButtons(pane),
          readPhone(pane)
        );
      }

      if (needAddress) {
        const cand = pickBestAddress(
          readAddressFromContactButtons(pane),
          readAddress(pane),
          ""
        );
        if (cand) address = pickBestAddress(address, cand);
        if (address.length === lastAddrLen) {
          addrStableRounds++;
        } else {
          addrStableRounds = 0;
          lastAddrLen = address.length;
        }
        if (!addressLooksComplete(address) && addrStableRounds >= 2 && Date.now() - start > 400) {
          await revealAddressIntoView(pane);
          await sleep(120);
        }
      }

      const phoneOk = !needPhone || normalizePhone(phone).length >= 9;
      const addrOk = !needAddress || addressLooksComplete(address);
      if (phoneOk && addrOk) return { phone, address };

      await sleep(75);
    }

    throwIfEnrichCancelled(cancelMarker);
    const pane = getDetailPane();
    if (needPhone && normalizePhone(phone).length < 9) {
      await revealPhoneButton(pane);
      await revealContactButtons(pane);
      phone = pickBestPhone(
        phone,
        readPhoneFromContactButtons(pane),
        readPhone(pane)
      );
    }
    if (needAddress) {
      const cand = pickBestAddress(
        readAddressFromContactButtons(pane),
        readAddress(pane),
        ""
      );
      address = pickBestAddress(address, cand);
      if (!addressLooksComplete(address)) {
        await revealAddressIntoView(pane);
        await sleep(200);
        const retry = pickBestAddress(
          address,
          readAddressFromContactButtons(getDetailPane()),
          readAddress(getDetailPane()),
          ""
        );
        address = pickBestAddress(address, retry);
      }
    }
    return { phone, address };
  }

  async function waitForContactInfo(maxMs = T.contactWait, options = {}) {
    const {
      fast = false,
      detailRetry = T.detailRetry,
      needAddress = true,
      needPhone = true,
      needWebsite = false,
      cancelMarker = null
    } = options;

    throwIfEnrichCancelled(cancelMarker);

    const pane = getDetailPane();
    let snap = readOverviewSnapshot(pane);
    let phone = needPhone
      ? pickBestPhone(readPhoneFromContactButtons(pane), snap.phone)
      : "";
    let address = needAddress ? snap.address : "";
    let website = needWebsite ? snap.website : "";

    if (phone && (!needAddress || addressLooksComplete(address)) && (!needWebsite || website)) {
      return { phone, address, website };
    }

    await ensureDetailOverviewReady(fast);
    if (needPhone && normalizePhone(phone).length < 9) {
      await revealPhoneButton(pane);
      phone = pickBestPhone(phone, readPhoneFromContactButtons(pane), readPhone(pane));
    }
    if (needAddress) {
      address = pickBestAddress(address, readAddressFromContactButtons(pane), readAddress(pane));
    }
    if (phone && (!needAddress || addressLooksComplete(address)) && (!needWebsite || website)) {
      return { phone, address, website };
    }

    await revealContactButtons(pane);

    const start = Date.now();
    const pollMs = fast ? 80 : 160;

    while (Date.now() - start < maxMs) {
      throwIfEnrichCancelled(cancelMarker);
      await exitHoursSubPanelIfNeeded();
      const activePane = getDetailPane();
      snap = readOverviewSnapshot(activePane);
      if (needPhone && normalizePhone(phone).length < 9) {
        phone = pickBestPhone(phone, snap.phone, readPhoneFromContactButtons(activePane), readPhone(activePane));
      }
      if (needAddress) {
        address = pickBestAddress(
          address,
          snap.address,
          readAddressFromContactButtons(activePane),
          readAddress(activePane)
        );
      }
      if (needWebsite && !website) {
        website = snap.website || readWebsite(activePane) || website;
      }

      if (phone && (!needAddress || addressLooksComplete(address)) && (!needWebsite || website)) break;
      if (phone && !needAddress && !needWebsite) break;
      if (phone && needAddress && addressLooksComplete(address) && (!needWebsite || website)) break;

      if (needPhone && !phone) await revealContactButtons(activePane);
      await sleep(pollMs);
    }

    for (let i = 0; i < detailRetry && needPhone && normalizePhone(phone).length < 9; i++) {
      throwIfEnrichCancelled(cancelMarker);
      await sleep(fast ? 150 : 280);
      phone = pickBestPhone(
        phone,
        readPhoneFromContactButtons(getDetailPane()),
        readOverviewSnapshot(getDetailPane()).phone
      );
    }

    if (needAddress) {
      for (let i = 0; i < (fast ? 6 : 8) && !addressLooksComplete(address); i++) {
        throwIfEnrichCancelled(cancelMarker);
        await sleep(fast ? 140 : 220);
        const retry = pickBestAddress(
          address,
          readAddressFromContactButtons(getDetailPane()),
          readAddress(getDetailPane()),
          readOverviewSnapshot(getDetailPane()).address
        );
        if (retry) address = retry;
      }
    }

    if (needWebsite && !website) {
      website = await waitForWebsite(fast ? 700 : 1200, null, cancelMarker);
    }

    throwIfEnrichCancelled(cancelMarker);
    return { phone, address, website };
  }

  function isRatingReviewText(text) {
    const t = (text || "").trim();
    if (/^\d[.,]\d\s*(\([\d.,\s]+\))?$/.test(t)) return true;
    if (/^\d[.,]\d\s*\([\d.,\s]+\)/.test(t)) return true;
    return false;
  }

  function isOpeningHoursText(text) {
    const t = (text || "").toLowerCase();
    return /mở cửa|đóng cửa|đang mở|open now|closes|opens at|24\s*giờ|mở cả ngày/i.test(t);
  }

  function isReviewSnippetText(text) {
    const t = (text || "").trim();
    if (/phố|đường|quận|huyện|phường|ngõ|ngh\.|ngách|hẻm|việt nam|vietnam|,\s*\d/i.test(t)) return false;
    if (/^["'""].*["'""]$/.test(t)) return true;
    if (t.length > 55 && /[.!?]/.test(t) && !/,\s*\d|phố|đường|quận|huyện/i.test(t)) return true;
    return false;
  }

  function isMergedNameMetaText(text, name) {
    const t = (text || "").trim();
    if (!t || !name) return false;
    const n = cleanPlaceName(name);
    if (!n) return false;
    if (!t.toLowerCase().startsWith(n.toLowerCase())) return false;
    return /\d[.,]\d\s*\(/.test(t);
  }

  function isPriceRangeText(text) {
    return /₫|\bvnd\b|\d+[\d.]*\s*đ\b/i.test(text || "");
  }

  function parseRatingReviewFromPart(part) {
    const t = (part || "").trim();
    const m = t.match(/^(\d[.,]\d)\s*\(([\d.,\s]+)\)/);
    if (!m) return null;
    let reviews = m[2].trim();
    if (/^\d{1,3}\.\d{3}$/.test(reviews)) reviews = reviews.replace(".", "");
    reviews = reviews.replace(/[,\s]/g, "");
    return { rating: m[1].replace(",", "."), reviews };
  }

  function isLikelyCategoryText(text) {
    const raw = (text || "").trim();
    if (!raw || raw.length > 90) return false;
    if (
      /,|\d{2,}|phố|đường(?!\s*đi)|quận|huyện|thành phố|thị trấn|thôn|xã|ngõ|ngách|hẻm|ward|district|street|st\.|ave|road|rd\.|vietnam|việt nam/i.test(
        raw
      )
    ) {
      return false;
    }
    const t = raw.toLowerCase();
    return (
      /^(quán|tiệm|nhà hàng|cửa hàng|khách sạn|quán cà phê|quán ăn|siêu thị|hiệu thuốc|ngân hàng|bệnh viện|trường|chợ|spa|salon|bar|pub|bakery|pharmacy|supermarket|hotel|restaurant|cafe|coffee shop|fast food|gas station|atm|gym|clinic|dentist|doctor|lawyer|florist|bookstore|electronics|furniture|clothing|jewelry|laundry|pet shop|veterinar|travel agency|insurance|post office|courier|pizza|sushi|ramen|bubble tea|milk tea|trà sữa|ăn vặt|đồ ăn|ẩm thực|tiệm bánh|tiệm tóc|tiệm nail)/i.test(
        t
      ) ||
      /\b(restaurant|cafe|coffee shop|food court|food store|shop|store|hotel|bar|bakery|takeaway|take-out|diner|bistro|steakhouse|seafood|nightclub|night club|florist|flower shop)\b/i.test(
        t
      ) ||
      /\bhoa\b/i.test(t)
    );
  }

  function readCategoryFromMapsButton(root) {
    const scope = root || getDetailPane();
    if (!scope) return "";

    const selectors = [
      'button[jsaction*=".category"]',
      'button.DkEaL[jsaction*="category"]',
      'button[jsaction*="category"]'
    ];

    for (const sel of selectors) {
      for (const btn of scope.querySelectorAll(sel)) {
        const jsaction = btn.getAttribute("jsaction") || "";
        if (!jsaction.includes("category")) continue;
        const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
        if (!text || text.length > 80) continue;
        if (isOpeningHoursText(text) || isRatingReviewText(text) || isGarbageAddressText(text)) continue;
        return text;
      }
    }

    for (const btn of scope.querySelectorAll("button.DkEaL")) {
      const jsaction = btn.getAttribute("jsaction") || "";
      if (!jsaction.includes("category")) continue;
      const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
      if (!text || text.length > 80) continue;
      if (isOpeningHoursText(text) || isRatingReviewText(text)) continue;
      return text;
    }

    return "";
  }

  function readCategoryFromListItem(item) {
    if (!item) return "";
    for (const btn of item.querySelectorAll('button[jsaction*="category"], button.DkEaL')) {
      const jsaction = btn.getAttribute("jsaction") || "";
      if (!jsaction.includes("category")) continue;
      const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
      if (text && text.length <= 80 && !isOpeningHoursText(text)) return text;
    }
    return "";
  }

  function hasReliableAddress(text) {
    const t = cleanAddressText(stripRatingSuffix(text || ""));
    if (!t || isLikelyCategoryText(t)) return false;
    if (isGarbageAddressText(t)) return false;
    if (isMapsUiChromeText(t) || isMapsUiLabel(t)) return false;
    if (addressLooksComplete(t)) return true;
    if (isStreetOnlyAddress(t)) return false;
    if (/,/.test(t) && /(việt nam|vietnam|hà nội|quận|huyện|phường|thành phố)/i.test(t)) return true;
    if (typeof isValidAddressField === "function" && isValidAddressField(t)) {
      return /,/.test(t);
    }
    return false;
  }

  function pickBestAddress(...candidates) {
    const cleaned = [];
    const complete = [];
    for (const raw of candidates) {
      let t = cleanAddressText(stripRatingSuffix(raw || ""));
      t = stripPhoneFromAddress(t);
      if (!t || isGarbageAddressText(t) || isMapsUiChromeText(t) || isMapsUiLabel(t)) continue;
      cleaned.push(t);
      if (addressLooksComplete(t)) complete.push(t);
    }
    if (complete.length) return pickLongestAddress(...complete);
    return pickLongestAddress(...cleaned);
  }

  function isLikelyAddress(text) {
    const t = stripRatingSuffix(text || "");
    if (!t || (typeof isVisitedLinkText === "function" && isVisitedLinkText(t))) return false;
    if (isRatingReviewText(t) || isPriceRangeText(t)) return false;
    if (isOpeningHoursText(t) || isReviewSnippetText(t)) return false;
    if (isMapsUiChromeText(t) || isGarbageAddressText(t)) return false;
    if (t.length < 5) return false;
    // "đường đi" = Directions trên Maps — không tính là địa chỉ
    if (
      /,|phố|đường(?!\s*đi)|đ\.|d\.|ngõ|ngách|hẻm|quận|huyện|thành phố|thị trấn|thôn|xã|ấp|khu|lô|tổ|p\.|tp\.|ward|district|việt nam|vietnam/i.test(
        t
      )
    ) {
      return true;
    }
    if (/\d+\s*(đường(?!\s*đi)|phố)/i.test(t)) return true;
    return /\d+\s+[\p{L}]{2,}/u.test(t) || /^[\p{L}][\p{L}\s.-]{4,},\s*[\p{L}]/u.test(t);
  }

  function isRelaxedAddress(text) {
    const t = cleanAddressText(stripRatingSuffix(text || ""));
    if (!t || t.length < 6) return false;
    if (isLikelyCategoryText(t)) return false;
    if (isRatingReviewText(t) || isOpeningHoursText(t) || isReviewSnippetText(t)) return false;
    if (/^\d[.,]\d\s*\(/.test(t)) return false;
    if (typeof isValidAddressField === "function" && isValidAddressField(t)) return true;
    return isLikelyAddress(t);
  }

  function stripRatingSuffix(text) {
    return (text || "")
      .replace(/\s+\d[.,]\d\s*\([\d.,\s]+\)\s*$/i, "")
      .replace(/\s+\d[.,]\d\s*$/i, "")
      .trim();
  }

  function cleanAddressText(text) {
    let t = stripRatingSuffix(text || "");
    if (isRatingReviewText(t) || isOpeningHoursText(t) || isReviewSnippetText(t)) return "";
    if (isMapsUiChromeText(t) || isMapsUiLabel(t)) return "";
    t = t
      .replace(/Đang mở cửa[^·,]*/gi, "")
      .replace(/Đóng cửa[^·,]*/gi, "")
      .replace(/Mở cửa lúc[^·,]*/gi, "")
      .replace(/Mở cả ngày/gi, "")
      .replace(/\s*·\s*/g, ", ")
      .replace(/,\s*,+/g, ", ")
      .replace(/^,\s*/, "")
      .trim();
    t = stripPhoneFromAddress(t);
    t = stripMapsUiChromeFromAddress(t);
    if (isMapsUiChromeText(t) || isMapsUiLabel(t)) return "";
    if (isGarbageAddressText(t)) return "";
    if (isLikelyCategoryText(t)) return "";
    return t;
  }

  function parseListMeta(item) {
    let category = readCategoryFromListItem(item) || "";
    let address = "";
    let listDistanceKm = null;
    let listRating = "";
    let listReviews = "";
    const listName =
      cleanPlaceName(item.querySelector("a[href*='/maps/place']")?.getAttribute("aria-label") || "") || "";
    for (const block of getListMetaBlocks(item)) {
      const parts = (block.textContent || "").split("·").map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const lower = part.toLowerCase();
        const rr = parseRatingReviewFromPart(part);
        if (rr) {
          listRating = listRating || rr.rating;
          listReviews = listReviews || rr.reviews;
          continue;
        }
        const kmM = part.match(/^(\d[\d.,]*)\s*km$/i);
        if (kmM) {
          listDistanceKm = parseFloat(kmM[1].replace(",", "."));
          continue;
        }
        const mM = part.match(/^(\d[\d.,]*)\s*m(?:ét|eter|eters)?$/i);
        if (mM && !lower.includes("km")) {
          listDistanceKm = parseFloat(mM[1].replace(",", ".")) / 1000;
          continue;
        }
        if (lower.includes("đang mở") || lower.includes("đóng cửa") || lower.includes("mở cửa")) continue;
        if (isRatingReviewText(part) || isPriceRangeText(part)) continue;
        if (isOpeningHoursText(part) || isReviewSnippetText(part)) continue;
        if (isGarbageAddressText(part) || isMergedNameMetaText(part, listName)) continue;
        if (isLikelyCategoryText(part)) {
          if (!category) category = part;
          continue;
        }
        if (isMergedNameMetaText(part, item.querySelector("a[href*='/maps/place']")?.getAttribute("aria-label") || "")) {
          continue;
        }
        if (!address && hasReliableAddress(part)) {
          address = part;
          continue;
        }
        if (
          !category &&
          !part.includes(",") &&
          part.length < 50 &&
          !isPriceRangeText(part) &&
          !/\d[.,]\d\s*\(/.test(part) &&
          !hasReliableAddress(part)
        ) {
          category = part;
        } else if (!address) {
          const streetM = part.match(/(?:^|[-–—]\s*)(\d+\s+[\p{L}\p{N}\s.-]{4,})/u);
          if (streetM && hasReliableAddress(streetM[1])) address = streetM[1].trim();
        }
      }
      if (address) break;
    }
    if (listDistanceKm == null) {
      const kmInText = (item.textContent || "").match(/(\d[\d.,]*)\s*km\b/i);
      if (kmInText) listDistanceKm = parseFloat(kmInText[1].replace(",", "."));
    }
    return {
      category,
      address: cleanAddressText(address),
      listDistanceKm,
      rating: listRating,
      reviews: listReviews
    };
  }

  function stripNameFromAddress(address, name) {
    if (!address || !name) return address || "";
    let a = stripRatingSuffix(address).trim();
    const n = cleanPlaceName(name);
    if (!n) return a;
    const lowerA = a.toLowerCase();
    const lowerN = n.toLowerCase();
    if (lowerA.startsWith(lowerN)) {
      a = a.slice(n.length).replace(/^[\s\-–—,]+/, "").trim();
    }
    return a;
  }

  function placeNeedsDetail(place, listData) {
    const hasPhone = normalizePhone(place?.phone).length >= 9;
    const hasRating = !!(place?.rating || listData?.rating);
    const hasAddress =
      addressLooksComplete(place?.address) || addressLooksComplete(listData?.address);
    return !hasPhone || !hasRating || !hasAddress;
  }

  function pickAddress(...candidates) {
    for (const c of candidates) {
      const t = cleanAddressText(stripRatingSuffix(c || ""));
      if (!t || isLikelyCategoryText(t)) continue;
      if (typeof isValidAddressField === "function" && isValidAddressField(t)) return t;
      if (isLikelyAddress(t)) return t;
    }
    for (const c of candidates) {
      const t = cleanAddressText(stripRatingSuffix(c || ""));
      if (t && hasReliableAddress(t)) return t;
    }
    return "";
  }

  function extractListItemData(item) {
    if (isSponsoredItem(item)) return null;
    const link = item.querySelector("a[href*='/maps/place']");
    if (!link) return null;
    let name = cleanPlaceName(link.getAttribute("aria-label") || "");
    if (!name) {
      const titleEl =
        item.querySelector('a[href*="/maps/place"] [class*="fontHeadline"]') ||
        item.querySelector('[class*="fontHeadline"]');
      if (titleEl?.textContent?.trim()) name = cleanPlaceName(titleEl.textContent.trim());
    }
    if (!name) name = cleanPlaceName(link.textContent?.trim() || "");
    if (!name || isSponsoredPlace(name)) return null;
    const href = link.href || "";
    const placeId = getPlaceId(href);
    const listRating = readRatingFromListItem(item);
    let rating = listRating.rating;
    let reviews = listRating.reviews;
    const meta = parseListMeta(item);
    if (!rating && meta.rating) rating = meta.rating;
    if (!reviews && meta.reviews) reviews = meta.reviews;
    let address = "";
    if (hasReliableAddress(meta.address)) {
      address = stripNameFromAddress(meta.address, name);
    }
    const rrInText = (item.textContent || "").match(/(\d[.,]\d)\s*\(([\d.,\s]+)\)/);
    if (rrInText) {
      if (!rating) rating = rrInText[1].replace(",", ".");
      if (!reviews) {
        let rv = rrInText[2].trim();
        if (/^\d{1,3}\.\d{3}$/.test(rv)) rv = rv.replace(".", "");
        reviews = rv.replace(/[,\s]/g, "");
      }
    }
    if (!address) {
      for (const part of (item.textContent || "").split(/[·\n]/)) {
        const p = part.trim();
        if (
          p &&
          hasReliableAddress(p) &&
          !isMergedNameMetaText(p, name) &&
          !isGarbageAddressText(p)
        ) {
          address = stripNameFromAddress(p, name);
          break;
        }
      }
    }
    const pinCoords = extractCoordsFromUrl(href);
    const googlePlaceId = getGooglePlaceId(href);
    const listPhone = PF?.extractPhoneFromListText
      ? PF.extractPhoneFromListText(item.textContent || "")
      : pickBestPhoneCandidate(item.textContent || "");
    return {
      placeId: googlePlaceId || placeId,
      googlePlaceId,
      name, href,
      rating,
      reviews,
      category: meta.category,
      address: hasReliableAddress(address) ? cleanAddressText(address) : "",
      phone: listPhone,
      lat: pinCoords?.lat ?? null,
      lng: pinCoords?.lng ?? null,
      listDistanceKm: meta.listDistanceKm,
      mapsUrl: pinCoords ? getPlacePageUrl(href) || buildPlaceMapsUrl(pinCoords.lat, pinCoords.lng, googlePlaceId, name) : ""
    };
  }

  async function waitForDetailPanel(listData, cancelMarker = null) {
    const start = Date.now();
    while (Date.now() - start < T.detail) {
      throwIfEnrichCancelled(cancelMarker);
      const h1 = findDetailPaneH1();
      if (h1) {
        if (!listData?.name || verifyDetailMatchesList(listData)) {
          await sleep(280);
          return true;
        }
      }
      await sleep(T.detailPoll);
    }
    return Boolean(findDetailPaneH1() && verifyDetailMatchesList(listData));
  }

  async function extractPlaceDetails(listData, searchParams, options = {}) {
    const {
      enrich = false,
      fast = false,
      quick = false,
      needAddress = true,
      needPhone = true,
      needWebsite = true,
      cancelMarker = null
    } = options;
    throwIfEnrichCancelled(cancelMarker);
    if (listData?.name && !(await waitForDetailPanel(listData, cancelMarker))) {
      throw new Error(`Thông tin chi tiết chưa khớp với điểm bán ${listData.name}.`);
    }

    const hasCoords = listData?.lat != null && listData?.lng != null && !isNaN(listData.lat);
    const hasRating = !!(listData?.rating && /\d/.test(String(listData.rating)));
    const hasReviews = !!(listData?.reviews && String(listData.reviews).replace(/\D/g, "").length > 0);
    const listAddress = hasReliableAddress(listData?.address) ? pickAddress(listData?.address) : "";
    const useQuick = !!quick;

    await ensureDetailOverviewReady(useQuick, listData);
    throwIfEnrichCancelled(cancelMarker);
    if (!useQuick && !isOverviewTabActive()) {
      await ensureDetailOverviewReady(false, listData);
      throwIfEnrichCancelled(cancelMarker);
    }
    if (isHoursSubPanelOpen()) await exitHoursSubPanelIfNeeded();

    await sleep(useQuick ? 50 : fast ? 90 : 180);

    const pane = getDetailPane();
    let snap = readOverviewSnapshot(pane);
    let phone = needPhone
      ? pickBestPhone(listData?.phone, readPhoneFromContactButtons(pane), snap.phone)
      : "";
    let detailAddress = "";
    if (needAddress) {
      detailAddress = pickBestAddress(readAddressFromContactButtons(pane), snap.address);
    }
    let address = pickBestAddress(detailAddress, hasReliableAddress(listAddress) ? listAddress : "");
    let website = needWebsite ? snap.website : "";

    const missingPhone = needPhone && normalizePhone(phone).length < 9;
    const missingAddr = needAddress && !addressLooksComplete(address);

    if (missingPhone || missingAddr) {
      if (fast || useQuick) {
        const contact = await extractContactQuick({
          needPhone: needPhone,
          needAddress: needAddress && !addressLooksComplete(address),
          maxMs: missingPhone ? (missingAddr ? 5200 : 2800) : missingAddr ? 5000 : 1200,
          cancelMarker
        });
        if (needPhone) phone = pickBestPhone(phone, contact.phone);
        if (needAddress) {
          detailAddress = pickBestAddress(detailAddress, contact.address, snap.address);
          address = pickBestAddress(detailAddress, hasReliableAddress(listAddress) ? listAddress : "");
        }
      } else {
        const contactWaitMs = enrich ? 3200 : T.contactWait;
        const contact = await waitForContactInfo(contactWaitMs, {
          fast: false,
          detailRetry: T.detailRetry,
          needAddress: missingAddr,
          needPhone: missingPhone,
          needWebsite,
          cancelMarker
        });
        if (missingPhone) phone = contact.phone || phone;
        if (needAddress) {
          detailAddress = pickBestAddress(detailAddress, contact.address, snap.address);
          address = pickBestAddress(detailAddress, hasReliableAddress(listAddress) ? listAddress : "");
        }
        if (needWebsite && !website) website = contact.website;
        snap = readOverviewSnapshot(getDetailPane());
      }
    }

    if (!phone) {
      phone = pickBestPhone(snap.phone, readPhoneFromContactButtons(getDetailPane()));
    }
    if (needAddress) {
      detailAddress = pickBestAddress(detailAddress, snap.address);
      address = pickBestAddress(detailAddress, hasReliableAddress(listAddress) ? listAddress : "");
    }
    if (needWebsite && !website) website = snap.website;

    if (typeof formatPhoneVN === "function" && normalizePhone(phone).length >= 9) {
      phone = formatPhoneVN(phone);
    }

    const nameEl = findDetailPaneH1();
    let rating = hasRating ? String(listData.rating).trim() : "";
    let reviews = hasReviews ? String(listData.reviews).trim() : "";
    if (!rating || !reviews) {
      const fromName = findRatingAndReviews(nameEl);
      rating = pickBetterRating(rating, fromName.rating);
      reviews =
        typeof pickBetterReviews === "function"
          ? pickBetterReviews(reviews, fromName.reviews)
          : reviews || fromName.reviews;
    }
    if (!rating || !reviews) {
      rating = pickBetterRating(rating, snap.rating);
      reviews =
        typeof pickBetterReviews === "function"
          ? pickBetterReviews(reviews, snap.reviews)
          : reviews || snap.reviews;
    }

    let category = listData?.category || "";
    if (!category) {
      category = readCategoryFromMapsButton(pane || getDetailPane());
    }

    if (needWebsite && !website) {
      website = await waitForWebsite(
        fast || useQuick ? 900 : 1800,
        getDetailPane(),
        cancelMarker
      );
      if (!website) website = readWebsite(getDetailPane()) || snap.website;
    }

    throwIfEnrichCancelled(cancelMarker);
    const hours = readHoursFromOverviewButton(pane);
    const pageUrl = window.location.href;
    const coords = hasCoords
      ? { lat: listData.lat, lng: listData.lng, exact: true }
      : useQuick
        ? { lat: listData.lat, lng: listData.lng, exact: false }
        : await waitForPlaceCoords(listData, searchParams, fast ? 500 : enrich ? 1800 : T.coordWait);
    throwIfEnrichCancelled(cancelMarker);
    const listedPlaceId = String(listData?.googlePlaceId || "").trim();
    const googlePlaceId =
      (/^ChIJ/i.test(listedPlaceId) ? listedPlaceId : "") ||
      getCanonicalPlaceId(listData?.href || "") ||
      getCanonicalPlaceId(pageUrl) ||
      listedPlaceId;
    const placeName = cleanPlaceName(nameEl?.textContent?.trim() || listData?.name || "");
    const mapsUrl =
      getPlacePageUrl(pageUrl) ||
      buildPlaceMapsUrl(coords?.lat, coords?.lng, googlePlaceId, placeName);
    const pinCoords =
      extractCoordsFromUrl(mapsUrl || pageUrl) ||
      (coords?.lat != null ? coords : null);

    const finalAddress = pickBestAddress(detailAddress, address, snap.address);

    return {
      name: placeName,
      rating,
      reviews,
      category,
      address:
        typeof sanitizeAddressField === "function"
          ? sanitizeAddressField(finalAddress)
          : finalAddress,
      phone,
      website,
      hours,
      lat: pinCoords?.lat ?? null,
      lng: pinCoords?.lng ?? null,
      coordsExact: !!(pinCoords?.lat != null),
      googlePlaceId,
      mapsUrl,
      listDistanceKm: listData?.listDistanceKm
    };
  }

  function mergePlaceData(listData, details) {
    const merged = {
      name: details.name || listData.name,
      rating: pickBetterRating(listData.rating, details.rating),
      reviews:
        typeof pickBetterReviews === "function"
          ? pickBetterReviews(listData.reviews, details.reviews)
          : details.reviews || listData.reviews || "",
      category: details.category || listData.category || "",
      address: pickBestAddress(details.address, listData.address),
      phone:
        typeof formatPhoneVN === "function"
          ? formatPhoneVN(pickBetterPhone(listData.phone, details.phone))
          : pickBetterPhone(listData.phone, details.phone),
      website: details.website || listData.website || "",
      hours: details.hours || listData.hours || "",
      lat: details.lat ?? listData.lat,
      lng: details.lng ?? listData.lng,
      googlePlaceId:
        details.googlePlaceId ||
        getCanonicalPlaceId(details.mapsUrl || listData.href || "") ||
        listData.googlePlaceId,
      mapsUrl: details.mapsUrl || getPlacePageUrl(listData.href) || listData.mapsUrl,
      href: listData.href,
      listDistanceKm: details.listDistanceKm ?? listData.listDistanceKm
    };
    const coords = resolvePlaceCoords(merged);
    if (coords) {
      merged.lat = coords.lat;
      merged.lng = coords.lng;
    }
    merged.placeId = merged.googlePlaceId || merged.placeId;
    return merged;
  }

  async function navigateToSearchUrl(searchUrl, cellLat, cellLng, cellIndex = 0, maxMs = 28000) {
    return waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex, maxMs);
  }

  function urlCenterMatchesCell(url, cellLat, cellLng, toleranceDeg = 0.015) {
    if (cellLat == null || cellLng == null) return true;
    const c = extractMapCenterFromUrl(url || window.location.href);
    if (!c) return false;
    return Math.abs(c.lat - cellLat) <= toleranceDeg && Math.abs(c.lng - cellLng) <= toleranceDeg;
  }

  function hashFeedUrls(urls) {
    let hash = 0xcbf29ce484222325n;
    for (const url of urls) {
      for (let i = 0; i < url.length; i++) {
        hash ^= BigInt(url.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      hash ^= 0xffn;
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
  }

  function getFeedSignature(feed = getFeedPanel()) {
    if (!feed) return "0:";
    const hrefs = [];
    const seen = new Set();
    for (const link of feed.querySelectorAll("a[href*='/maps/place']")) {
      let href = link.href || link.getAttribute("href") || "";
      try {
        const url = new URL(href, window.location.origin);
        href = `${url.origin}${url.pathname}`.replace(/\/$/, "");
      } catch {
        href = href.split(/[?#]/, 1)[0].replace(/\/$/, "");
      }
      if (!href || seen.has(href)) continue;
      seen.add(href);
      hrefs.push(href);
    }
    const count = getResultItems(feed).length;
    if (!count && !hrefs.length) return "0:";
    hrefs.sort();
    return `${count}:${hrefs.length}:${hashFeedUrls(hrefs)}`;
  }

  /** Chờ Maps tải đúng vùng — tránh đọc list cũ sau khi background chuyển URL (Apify: mỗi ô = search mới) */
  async function waitForCellFeedReady(
    searchUrl,
    cellLat,
    cellLng,
    cellIndex = 0,
    maxMs = 28000,
    totalCells = 0,
    previousFeedSignature = "",
    requireFeedChange = cellIndex > 0,
    previousFeedInstanceId = "",
    resumeFromCurrent = false
  ) {
    const start = Date.now();
    const deadline = start + Math.min(Math.max(0, Number(maxMs) || 0), CELL_FEED_WAIT_MS);
    const needsFeedChange = !!requireFeedChange;
    const baselineSignature =
      needsFeedChange ? previousFeedSignature || getFeedSignature(getFeedPanel()) : "";
    const instanceChanged =
      needsFeedChange &&
      !!previousFeedInstanceId &&
      previousFeedInstanceId !== CONTENT_INSTANCE_ID;
    let lastHeartbeat = 0;
    if (totalCells > 0) _lastKnownTotalCells = totalCells;
    const cellsHint = Math.max(1, totalCells || _lastKnownTotalCells || 1);

    const heartbeat = () => {
      const now = Date.now();
      if (now - lastHeartbeat < 1500) return;
      lastHeartbeat = now;
      const waited = Math.round((now - start) / 1000);
      const pulse = Math.min(0.12, 0.02 + waited * 0.004);
      sendProgress(
        calcProgressPercent(cellIndex, cellsHint, pulse),
        `Khu vực ${cellIndex + 1}/${cellsHint} · Đang chờ Google Maps tải danh sách · ${waited} giây`
      );
    };

    while (Date.now() < deadline) {
      if (isAborted) throw new Error("Đã hủy");
      heartbeat();
      if (urlCenterMatchesCell(window.location.href, cellLat, cellLng)) break;
      await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
    }

    let sawLoading = false;
    let stableRounds = 0;
    let lastCount = -1;
    let lastSignature = "";

    while (Date.now() < deadline) {
      if (isAborted) throw new Error("Đã hủy");
      heartbeat();

      const feed = getFeedPanel();
      if (isFeedLoading(feed)) {
        sawLoading = true;
        stableRounds = 0;
        lastCount = -1;
        await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
        continue;
      }

      const count = feed ? getResultItems(feed).length : 0;
      const signature = getFeedSignature(feed);
      const signatureChanged =
        needsFeedChange &&
        !!baselineSignature &&
        signature !== "0:" &&
        signature !== baselineSignature;
      const hasNewListEvidence =
        !needsFeedChange || sawLoading || signatureChanged || instanceChanged;
      const readyByChange = hasNewListEvidence && count > 0;

      if (count > 0) {
        const centerMatches = urlCenterMatchesCell(window.location.href, cellLat, cellLng);
        if (centerMatches && readyByChange) {
          if (count === lastCount && signature === lastSignature) {
            stableRounds++;
          } else {
            stableRounds = 0;
            lastCount = count;
            lastSignature = signature;
          }
          if (stableRounds >= 3 || (readyByChange && stableRounds >= 2)) {
            if (!resumeFromCurrent) {
              feed.scrollTop = 0;
              await sleep(Math.min(T.scrollInit, Math.max(0, deadline - Date.now())));
            }
            if (!(await waitForFeedContentReady(feed, 12000, deadline))) {
              if (isAborted) throw new Error("Đã hủy");
              continue;
            }
            const settledSignature = getFeedSignature(feed);
            const settledSignatureChanged =
              needsFeedChange &&
              !!baselineSignature &&
              settledSignature !== "0:" &&
              settledSignature !== baselineSignature;
            if (needsFeedChange && !sawLoading && !instanceChanged && !settledSignatureChanged) {
              stableRounds = 0;
              continue;
            }
            tbLog(
              `Khu vực ${cellIndex + 1}: danh sách đã tải · ${count} kết quả${signatureChanged ? " mới" : ""}`
            );
            return feed;
          }
        }
      }

      await sleep(Math.min(220, Math.max(0, deadline - Date.now())));
    }

    const feed = getFeedPanel();
    const centerMatches = urlCenterMatchesCell(window.location.href, cellLat, cellLng);
    const finalSignature = getFeedSignature(feed);
    const finalSignatureChanged =
      needsFeedChange &&
      !!baselineSignature &&
      finalSignature !== "0:" &&
      finalSignature !== baselineSignature;
    const hasNewListEvidence =
      !needsFeedChange || sawLoading || finalSignatureChanged || instanceChanged;
    if (
      feed &&
      getResultItems(feed).length > 0 &&
      centerMatches &&
      hasNewListEvidence &&
      !isFeedLoading(feed)
    ) {
      if (!resumeFromCurrent) feed.scrollTop = 0;
      tbLog(`Khu vực ${cellIndex + 1}: đang dùng danh sách hiện có sau khi chờ.`, "warn");
      return feed;
    }
    throw new Error(
      centerMatches
        ? "Không tìm thấy danh sách kết quả trên Google Maps"
        : `Google Maps chưa chuyển đúng vùng ${cellIndex + 1}`
    );
  }

  let _lastKnownTotalCells = 1;

  async function enrichPlaceOnPage(listData, searchParams, progressText, percent, options = {}) {
    const {
      fast = false,
      quick = false,
      needAddress = true,
      needPhone = true,
      cancelMarker = null
    } = options;
    throwIfEnrichCancelled(cancelMarker);
    if (!shieldEl) {
      showShield(progressText || `Bổ sung: ${listData?.name || ""}`, percent ?? 55);
    } else {
      updateShield(progressText || `Bổ sung: ${listData?.name || ""}`, percent ?? 55);
    }
    tbLog(`Đang bổ sung thông tin: ${listData?.name || "Không rõ tên"}`);

    if (!fast) {
      const panelReady = await waitForDetailPanel(listData, cancelMarker);
      if (!panelReady) {
        tbLog(`Chưa tải được thông tin chi tiết: ${listData?.name || "Không rõ tên"}`, "warn");
        await sleep(700);
      }
    } else {
      for (let i = 0; i < 8; i++) {
        throwIfEnrichCancelled(cancelMarker);
        if (findDetailPaneH1()) break;
        await sleep(100);
      }
    }
    await ensureDetailOverviewReady(quick || fast);
    throwIfEnrichCancelled(cancelMarker);

    const details = await extractPlaceDetails(listData, searchParams, {
      enrich: true,
      fast,
      quick: quick || fast,
      needAddress,
      needPhone,
      needWebsite: true,
      cancelMarker
    });
    throwIfEnrichCancelled(cancelMarker);
    const merged = finalizeEnrichedRecord(
      buildDetailRecord(listData, details, searchParams, searchParams.lat, searchParams.lng),
      listData,
      details
    );
    merged._phase = "detail";

    if (!isValidPlaceName(merged.name) || isSponsoredPlace(merged.name)) return null;

    const gotPhone = normalizePhone(merged.phone).length >= 9;
    const gotAddr = !!pickAddress(merged.address);
    tbLog(
      `${merged.name}: ${gotPhone ? "có SĐT" : "chưa có SĐT"} · ${merged.website ? "có website" : "chưa có website"} · ${merged.rating || "chưa có"} sao · ${gotAddr ? "có địa chỉ" : "chưa có địa chỉ"}`
    );
    return merged;
  }

  /** Mở chi tiết bằng click — KHÔNG dùng location.href (reload sẽ hủy content script) */
  async function openPlaceDetailFromList(listData, feed) {
    feed = feed || getFeedPanel();
    if (!feed) return null;

    let item = findListItemForPlace(listData, feed);
    if (!item) {
      item = await scrollToFindListItem(listData, feed);
    }
    if (!item) return null;

    const link = item.querySelector("a[href*='/maps/place']");
    if (!link) return null;

    feed.scrollTop = Math.max(0, item.offsetTop - 70);
    await sleep(T.click);
    link.click();
    await sleep(T.click);

    for (let i = 0; i < 28; i++) {
      if (verifyDetailMatchesList(listData)) {
        await sleep(280);
        return item;
      }
      if (i === 5 || i === 12) link.click();
      await sleep(220);
    }
    return verifyDetailMatchesList(listData) ? item : null;
  }

  async function scrapePlaceDetailByHref(
    listData,
    searchParams,
    cellIndex,
    totalCells,
    cellLabel,
    cellLat,
    cellLng,
    searchUrl
  ) {
    const opened = await openPlaceDetailFromList(listData, getFeedPanel());
    if (!opened) return null;

    const details = await extractPlaceDetails(listData, searchParams);
    const data = buildDetailRecord(listData, details, searchParams, cellLat, cellLng);
    data.address = pickBestAddress(details.address, data.address, listData.address);
    data.rating = listData.rating || data.rating || details.rating || "";
    data.reviews = listData.reviews || data.reviews || details.reviews || "";
    if (!isValidPlaceName(data.name) || isSponsoredPlace(data.name)) return null;

    await backToResultList();
    await sleep(300);
    return data;
  }

  async function scrapeItemInPlace(
    item,
    listData,
    searchParams,
    uniqueIndex,
    cellIndex,
    totalCells,
    cellLabel,
    cellLat,
    cellLng,
    options = {}
  ) {
    const {
      quiet = false,
      fast = false,
      quick = false,
      needAddress = true,
      needPhone = true,
      searchUrl = "",
      totalInCell = 0
    } = options;
    const link = item.querySelector("a[href*='/maps/place']");
    if (!link) return null;

    const feed = getFeedPanel();
    if (feed) {
      feed.scrollTop = Math.max(0, item.offsetTop - 70);
      await sleep(fast ? 120 : T.click);
    }

    if (!isOnResultList()) {
      await prepareForNextListClick({
        searchUrl,
        cellLat,
        cellLng,
        cellIndex,
        maxBackMs: fast ? 2800 : 4000
      });
      await sleep(fast ? 120 : 180);
    }

    link.click();
    await sleep(quick ? 60 : fast ? 100 : T.click);

    const openPollMs = quick ? 90 : fast ? 160 : 200;
    const openMax = quick ? 14 : fast ? 28 : 32;
    let opened = false;
    let detailMatched = false;
    for (let i = 0; i < openMax; i++) {
      detailMatched = verifyDetailMatchesList(listData);
      const addr = readAddressFromContactButtons();
      const hasFullAddr = addressLooksComplete(addr);
      const hasPhone = normalizePhone(readPhoneFromContactButtons()).length >= 9;
      const hasButtons = hasVisibleOverviewContactFields();
      const hasH1 = !!findDetailPaneH1();

      if (hasH1 && detailMatched) opened = true;
      if (detailMatched && hasButtons && (hasFullAddr || hasPhone || !!addr)) break;
      if (detailMatched && hasButtons && i >= openMax - 4) break;
      if (detailMatched && hasH1 && i >= openMax - 2) break;

      if (i === 3 || i === 8 || i === 14) link.click();
      await sleep(openPollMs);
    }

    const contactWait = { address: "", phone: "", website: "" };
    if (opened) {
      await ensureDetailOverviewReady(false, listData);
      if (needPhone) {
        await revealPhoneButton(findOverviewContactRoot());
        await sleep(quick ? 180 : 260);
      }
      Object.assign(
        contactWait,
        await waitForOverviewContactButtons(listData, fast ? 7500 : 8000)
      );
    }

    // Chỉ tin dữ liệu đọc trực tiếp từ pane khi pane khớp đúng quán đang xét.
    const paneMatches = verifyDetailMatchesList(listData);
    const liveAddr = paneMatches ? readAddressFromContactButtons() : "";
    const livePhone = paneMatches ? readPhoneFromContactButtons() : "";
    const liveWebsite = paneMatches ? readWebsite(getDetailPane()) : "";

    const hasContactData =
      !!contactWait.address ||
      normalizePhone(contactWait.phone).length >= 9 ||
      !!liveAddr ||
      normalizePhone(livePhone).length >= 9 ||
      !!contactWait.website ||
      !!liveWebsite;

    if (!opened && !hasContactData) {
      return null;
    }

    const preContact = {
      address: pickBestAddress(contactWait.address, liveAddr),
      phone: pickBestPhone(contactWait.phone, livePhone),
      website: contactWait.website || liveWebsite || ""
    };

    const details = await extractPlaceDetails(listData, searchParams, {
      enrich: true,
      fast,
      quick,
      needAddress,
      needPhone,
      needWebsite: true
    });
    details.address = pickBestAddress(preContact.address, details.address);
    details.phone = pickBestPhone(preContact.phone, details.phone);
    details.website = details.website || preContact.website || "";
    if (!details.website) {
      details.website = await waitForWebsite(fast || quick ? 800 : 1400);
    }

    // Fallback địa chỉ — bỏ qua nếu quán không có nút địa chỉ (khỏi chờ vô ích).
    if (needAddress && !details.address && overviewContactButtonExists("address")) {
      await revealAddressIntoView(findOverviewContactRoot());
      for (let i = 0; i < 6; i++) {
        await sleep(150);
        details.address = pickBestAddress(details.address, readAddressFromContactButtons());
        if (details.address) break;
        if (i === 2) await revealAddressIntoView(findOverviewContactRoot());
        if (!overviewContactButtonExists("address")) break;
      }
    }
    // Fallback SĐT — bỏ qua nếu quán không có nút SĐT.
    if (needPhone && normalizePhone(details.phone).length < 9 && overviewContactButtonExists("phone")) {
      for (let i = 0; i < 4; i++) {
        await sleep(140);
        details.phone = pickBestPhone(details.phone, readPhoneFromContactButtons());
        if (normalizePhone(details.phone).length >= 9) break;
        if (!overviewContactButtonExists("phone")) break;
      }
    }
    const data = buildDetailRecord(listData, details, searchParams, cellLat, cellLng);
    Object.assign(
      data,
      finalizeEnrichedRecord(data, listData, details)
    );
    if (!isValidPlaceName(data.name) || isSponsoredPlace(data.name)) {
      return null;
    }

    const pct = calcProgressPercent(cellIndex, totalCells, Math.min(uniqueIndex / Math.max(totalInCell, 1), 0.9));
    const posLabel =
      totalInCell > 0
        ? `ô này ${uniqueIndex}/${totalInCell}`
        : `ô này #${uniqueIndex}`;
    sendProgress(
      pct,
      `Khu vực ${cellIndex + 1}/${totalCells} · ${cellLabel || "Tâm"} · ${posLabel}: ${data.name}${data.phone ? " · Có SĐT" : ""}`
    );
    if (!quiet) sendItem(data, searchParams, uniqueIndex, uniqueIndex);

    const gotPhone = normalizePhone(data.phone).length >= 9;
    const gotAddr = !!pickAddress(data.address);
    tbLog(
      `${data.name}: ${gotPhone ? "✓SĐT" : "—SĐT"} | ${data.website ? "✓web" : "—web"} | ${data.rating || "—"} sao | ${gotAddr ? "✓địa chỉ" : "—địa chỉ"}`
    );

    await prepareForNextListClick({
      searchUrl,
      cellLat,
      cellLng,
      cellIndex,
      maxBackMs: quick ? 2000 : fast ? 2800 : 4000
    });
    await sleep(quick ? 30 : fast ? 40 : 100);
    return data;
  }

  async function enrichOneFromList(data) {
    const {
      place,
      searchParams,
      cellIndex = 0,
      cellLat,
      cellLng,
      searchUrl,
      globalIdx = 1,
      totalEnrich = 1,
      percent = 55
    } = data;

    const progressText = `Giai đoạn 2/2 — ${globalIdx}/${totalEnrich}: ${place?.name || "?"}`;
    updateShield(progressText, percent);

    const profile = typeof getEnrichProfile === "function" ? getEnrichProfile(place) : { fast: true };
    const fast = profile?.fast !== false;
    const quick = profile?.quick === true;
    const needAddress = profile?.needAddress !== false;
    const needPhone = profile?.needPhone !== false;

    let feed = getFeedPanel();
    if (!feed || !getResultItems(feed).length) {
      try {
        feed = await waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex, 16000);
      } catch {
        return { success: false, needUrlFallback: true };
      }
    }

    let item = findListItemForPlace(place, feed);
    if (!item) item = await scrollToFindListItem(place, feed, 18000);
    if (!item) {
      tbLog(`Không tìm thấy trong danh sách: ${place.name}`, "warn");
      return { success: false, needUrlFallback: true };
    }

    const listData = extractListItemData(item) || place;
    try {
      const record = await scrapeItemInPlace(
        item,
        listData,
        searchParams,
        globalIdx,
        cellIndex,
        1,
        "",
        cellLat,
        cellLng,
        { quiet: true, fast, quick, needAddress, needPhone }
      );
      if (!record) {
        await backToResultListBounded(2000);
        return { success: false, needUrlFallback: true };
      }

      const merged = finalizeEnrichedRecord(
        { ...place, ...record, _phase: "detail", href: place.href || listData.href || record.href },
        listData,
        record
      );
      return { success: true, place: merged };
    } catch (err) {
      tbLog(`Chưa thể bổ sung thông tin: ${place.name} · ${err.message}`, "warn");
      await backToResultListBounded(2000);
      return { success: false, needUrlFallback: true };
    }
  }

  async function enrichPlacesBatch(data) {
    const {
      places = [],
      searchParams,
      cellIndex = 0,
      cellLat,
      cellLng,
      searchUrl,
      startIndex = 0,
      totalEnrich = places.length
    } = data;

    isAborted = false;
    showShield(
      `Đang bổ sung thông tin ${startIndex + 1}–${startIndex + places.length}/${totalEnrich}`,
      55
    );

    let feed;
    try {
      feed = await waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex, 22000);
    } catch (err) {
      tbLog(`Chưa tải được danh sách khu vực: ${err.message}`, "warn");
      return { success: false, places: [], needFallback: places };
    }

    const enriched = [];
    const needFallback = [];

    for (let i = 0; i < places.length; i++) {
      if (isAborted) break;

      const place = places[i];
      const profile = typeof getEnrichProfile === "function" ? getEnrichProfile(place) : { fast: true };
      const fast = profile?.fast !== false;
      const needAddress = profile?.needAddress !== false;
      const needPhone = profile?.needPhone !== false;
      const globalIdx = startIndex + i + 1;
      const pct = 55 + Math.round((globalIdx / totalEnrich) * 40);
      const progressText = `Đang bổ sung thông tin ${globalIdx}/${totalEnrich} · ${place.name}`;
      updateShield(progressText, pct);
      tbLog(`${fast ? "⚡" : "→"} ${place.name}`);

      let item = findListItemForPlace(place, feed);
      if (!item) item = await scrollToFindListItem(place, feed);
      if (!item) {
        tbLog(`Không thấy trong danh sách. Đang mở trực tiếp: ${place.name}`, "warn");
        needFallback.push(place);
        continue;
      }

      const listData = extractListItemData(item) || place;
      try {
        const record = await scrapeItemInPlace(
          item,
          listData,
          searchParams,
          globalIdx,
          cellIndex,
          1,
          "",
          cellLat,
          cellLng,
          { quiet: true, fast, needAddress, needPhone }
        );
        if (record) {
          const merged = {
            ...place,
            ...record,
            _phase: "detail",
            phone: pickBetterPhone(place.phone, record.phone),
            address: pickBestAddress(record.address, place.address, listData.address),
            rating: pickBetterRating(place.rating, record.rating),
            reviews: record.reviews || place.reviews || listData.reviews || "",
            website: record.website || place.website || "",
            hours: record.hours || place.hours || "",
            href: place.href || listData.href || record.href
          };
          enriched.push(merged);
          safeSend({
            action: "SEARCH_PROGRESS",
            percent: pct,
            text: `${progressText}${merged.phone ? " ✓SĐT" : ""}`
          });
        } else {
          needFallback.push(place);
        }
      } catch (err) {
        tbLog(`Chưa thể bổ sung thông tin cho ${place.name}: ${err.message}`, "warn");
        needFallback.push(place);
        await backToResultList(2500);
      }
    }

    tbLog(`Đã hoàn tất nhóm dữ liệu: ${enriched.length} điểm bán · ${needFallback.length} điểm cần thử cách khác`);
    return { success: true, places: enriched, needFallback };
  }

  function updateEndMarkerConfirmation(confirmations, state) {
    if (state.grew || state.loading || !state.endMarker) {
      return { confirmations: 0, reachedEnd: false };
    }
    const next = Math.max(0, Number(confirmations) || 0) + 1;
    return { confirmations: next, reachedEnd: next >= 2 };
  }

  const RENDERER_SUSPEND_GAP_MS = 15000;

  function createRendererSuspendTracker(now = () => Date.now()) {
    let lastObservedAt = Number(now()) || 0;
    let suspendGapMs = 0;
    let suspendCount = 0;

    return {
      observe() {
        const current = Number(now()) || lastObservedAt;
        const gapMs = Math.max(0, current - lastObservedAt);
        lastObservedAt = current;
        if (gapMs >= RENDERER_SUSPEND_GAP_MS) {
          suspendGapMs += gapMs;
          suspendCount++;
          return true;
        }
        return false;
      },
      snapshot() {
        return {
          suspendDetected: suspendCount > 0,
          suspendGapMs,
          suspendCount
        };
      }
    };
  }

  function scrollFeedInstantly(feed, delta) {
    if (!feed) return { before: 0, after: 0 };
    const before = Number(feed.scrollTop || 0);
    const maxScroll = Math.max(0, Number(feed.scrollHeight || 0) - Number(feed.clientHeight || 0));
    const target = Math.max(0, Math.min(maxScroll, before + Number(delta || 0)));
    const style = feed.style;
    const previousScrollBehavior = style?.scrollBehavior;

    try {
      // Đặt setter trước để chuyển động không phụ thuộc CSS scroll-behavior của Maps.
      if (Math.abs(target - before) > 1 || typeof feed.scrollBy !== "function") {
        feed.scrollTop = target;
      } else if (style) {
        style.scrollBehavior = "auto";
      }
      if (target === before && typeof feed.scrollBy === "function") {
        feed.scrollBy({ top: delta, behavior: "auto" });
      }
    } catch {
      feed.scrollTop = target;
    } finally {
      if (style) style.scrollBehavior = previousScrollBehavior || "";
    }

    // Maps/CSS có thể bỏ qua scrollBy ở tab nền; setter là bước dự phòng đồng bộ.
    if (Math.abs(Number(feed.scrollTop || 0) - target) > 1) {
      feed.scrollTop = target;
    }
    return { before, after: Number(feed.scrollTop || 0), target };
  }

  async function scrollFeed(feed, onItems, options = {}) {
    const {
      requireEndMarker = true,
      safetyMax = 240,
      maxMs = CELL_SCROLL_CHUNK_MS,
      fastScroll = false,
      onProgress = null,
      resumeFromCurrent = false
    } = options;
    const scrollPause = fastScroll ? 180 : Math.max(T.scroll, 220);
    const scrollInitPause = fastScroll ? 80 : T.scrollInit;
    const staleLimit = fastScroll ? 10 : 14;
    const settleMs = fastScroll ? 3000 : 5000;
    const endConfirmMs = fastScroll ? 1200 : 1800;
    const stepRatio = fastScroll ? 0.72 : 0.58;
    const stepMin = fastScroll ? 300 : 240;
    let lastTotal = 0;
    let staleBottomRounds = 0;
    let lastScrollHeight = 0;
    let endMarkerConfirmations = 0;
    let reachedEnd = false;
    let reason = "safety_limit";
    let rounds = 0;
    let lastItemKey = "";
    const scrollStart = Date.now();
    const suspendTracker = createRendererSuspendTracker();
    let suspendDetected = false;
    const scrollDeadline =
      scrollStart + Math.min(Math.max(0, Number(maxMs) || 0), CELL_SCROLL_CHUNK_MS);
    const initialScrollTop = Math.max(0, Number(feed?.scrollTop) || 0);
    const initialScrollHeight = Math.max(0, Number(feed?.scrollHeight) || 0);
    const observeSuspend = () => {
      if (suspendTracker.observe()) suspendDetected = true;
      return suspendDetected;
    };
    const rememberFound = (found) => {
      if (!found) return;
      if (found.lastItemKey) lastItemKey = String(found.lastItemKey);
    };
    const pauseBeforeDeadline = async (ms) => {
      const remainingMs = Math.max(0, scrollDeadline - Date.now());
      if (!remainingMs) return false;
      await sleep(Math.min(ms, remainingMs));
      observeSuspend();
      return !suspendDetected && Date.now() < scrollDeadline;
    };
    feed = getFeedPanel() || feed;
    if (feed && !resumeFromCurrent) {
      feed.scrollTop = 0;
      await pauseBeforeDeadline(scrollInitPause);
      await waitForFeedContentReady(feed, settleMs, scrollDeadline);
    }

    for (let round = 0; round < safetyMax; round++) {
      rounds = round + 1;
      if (isAborted) {
        reason = "aborted";
        break;
      }
      if (observeSuspend()) {
        reason = "renderer_suspended";
        break;
      }
      if (Date.now() >= scrollDeadline) {
        tbLog(`Đã dừng tải thêm sau ${Math.round((scrollDeadline - scrollStart) / 1000)} giây.`);
        reason = "chunk_budget";
        break;
      }

      feed = getFeedPanel();
      if (!feed?.isConnected) {
        try {
          feed = await waitForFeed(
            Math.min(5000, Math.max(0, scrollDeadline - Date.now())),
            scrollDeadline
          );
        } catch {
          reason = observeSuspend() ? "renderer_suspended" : "feed_missing";
          break;
        }
      }
      if (!feed) {
        reason = "feed_missing";
        break;
      }

      await waitForFeedContentReady(feed, settleMs, scrollDeadline);
      if (observeSuspend()) {
        reason = "renderer_suspended";
        break;
      }
      if (Date.now() >= scrollDeadline) {
        reason = "chunk_budget";
        break;
      }

      const found = await onItems(feed, round);
      rememberFound(found);
      if (typeof onProgress === "function") onProgress(found.total, round);

      const maxScroll = Math.max(0, feed.scrollHeight - feed.clientHeight);
      const atBottom = feed.scrollTop >= maxScroll - 40;

      if (feed.scrollHeight > lastScrollHeight + 30) {
        staleBottomRounds = 0;
        endMarkerConfirmations = 0;
        lastScrollHeight = feed.scrollHeight;
      }

      if (found.total > lastTotal) {
        lastTotal = found.total;
        staleBottomRounds = 0;
        endMarkerConfirmations = 0;
      } else if (atBottom) {
        staleBottomRounds++;
      }

      if (atBottom) {
        const beforeTotal = found.total;
        const beforeHeight = feed.scrollHeight;

        // Wheel thật ở đáy vẫn phát ý định cuộn. Dùng auto để không phụ thuộc animation bị
        // Chrome đóng băng khi tab ẩn; nếu Maps chưa phản ứng thì lùi nhẹ rồi cuộn lại đáy.
        const bottomNudge = Math.max(48, Math.round(feed.clientHeight * 0.18));
        scrollFeedInstantly(feed, bottomNudge);
        if (!isFeedLoading(feed)) {
          scrollFeedInstantly(feed, -Math.min(32, Math.max(16, bottomNudge * 0.2)));
          await pauseBeforeDeadline(40);
          scrollFeedInstantly(feed, bottomNudge);
        }
        await pauseBeforeDeadline(scrollPause + 120);
        await waitForFeedContentReady(feed, settleMs, scrollDeadline);
        if (observeSuspend()) {
          reason = "renderer_suspended";
          break;
        }
        if (Date.now() >= scrollDeadline) {
          reason = "chunk_budget";
          break;
        }

        const afterNudge = await onItems(feed, round);
        rememberFound(afterNudge);
        const grew =
          afterNudge.total > beforeTotal ||
          feed.scrollHeight > beforeHeight + 30;

        if (grew || isFeedLoading(feed)) {
          lastTotal = Math.max(lastTotal, afterNudge.total || 0);
          staleBottomRounds = 0;
          endMarkerConfirmations = 0;
          await pauseBeforeDeadline(scrollPause);
          continue;
        }

        const endState = updateEndMarkerConfirmation(endMarkerConfirmations, {
          grew,
          loading: isFeedLoading(feed),
          endMarker: hasEndMarker(feed)
        });
        endMarkerConfirmations = endState.confirmations;
        if (endMarkerConfirmations > 0) {
          tbLog(
            `Đã thấy cuối danh sách · ${afterNudge.total} điểm bán · ` +
              `xác nhận ${endMarkerConfirmations}/2`
          );
          if (endState.reachedEnd) {
            reachedEnd = true;
            reason = "end_marker";
            lastTotal = Math.max(lastTotal, afterNudge.total || 0);
            break;
          }
          await pauseBeforeDeadline(endConfirmMs);
          continue;
        }

        endMarkerConfirmations = 0;
        if (!requireEndMarker && staleBottomRounds >= staleLimit && afterNudge.total > 0) {
          reachedEnd = true;
          reason = "stable_bottom";
          lastTotal = Math.max(lastTotal, afterNudge.total || 0);
          break;
        }

        // Không có end marker thì vẫn tiếp tục. Maps có thể đứng vài nhịp rồi mới nạp đợt kế tiếp.
        await pauseBeforeDeadline(scrollPause + Math.min(1200, staleBottomRounds * 80));
        continue;
      }

      const step = feedScrollStep(feed, stepRatio, stepMin);
      scrollFeedInstantly(feed, step);
      await pauseBeforeDeadline(scrollPause);
    }

    // Sau khi renderer thức lại, đọc DOM hiện tại một lần trước khi trả về để không
    // làm mất các URL Maps đã lazy-load trong lúc service worker/tab bị treo.
    if (suspendDetected && !isAborted && !reachedEnd) {
      feed = getFeedPanel() || feed;
      if (feed?.isConnected) {
        try {
          const finalFound = await onItems(feed, rounds);
          rememberFound(finalFound);
          lastTotal = Math.max(lastTotal, Math.max(0, Number(finalFound.total) || 0));
          if (typeof onProgress === "function") onProgress(finalFound.total, rounds);
        } catch {}
      }
      reason = "renderer_suspended";
    }

    const finalScrollTop = Math.max(0, Number(feed?.scrollTop) || 0);
    const finalScrollHeight = Math.max(0, Number(feed?.scrollHeight) || 0);
    const suspendState = suspendTracker.snapshot();
    return {
      feed,
      reachedEnd,
      reason,
      total: lastTotal,
      newPlacesCount: lastTotal,
      startScrollTop: initialScrollTop,
      startScrollHeight: initialScrollHeight,
      scrollTop: finalScrollTop,
      scrollHeight: finalScrollHeight,
      lastItemKey,
      progressed:
        lastTotal > 0 ||
        finalScrollTop > initialScrollTop + 1 ||
        finalScrollHeight > initialScrollHeight + 1,
      continuationRecommended:
        !reachedEnd && (reason === "chunk_budget" || reason === "renderer_suspended"),
      ...suspendState,
      rounds,
      elapsedMs: Date.now() - scrollStart,
      activeElapsedMs: Math.max(0, Date.now() - scrollStart - suspendState.suspendGapMs)
    };
  }

  async function enrichAllWithDetails(
    results,
    searchParams,
    cellIndex,
    totalCells,
    cellLabel,
    mapLat,
    mapLng
  ) {
    let clickAttempts = 0;
    let enriched = 0;

    for (let i = 0; i < results.length; i++) {
      if (isAborted) break;
      const existing = results[i];
      const phoneOk = normalizePhone(existing.phone).length >= 9;

      let item = await scrollToFindListItem(existing, getFeedPanel());
      if (!item) {
        console.warn(`TimDiemBan: không tìm thấy trong list: ${existing.name}`);
        if (!phoneOk) {
          existing.rating = existing.rating || "";
          sendItem(existing, searchParams, i + 1, results.length);
        }
        continue;
      }

      const listData = extractListItemData(item) || existing;
      if (phoneOk && existing.website && existing.rating) continue;

      clickAttempts++;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await scrapeItemInPlace(
            item,
            listData,
            searchParams,
            i + 1,
            cellIndex,
            totalCells,
            cellLabel,
            mapLat,
            mapLng,
            { quiet: true }
          );
          if (data) {
            mergePlaceRecord(existing, data);
            existing._phase = "detail";
            existing.href = existing.href || listData.href;
            existing.rating = data.rating || listData.rating || existing.rating || "";
            existing.reviews = data.reviews || listData.reviews || existing.reviews || "";
            existing.phone = data.phone || existing.phone || "";
            existing.website = data.website || existing.website || "";
            sendItem(existing, searchParams, i + 1, results.length);
            enriched++;
            break;
          }
          if (attempt === 0) {
            await backToResultList();
            item = await scrollToFindListItem(existing, getFeedPanel());
            if (!item) break;
          }
        } catch (err) {
          console.warn("Enrich item:", err);
          await backToResultList();
        }
      }
    }

    return { clickAttempts, enriched };
  }

  async function scrollAndScrapePlaces(
    feed,
    searchParams,
    cellIndex,
    totalCells,
    globalSeen = [],
    cellLabel = "Tâm",
    cellLat = null,
    cellLng = null,
    searchUrl = "",
    previousFeedSignature = "",
    requireFeedChange = cellIndex > 0,
    previousFeedInstanceId = "",
    resumeFromCurrent = false
  ) {
    const seenTrack = new Set(globalSeen);
    const seenKeys = new Set(
      globalSeen.filter((k) =>
        /^(np:|na:|coord:|fb:|cid:)/.test(k)
      )
    );
    const seenCanonical = new Set(
      globalSeen
        .filter((k) => k.startsWith("cid:"))
        .map((k) => k.slice(4).toLowerCase())
    );
    const results = [];
    let skippedCount = 0;
    const fastMode = !!searchParams.fastMode;
    const tCellStart = Date.now();
    const secsSinceCellStart = () => Math.round((Date.now() - tCellStart) / 1000);

    const mapLat = cellLat ?? searchParams.lat;
    const mapLng = cellLng ?? searchParams.lng;
    const cellDist =
      mapLat != null && mapLng != null
        ? haversineDistance(searchParams.lat, searchParams.lng, mapLat, mapLng)
        : 0;

    if (!feed?.isConnected || !getResultItems(feed).length) {
      feed = await waitForCellFeedReady(
        searchUrl,
        mapLat,
        mapLng,
        cellIndex,
        5000,
        totalCells,
        previousFeedSignature,
        false,
        previousFeedInstanceId
      );
    }
    if (!feed) {
      try {
        feed = await waitForFeed(20000);
      } catch (err) {
        console.warn(`TimDiemBan ${cellLabel}: không có feed`, err);
        return {
          places: [],
          skippedCount: 0,
          clickAttempts: 0,
          reachedEnd: false,
          reason: "feed_missing",
          earlyExit: true
        };
      }
    }
    await sleep(120);

    sendProgress(
      calcProgressPercent(cellIndex, totalCells, 0.05),
      `Khu vực ${cellIndex + 1}/${totalCells} · ${cellLabel} · Đang tải danh sách điểm bán…`
    );

    const buildPlaceFromList = (listData) => {
      const place = sanitizeFromList(
        listData,
        searchParams.lat,
        searchParams.lng,
        searchParams.radius,
        mapLat,
        mapLng,
        true
      );
      if (!place) return null;
      place.href = listData.href;
      place.name = cleanPlaceName(place.name || listData.name);
      place._cellDist = Math.round(cellDist * 100) / 100;
      place.rating = listData.rating || place.rating || "";
      place.reviews = listData.reviews || place.reviews || "";
      place.address = hasReliableAddress(listData.address) ? pickBestAddress(listData.address) : "";
      return place;
    };

    const pending = new Map();
    let lastObservedItemKey = "";

    const collectOnly = async (panel) => {
      let newInRound = 0;
      const checkpointPlaces = [];
      for (const item of getResultItems(panel)) {
        if (isAborted) break;

        const listData = extractListItemData(item);
        if (!listData?.name) continue;
        const track = getItemTrackKey(listData);
        if (track) lastObservedItemKey = track;
        if (isAlreadyCollected(listData, seenTrack, seenKeys, seenCanonical, results)) {
          skippedCount++;
          continue;
        }

        if (pending.has(track)) continue;

        const place = buildPlaceFromList(listData);
        if (!place) continue;

        pending.set(track, { listData, place });
        checkpointPlaces.push(place);
        newInRound++;
      }
      if (checkpointPlaces.length) {
        sendListCheckpoint(cellIndex, checkpointPlaces, {
          totalNewPlaces: pending.size,
          scrollTop: panel.scrollTop,
          scrollHeight: panel.scrollHeight,
          lastItemKey: lastObservedItemKey
        });
      }
      return {
        newCount: newInRound,
        total: pending.size,
        lastItemKey: lastObservedItemKey
      };
    };

    let lastScrollProgressTotal = 0;
    const onScrollProgress = (total, round) => {
      const ratio = Math.min(0.42, 0.05 + round * 0.008);
      const dataActivity = total > lastScrollProgressTotal;
      lastScrollProgressTotal = Math.max(lastScrollProgressTotal, total);
      sendProgress(
        calcProgressPercent(cellIndex, totalCells, ratio),
        `Khu vực ${cellIndex + 1}/${totalCells} · Đang tải danh sách · ${total} điểm bán`,
        { dataActivity }
      );
    };

    const scrollOutcome = await scrollFeed(feed, collectOnly, {
      requireEndMarker: true,
      safetyMax: 2000,
      maxMs: CELL_SCROLL_CHUNK_MS,
      fastScroll: fastMode,
      onProgress: onScrollProgress,
      resumeFromCurrent
    });
    feed = scrollOutcome.feed;

    tbLog(
      `[DIAG] ${cellLabel}: pha CUỘN xong sau ${secsSinceCellStart()}s · gom được ${pending.size} điểm · ` +
        `reachedEnd=${scrollOutcome.reachedEnd} · reason=${scrollOutcome.reason} · ` +
        `rounds=${scrollOutcome.rounds} · trùng đã bỏ=${skippedCount}`
    );

    for (const { listData, place } of pending.values()) {
      if (isAborted) break;
      markCollected(listData, place, seenTrack, seenKeys, seenCanonical);
      place._phase = "list";
      place.name = cleanPlaceName(place.name);
      if (typeof sanitizeAddressField === "function") {
        place.address = sanitizeAddressField(place.address);
      }
      results.push(place);
    }

    if (scrollOutcome.reachedEnd) {
      sendProgress(
        calcProgressPercent(cellIndex, totalCells, 0.94),
        `Đã tải hết khu vực ${cellIndex + 1}/${totalCells} · ${results.length} điểm bán`
      );
    }

    tbLog(
      scrollOutcome.reachedEnd
        ? `${cellLabel}: đã thu đủ ${results.length} điểm bán`
        : `${cellLabel}: chưa xác nhận được cuối danh sách, không chuyển khu vực`
    );
    return {
      places: results,
      skippedCount,
      clickAttempts: 0,
      reachedEnd: scrollOutcome.reachedEnd,
      reason: scrollOutcome.reason,
      rounds: scrollOutcome.rounds,
      elapsedMs: scrollOutcome.elapsedMs,
      activeElapsedMs: scrollOutcome.activeElapsedMs,
      newPlacesCount: results.length,
      startScrollTop: scrollOutcome.startScrollTop,
      startScrollHeight: scrollOutcome.startScrollHeight,
      scrollTop: scrollOutcome.scrollTop,
      scrollHeight: scrollOutcome.scrollHeight,
      lastItemKey: scrollOutcome.lastItemKey,
      progressed: scrollOutcome.progressed,
      continuationRecommended: scrollOutcome.continuationRecommended,
      suspendDetected: scrollOutcome.suspendDetected,
      suspendGapMs: scrollOutcome.suspendGapMs,
      suspendCount: scrollOutcome.suspendCount,
      earlyExit: !scrollOutcome.reachedEnd
    };
  }

  async function waitForFeed(maxMs = 15000, deadline = Infinity) {
    const start = Date.now();
    const effectiveDeadline = Math.min(
      start + Math.max(0, Number(maxMs) || 0),
      Number.isFinite(deadline) ? deadline : Infinity
    );
    while (Date.now() < effectiveDeadline) {
      const feed = getFeedPanel();
      if (feed && getResultItems(feed).length > 0) return feed;
      await sleep(Math.min(300, Math.max(0, effectiveDeadline - Date.now())));
    }
    throw new Error("Không tìm thấy danh sách kết quả trên Google Maps");
  }

  async function scrapeCellList(data) {
    const {
      searchParams,
      cellIndex,
      totalCells,
      cellId,
      cellLabel,
      globalSeen,
      cellLat,
      cellLng,
      searchUrl,
      previousFeedSignature,
      requireFeedChange,
      previousFeedInstanceId,
      resumeFromCurrent
    } = data;
    isAborted = false;
    if (totalCells > 0) _lastKnownTotalCells = totalCells;
    const label = cellLabel || cellId || `Khu vực ${cellIndex + 1}`;
    showShield(`Khu vực ${cellIndex + 1}/${totalCells}: ${label} · Đang tải danh sách điểm bán…`, 2, {
      webUrl: searchParams?.webUrl
    });
    sendProgress(
      calcProgressPercent(cellIndex, totalCells, 0.03),
      `Khu vực ${cellIndex + 1}/${totalCells} · ${label} · Đang chờ Google Maps tải danh sách…`
    );

    const feed = await waitForCellFeedReady(
      searchUrl,
      cellLat,
      cellLng,
      cellIndex,
      28000,
      totalCells,
      previousFeedSignature,
      requireFeedChange,
      previousFeedInstanceId,
      resumeFromCurrent
    );
    const outcome = await scrollAndScrapePlaces(
      feed,
      searchParams,
      cellIndex,
      totalCells,
      globalSeen || [],
      label,
      cellLat,
      cellLng,
      searchUrl || "",
      previousFeedSignature,
      requireFeedChange,
      previousFeedInstanceId,
      resumeFromCurrent
    );

    return {
      success: outcome.reachedEnd,
      ...(RunLease.normalize(data) || {}),
      places: outcome.places,
      skippedCount: outcome.skippedCount,
      clickAttempts: outcome.clickAttempts,
      reachedEnd: outcome.reachedEnd,
      reason: outcome.reason,
      rounds: outcome.rounds,
      elapsedMs: outcome.elapsedMs,
      activeElapsedMs: outcome.activeElapsedMs,
      newPlacesCount: outcome.newPlacesCount,
      startScrollTop: outcome.startScrollTop,
      startScrollHeight: outcome.startScrollHeight,
      scrollTop: outcome.scrollTop,
      scrollHeight: outcome.scrollHeight,
      lastItemKey: outcome.lastItemKey,
      progressed: outcome.progressed,
      continuationRecommended: outcome.continuationRecommended,
      suspendDetected: outcome.suspendDetected,
      suspendGapMs: outcome.suspendGapMs,
      suspendCount: outcome.suspendCount,
      error: outcome.reachedEnd
        ? null
        : "Google Maps chưa hiển thị điểm cuối danh sách. Findmap sẽ thử lại khu vực này.",
      cellIndex,
      totalCells,
      cellLabel: label
    };
  }

  function runScrapeCellMessage(data) {
    const lease = RunLease.normalize(data);
    if (!lease) {
      return Promise.resolve({ success: false, places: [], error: "Thiếu định danh phiên quét." });
    }
    if (activeCellTask && RunLease.same(activeCellLease, lease)) return activeCellTask;

    const previousTask = activeCellTask;
    const task = (async () => {
      if (previousTask) {
        isAborted = true;
        await previousTask.catch(() => {});
      }
      activeCellLease = lease;
      isAborted = false;
      const outcome = await scrapeCellList(data);
      return { ...(outcome || { success: false, places: [] }), ...lease };
    })();

    activeCellTask = task;
    task.finally(() => {
      if (activeCellTask !== task) return;
      activeCellTask = null;
      activeCellLease = null;
      isAborted = false;
    }).catch(() => {});
    return task;
  }

  function getRecordCanonicalPlaceId(record) {
    if (!record) return "";
    for (const raw of [record.googlePlaceId, record.placeId]) {
      const value = String(raw || "").trim();
      if (/^(?:ChIJ|slug:)/i.test(value)) return value.toLowerCase();
      const fromUrl = getCanonicalPlaceId(value);
      if (fromUrl) return fromUrl.toLowerCase();
    }
    for (const url of [record.mapsUrl, record.href]) {
      const value = getCanonicalPlaceId(url || "");
      if (value) return value.toLowerCase();
    }
    return "";
  }

  function enrichCanonicalMatches(listData, place) {
    const expected = getRecordCanonicalPlaceId(listData);
    if (!expected) return true;
    const expectedKind = expected.startsWith("chij") ? "chij" : "slug";
    const actualUrls = [window.location.href, place?.mapsUrl || ""];
    const actualUrlCanonicals = actualUrls
      .map((url) => getCanonicalPlaceId(url || "").toLowerCase())
      .filter(Boolean);
    const sameKindCanonicals = actualUrlCanonicals.filter((value) =>
      expectedKind === "chij" ? value.startsWith("chij") : value.startsWith("slug:")
    );

    if (sameKindCanonicals.length) {
      return sameKindCanonicals.every((value) => value === expected);
    }

    const expectedSlugs = new Set(
      [listData?.href, listData?.mapsUrl]
        .map((url) => getPlaceSlug(url || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    );
    const actualSlugs = actualUrls
      .map((url) => getPlaceSlug(url || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const directActual = [place?.googlePlaceId, place?.placeId]
      .map((value) => String(value || "").trim().toLowerCase())
      .find((value) => /^(?:chij|slug:)/.test(value));
    if (!actualUrlCanonicals.length && !actualSlugs.length && directActual) {
      const directKind = directActual.startsWith("chij") ? "chij" : "slug";
      if (directKind === expectedKind) return directActual === expected;
    }

    const slugsMatch =
      expectedSlugs.size > 0 &&
      actualSlugs.length > 0 &&
      actualSlugs.every((slug) => expectedSlugs.has(slug));
    return slugsMatch && strictNameMatch(listData?.name, place?.name);
  }

  const ENRICH_PREVIOUS_TASK_WAIT_MS = 8000;

  function isEnrichCancelled(cancelMarker) {
    return cancelMarker?.cancelled === true;
  }

  function throwIfEnrichCancelled(cancelMarker) {
    if (isEnrichCancelled(cancelMarker)) {
      throw new Error("Thao tác bổ sung đã bị hủy.");
    }
  }

  async function waitForPreviousEnrichTask(previousTask) {
    if (!previousTask) return true;
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(previousTask).then(
          () => true,
          () => true
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), ENRICH_PREVIOUS_TASK_WAIT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function cancelActiveEnrich(opId) {
    if (!activeEnrichTask || !activeEnrichCancelMarker) return false;
    if (opId && activeEnrichOpId !== opId) return false;
    activeEnrichCancelMarker.cancelled = true;
    return true;
  }

  function runEnrichPlaceMessage(data = {}) {
    data = data || {};
    const opId = String(data.opId || "").trim();
    if (!opId) {
      return Promise.resolve({ success: false, opId, error: "Thiếu opId cho thao tác bổ sung." });
    }
    if (activeEnrichTask && activeEnrichOpId === opId) return activeEnrichTask;

    const previousTask = activeEnrichTask;
    if (previousTask) {
      if (activeEnrichCancelMarker) activeEnrichCancelMarker.cancelled = true;
      return (async () => {
        const settled = await waitForPreviousEnrichTask(previousTask);
        if (!settled) {
          return {
            success: false,
            settled: false,
            opId,
            error: "Thao tác bổ sung trước chưa dừng; chưa bắt đầu thao tác mới."
          };
        }
        if (activeEnrichTask === previousTask) {
          activeEnrichTask = null;
          activeEnrichOpId = "";
          activeEnrichCancelMarker = null;
        }
        return runEnrichPlaceMessage(data);
      })().catch((err) => ({ success: false, opId, error: err.message }));
    }

    const cancelMarker = { cancelled: false };

    const task = (async () => {
      throwIfEnrichCancelled(cancelMarker);

      const {
        listData,
        searchParams,
        progressText,
        percent,
        fast = false,
        thorough = false
      } = data;
      const profile = typeof getEnrichProfile === "function" ? getEnrichProfile(listData) : null;
      const place = await enrichPlaceOnPage(listData, searchParams, progressText, percent, {
        fast: thorough ? false : fast || profile?.fast,
        quick: thorough ? false : profile?.quick,
        needAddress: thorough ? true : profile?.needAddress !== false,
        needPhone: thorough ? true : profile?.needPhone !== false,
        cancelMarker
      });

      throwIfEnrichCancelled(cancelMarker);
      if (place && !enrichCanonicalMatches(listData, place)) {
        return { success: false, opId, error: "Chi tiết Google Maps không khớp điểm bán yêu cầu." };
      }
      return { success: !!place, place, opId };
    })().catch((err) => ({ success: false, opId, error: err.message }));

    activeEnrichTask = task;
    activeEnrichOpId = opId;
    activeEnrichCancelMarker = cancelMarker;
    task.finally(() => {
      if (activeEnrichTask !== task) return;
      activeEnrichTask = null;
      activeEnrichOpId = "";
      activeEnrichCancelMarker = null;
    }).catch(() => {});
    return task;
  }

  window.__timDiemBanWake = function () {
    document.dispatchEvent(new CustomEvent("timdiemban-wake", { bubbles: true }));
  };

  function handleRuntimeMessage(message, sender, sendResponse) {
    if (message.action === "PING") {
      sendResponse({ ok: true, v: window.__timDiemBanVersion || 0 });
      return;
    }
    if (message.action === "KEEPALIVE_TICK") {
      window.__timDiemBanWake();
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "GET_FEED_SIGNATURE") {
      sendResponse({ success: true, signature: getFeedSignature(), instanceId: CONTENT_INSTANCE_ID });
      return;
    }
    if (message.action === "SCRAPE_ABORT") {
      const requestedLease = RunLease.normalize(message.data);
      if (!requestedLease || RunLease.same(activeCellLease, requestedLease)) abortScrape();
      sendResponse({ success: true });
      return;
    }
    if (message.action === "SCRAPE_SHIELD_UPDATE") {
      const { text, percent, webUrl, webLabel } = message.data || {};
      setShieldMeta({ webUrl, webLabel });
      if (!shieldEl) {
        showShield(text || "Đang xử lý...", percent ?? 0, { webUrl, webLabel });
      } else if (text || percent != null) {
        updateShield(text, percent);
      }
      sendResponse({ success: true });
      return;
    }
    if (message.action === "SCRAPE_CELL_LIST") {
      runScrapeCellMessage(message.data)
        .then((outcome) => sendResponse(outcome || { success: false }))
        .catch((err) => {
          hideShield();
          console.warn("SCRAPE_CELL_LIST:", err.message);
          sendResponse({
            success: false,
            places: [],
            error: err.message,
            ...(RunLease.normalize(message.data) || {})
          });
        });
      return true;
    }
    if (message.action === "ENRICH_PLACE") {
      const opId = String(message.data?.opId || "").trim();
      runEnrichPlaceMessage(message.data)
        .then(sendResponse)
        .catch((err) => sendResponse({ success: false, opId, error: err.message }));
      return true;
    }
    if (message.action === "ENRICH_ABORT") {
      const opId = String(message.data?.opId || "").trim();
      if (!opId) {
        sendResponse({ success: false, opId, error: "Thiếu opId cho thao tác hủy." });
        return;
      }
      const taskToSettle = activeEnrichTask;
      const cancelled = cancelActiveEnrich(opId);
      if (!cancelled || !taskToSettle) {
        sendResponse({ success: false, settled: false, opId, cancelled: false });
        return;
      }
      waitForPreviousEnrichTask(taskToSettle)
        .then((settled) => {
          sendResponse({
            success: settled,
            settled,
            opId,
            cancelled: true,
            ...(settled ? {} : { error: "Thao tác bổ sung chưa dừng trong thời gian chờ." })
          });
        })
        .catch((err) =>
          sendResponse({ success: false, settled: false, opId, cancelled: true, error: err.message })
        );
      return true;
    }
    if (message.action === "ENRICH_ONE") {
      enrichOneFromList(message.data)
        .then((outcome) => sendResponse(outcome || { success: false, needUrlFallback: true }))
        .catch((err) => sendResponse({ success: false, needUrlFallback: true, error: err.message }));
      return true;
    }
    if (message.action === "ENRICH_BATCH") {
      enrichPlacesBatch(message.data)
        .then((outcome) => sendResponse(outcome || { success: false, places: [], needFallback: [] }))
        .catch((err) => sendResponse({ success: false, places: [], needFallback: [], error: err.message }));
      return true;
    }
    if (message.action === "SCRAPE_FINISH") {
      hideShield();
      sendResponse({ success: true });
    }
  }

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  window.__timDiemBanCleanup = function () {
    extAlive = false;
    isAborted = true;
    if (activeEnrichCancelMarker) activeEnrichCancelMarker.cancelled = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch {}
    hideShield();
    if (window.__timDiemBanVersion === CONTENT_VERSION) {
      delete window.__timDiemBanLoaded;
      delete window.__timDiemBanVersion;
      delete window.__timDiemBanCleanup;
      delete window.__timDiemBanWake;
    }
  };
})();
