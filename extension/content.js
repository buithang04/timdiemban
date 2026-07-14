(function () {
  // Bump version mỗi lần sửa content — background sẽ reinject nếu Maps còn bản cũ
  const CONTENT_VERSION = 50;
  if (window.__timDiemBanLoaded && window.__timDiemBanVersion === CONTENT_VERSION) return;
  window.__timDiemBanLoaded = true;
  window.__timDiemBanVersion = CONTENT_VERSION;

  let antiThrottleStop = null;
  let scrapeInProgress = false;
  let bgWakeInterval = null;

  function startBackgroundWakeLoop() {
    if (bgWakeInterval) return;
    bgWakeInterval = setInterval(() => {
      if (!scrapeInProgress || !document.hidden) return;
      startAntiThrottle();
      document.dispatchEvent(new CustomEvent("timdiemban-wake", { bubbles: true }));
    }, 300);
  }

  function stopBackgroundWakeLoop() {
    if (bgWakeInterval) {
      clearInterval(bgWakeInterval);
      bgWakeInterval = null;
    }
  }
  function startAntiThrottle() {
    stopAntiThrottle();
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      antiThrottleStop = () => {
        try {
          osc.stop();
          ctx.close();
        } catch {}
        antiThrottleStop = null;
      };
    } catch {}
  }

  function stopAntiThrottle() {
    if (antiThrottleStop) antiThrottleStop();
  }

  // Khi ô tìm tiếp theo được load bằng chrome.tabs.update({active:false}), tab luôn
  // ở trạng thái ẩn NGAY TỪ ĐẦU — sự kiện "visibilitychange" (dùng để tự bật chống
  // throttle) sẽ KHÔNG bao giờ bắn ra vì trạng thái ẩn không hề thay đổi. Vì vậy phải
  // kiểm tra document.hidden ngay khi script vừa load, không chỉ chờ visibilitychange.
  if (document.hidden) startAntiThrottle();

  function sleep(ms) {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const step = () => {
        const left = deadline - Date.now();
        if (left <= 0) return resolve();
        const chunk = document.hidden ? Math.min(left, 350) : left;
        const timer = setTimeout(step, chunk);
        if (document.hidden) {
          const onWake = () => {
            clearTimeout(timer);
            step();
          };
          document.addEventListener("timdiemban-wake", onWake, { once: true });
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
  let isAborted = false;
  let shieldEl = null;
  let blockKeysHandler = null;
  let shieldPeek = false;
  let shieldWebLabel = "";
  const shieldLogLines = [];
  const SHIELD_LOG_MAX = 14;

  function tbLog(msg, level = "log") {
    const text = String(msg || "");
    const line = `${new Date().toLocaleTimeString("vi-VN")} ${text}`;
    shieldLogLines.push(line);
    if (shieldLogLines.length > SHIELD_LOG_MAX) shieldLogLines.shift();
    if (level === "warn") console.warn("TimDiemBan:", text);
    else console.log("TimDiemBan:", text);
    appendShieldLog();
    try {
      chrome.runtime.sendMessage({ action: "SCRAPE_LOG", line: text });
    } catch {}
  }

  function appendShieldLog() {
    /* log chỉ ghi Console — không hiển thị trên overlay */
  }

  function toggleShieldPeek() {
    shieldPeek = !shieldPeek;
    if (!shieldEl) return;
    if (shieldPeek) {
      shieldEl.style.opacity = "0.08";
      shieldEl.style.pointerEvents = "none";
      tbLog("Ẩn overlay — Ctrl+Shift+D bật lại | F12 mở Console");
    } else {
      shieldEl.style.opacity = "";
      shieldEl.style.pointerEvents = "all";
      tbLog("Bật lại overlay chặn thao tác");
    }
  }

  function isDevToolsShortcut(e) {
    if (e.key === "F12") return true;
    if (e.ctrlKey && e.shiftKey && ["I", "J", "C", "K", "D"].includes(e.key.toUpperCase())) return true;
    if (e.metaKey && e.altKey && e.key.toLowerCase() === "i") return true;
    return false;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && scrapeInProgress) {
      startAntiThrottle();
      startBackgroundWakeLoop();
    } else if (!document.hidden) {
      stopBackgroundWakeLoop();
      if (scrapeInProgress) {
        try {
          chrome.runtime.sendMessage({ action: "MAPS_TAB_VISIBLE" }, () => {});
        } catch {}
      }
    }
    document.dispatchEvent(new CustomEvent("timdiemban-wake", { bubbles: true }));
  });

  function createShield() {
    // Maps SPA có thể gỡ node khỏi DOM — tạo lại nếu đã bị detach
    if (shieldEl && document.contains(shieldEl)) {
      // Đảm bảo title hiện đúng version (biết đã load bản mới)
      const title = shieldEl.querySelector(".shield-title");
      if (title && !title.textContent.includes(`v${CONTENT_VERSION}`)) {
        title.innerHTML = `Đang tìm kiếm tự động <span style="font-size:12px;color:#2563eb;font-weight:600">v${CONTENT_VERSION}</span>`;
      }
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
        <div class="shield-title">Đang tìm kiếm tự động <span style="font-size:12px;color:#2563eb;font-weight:600">v${CONTENT_VERSION}</span></div>
        <div class="shield-text" id="timdiemban-shield-text">Vui lòng không thao tác trên trang này...</div>
        <div class="shield-bar-wrap"><div class="shield-bar" id="timdiemban-shield-bar"></div></div>
        <div class="shield-percent" id="timdiemban-shield-percent">0%</div>
        <div class="shield-warn" id="timdiemban-shield-warn">Kết quả tự đồng bộ về tab kết quả. Giữ tab Maps mở để quét nhanh — rời tab được nhưng quay lại sẽ tự bù dữ liệu.</div>
        <div class="shield-hint">Ctrl+Shift+D = ẩn/hiện overlay · F12 = Console</div>
      </div>`;
    const block = (e) => { e.stopPropagation(); e.preventDefault(); };
    ["click", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel", "touchstart"].forEach(
      (ev) => shieldEl.addEventListener(ev, block, true)
    );
    document.documentElement.appendChild(shieldEl);
    return shieldEl;
  }

  function formatShieldWarn(webLabel) {
    const target = webLabel ? `tab ${webLabel}` : "tab kết quả";
    return `Kết quả tự đồng bộ về ${target}. Giữ tab Maps mở để quét nhanh — rời tab được nhưng quay lại sẽ tự bù dữ liệu.`;
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
    shieldPeek = false;
    shieldLogLines.length = 0;
    scrapeInProgress = true;
    updateShield(text, percent);
    startAntiThrottle();
    if (document.hidden) startBackgroundWakeLoop();
    blockKeysHandler = (e) => {
      if (isDevToolsShortcut(e)) {
        if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === "D") {
          e.preventDefault();
          toggleShieldPeek();
        }
        return;
      }
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
    const doneCells = (idx / totalCells) * 70;
    // Mỗi ô đang chạy chiếm tối thiểu ~8% thanh (dễ thấy), tối đa 1 phần theo số ô
    const withinSpan = Math.max(8, 70 / totalCells);
    const within = ratio * withinSpan;
    return Math.min(95, Math.max(0, Math.round(doneCells + within)));
  }

  function hideShield() {
    scrapeInProgress = false;
    stopBackgroundWakeLoop();
    stopAntiThrottle();
    shieldPeek = false;
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

  function sendProgress(percent, text) {
    updateShield(text, percent);
    chrome.runtime.sendMessage({ action: "SCRAPE_PROGRESS", percent, text });
  }

  function sendItem(result, searchParams, index, total) {
    if (result) result._webSent = true;
    chrome.runtime.sendMessage({
      action: "SCRAPE_ITEM",
      data: { result, searchParams, index, total, phase: result._phase || "list" }
    });
  }

  function getFeedPanel() {
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;
    const main = document.querySelector('[role="main"]');
    feed = main?.querySelector('div[role="feed"]');
    if (feed) return feed;
    if (main?.querySelectorAll("a[href*='/maps/place']").length) return main;
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

  /** Panel Tổng quan chứa button address/phone của quán đang mở */
  function findOverviewContactRoot() {
    const h1 = findDetailPaneH1();
    if (!h1) return null;

    let root = null;
    let node = h1.parentElement;
    for (let i = 0; i < 28 && node; i++) {
      if (node.closest('[role="feed"]')) break;
      const hasContact = node.querySelector(
        'button[data-item-id="address"], button[data-item-id^="address"], button[data-item-id^="phone:"]'
      );
      if (hasContact) root = node;
      node = node.parentElement;
    }
    return root;
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
    return /^(địa chỉ|address)\s*:/i.test(label);
  }

  function isMapsUiLabel(text) {
    const t = (text || "").trim();
    if (!t || t.length > 90) return false;
    return (
      /^(tổng quan|overview|bài đánh giá|reviews?|giới thiệu|about|đường đi|directions|gần đó|nearby)$/i.test(
        t
      ) ||
      /^(gửi tới điện thoại|send to (your )?phone|chia sẻ|share|xem ảnh|see photos?|ảnh|photos?|thực đơn|menu|lưu|save|đặt chỗ|reserve|đặt hàng|order|gọi điện|call|trang web|website)$/i.test(
        t
      ) ||
      /^(sao chép|copy)\b/i.test(t)
    );
  }

  /** Chuỗi gom nhầm tab/nút Maps — không phải địa chỉ */
  function isMapsUiChromeText(text) {
    const t = (text || "").trim();
    if (!t) return false;
    if (
      /tổng quan.*bài đánh giá|overview.*reviews?|giới thiệu.*đường đi|about.*directions/i.test(
        t
      )
    ) {
      return true;
    }
    if (/gửi tới điện thoại|send to.*phone/i.test(t) && /tổng quan|overview|chia sẻ|share/i.test(t)) {
      return true;
    }
    const parts = t.split(/[,·]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return isMapsUiLabel(t);
    const uiHits = parts.filter(
      (p) =>
        isMapsUiLabel(p) ||
        /^(đường đi|directions|gần đó|nearby|gửi|send|chia sẻ|share|xem ảnh)/i.test(p)
    ).length;
    if (uiHits >= 2) return true;
    if (uiHits >= 1 && parts.length >= 3 && !isLikelyAddress(t)) return true;
    return false;
  }

  function stripPhoneFromAddress(text) {
    let t = (text || "").trim();
    if (!t) return "";
    t = t.replace(/\s+(?:\+?84|0)[\d\s.\-()]{8,20}\s*$/i, "").trim();
    t = t.replace(/\s+\d{2,4}(?:[\s.\-]\d{2,4}){2,4}\s*$/i, "").trim();
    return t;
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
    if (/phố|đường|đ\.|d\.|ngõ|ngh\.|ngách|hẻm|street|road|ave/i.test(t)) score += 12;
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

  /** Chỉ đọc địa chỉ từ button[data-item-id="address"] — ưu tiên aria-label */
  function parseAddressFromContactButton(btn) {
    if (!btn || !isAddressContactButton(btn) || !isOverviewContactButton(btn)) return "";

    // Ưu tiên cao nhất: aria-label="Địa chỉ: XYZ" — bóc phần sau prefix
    const fromAriaLabel = extractAddressFromAriaLabel(btn);
    if (fromAriaLabel && fromAriaLabel.length > 5) {
      return cleanAddressText(fromAriaLabel);
    }

    const fromAria = cleanAddressText(cleanLabel(btn.getAttribute("aria-label") || "", ADDRESS_LABEL_PREFIXES));
    const fromIo = cleanAddressText(readIo6YTeFromButton(btn));
    const fromBody = cleanAddressText(queryAddressBodyText(btn));
    const best = pickBestAddress(fromAria, fromIo, fromBody);
    if (best) return best;

    const itemId = btn.getAttribute("data-item-id") || "";
    const itemAddr = itemId.match(/address:(.+)$/i);
    if (itemAddr) {
      return cleanAddressText(decodeURIComponent(itemAddr[1]).trim());
    }
    return "";
  }

  function isInFeedOrList(el) {
    if (!el) return true;
    return !!el.closest('[role="feed"]');
  }

  function collectAddressCandidates() {
    const candidates = [];
    const seen = new Set();
    const selectors =
      'button.CsEnBe[data-item-id="address"], button[data-item-id="address"], button[data-item-id^="address"], button[aria-label^="Địa chỉ:"], button[aria-label^="Address:"]';

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
    const itemId = (btn.getAttribute("data-item-id") || "").toLowerCase();
    if (itemId.startsWith("phone")) return true;
    const label = (btn.getAttribute("aria-label") || "").trim();
    return /^(số\s*)?(điện thoại|phone)\s*:/i.test(label) || /^(gọi|call)\s+/i.test(label);
  }

  /** Chỉ đọc SĐT từ button[data-item-id^="phone:"] — ưu tiên aria-label */
  function parsePhoneFromContactButton(btn) {
    if (!btn || !isPhoneContactButton(btn) || !isOverviewContactButton(btn)) return "";

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

    const itemId = btn.getAttribute("data-item-id") || "";
    const telInId = itemId.match(/phone:tel:([^;]+)/i);
    if (telInId) {
      const fromId = pickBestPhoneCandidate(decodeURIComponent(telInId[1]).trim());
      if (normalizePhone(fromId).length >= 9) return fromId;
    }
    return "";
  }

  async function waitForOverviewContactButtons(listData, maxMs = 6000) {
    const start = Date.now();
    let bestAddr = "";
    let bestPhone = "";
    let revealRound = 0;
    let fieldsSeenAt = 0;
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

      const addr = readAddressFromContactButtons();
      const phone = readPhoneFromContactButtons();
      if (addr) bestAddr = pickBestAddress(bestAddr, addr);
      if (normalizePhone(phone).length >= 9) bestPhone = pickBestPhone(bestPhone, phone);

      const settleTime = domHeavy ? 800 : 500;
      const settled = fieldsSeenAt && Date.now() - fieldsSeenAt > settleTime;
      const phoneMissing = settled && !overviewContactButtonExists("phone");
      const addrMissing = settled && !overviewContactButtonExists("address");

      const needPhone = normalizePhone(bestPhone).length < 9 && !phoneMissing;
      const needAddr = !bestAddr && !addrMissing;
      if (!needPhone && !needAddr) break;
      if (!needAddr && addressLooksComplete(bestAddr) && !needPhone) break;
      if (!needAddr && addressLooksComplete(bestAddr) && normalizePhone(bestPhone).length >= 9) break;

      if (revealRound < 6 && Date.now() - start > 300 + revealRound * 500) {
        await revealAddressIntoView(contactRoot);
        await revealPhoneButton(contactRoot);
        revealRound++;
      }
      await sleep(domHeavy ? 150 : 120);
    }

    const stillMatch = !listData || verifyDetailMatchesList(listData);

    // Retry cuối cùng — đọc trực tiếp từ aria-label button (bypass DOM overhead)
    if (stillMatch && (normalizePhone(bestPhone).length < 9 || !bestAddr)) {
      const pane = getDetailPane() || findOverviewContactRoot();
      if (pane) {
        for (const btn of pane.querySelectorAll('button[aria-label]')) {
          const label = btn.getAttribute("aria-label") || "";
          if (!bestAddr && /^(Địa chỉ|Address)\s*:/i.test(label)) {
            const addr = label.replace(/^(Địa chỉ|Address)\s*:\s*/i, "").trim();
            if (addr.length > 5) bestAddr = pickBestAddress(bestAddr, addr);
          }
          if (normalizePhone(bestPhone).length < 9 && /^(Số điện thoại|Điện thoại|Phone)\s*:/i.test(label)) {
            const ph = label.replace(/^(Số điện thoại|Điện thoại|Phone)\s*:\s*/i, "").trim();
            if (normalizePhone(ph).length >= 9) bestPhone = pickBestPhone(bestPhone, ph);
          }
        }
      }
    }

    return {
      address: stillMatch ? pickBestAddress(bestAddr, readAddressFromContactButtons()) : bestAddr,
      phone: stillMatch ? bestPhone || readPhoneFromContactButtons() : bestPhone
    };
  }

  async function revealAddressIntoView(pane) {
    const selectors = [
      'button.CsEnBe[data-item-id="address"]',
      'button[data-item-id="address"]',
      'button[data-item-id^="address"]',
      'button[aria-label^="Địa chỉ:"]',
      'button[aria-label^="Address:"]'
    ];
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
    const selectors = [
      'button.CsEnBe[data-item-id^="phone:"]',
      'button[data-item-id^="phone:"]',
      'button[data-item-id="phone"]',
      'button[aria-label^="Số điện thoại:"]',
      'button[aria-label^="Điện thoại:"]',
      'button[aria-label^="Phone:"]'
    ];
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
    const selectors =
      'button.CsEnBe[data-item-id^="phone:"], button[data-item-id^="phone:"], button[data-item-id="phone"], button[aria-label^="Số điện thoại:"], button[aria-label^="Điện thoại:"], button[aria-label^="Phone:"]';

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
      const revM = aria.match(/([\d.,]+)\s*(đánh giá|reviews?|nhận xét)/i);
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
        el.querySelector(
          'button[data-item-id^="address"], button[data-item-id^="phone"], a[data-item-id="authority"]'
        )
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
        if (el.querySelector('button[data-item-id^="address"], a[data-item-id="authority"]')) {
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
    // Ưu tiên h1 đang VISIBLE (rect > 0) — tránh lấy nhầm h1 cũ từ DOM tràn
    const allH1 = document.querySelectorAll("h1");
    let fallbackH1 = null;
    for (const h1 of allH1) {
      if (h1.closest('[role="feed"]')) continue;
      const text = cleanPlaceName(h1.textContent?.trim() || "");
      if (!text || text.length === 0 || isSponsoredPlace(text)) continue;
      const rect = h1.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight) {
        return h1;
      }
      if (!fallbackH1) fallbackH1 = h1;
    }
    if (fallbackH1) return fallbackH1;
    const styled = document.querySelector('h1[class*="fontHeadline"], h1.fontHeadlineLarge');
    if (styled) {
      const text = cleanPlaceName(styled.textContent?.trim() || "");
      if (text && !isSponsoredPlace(text)) return styled;
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
    const sels = [
      'button.CsEnBe[data-item-id="address"]',
      'button[data-item-id="address"]',
      'button[data-item-id^="address"]',
      'button[data-item-id^="phone:"]',
      'a[data-item-id="authority"]'
    ];
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
   * Google render toàn bộ nút liên hệ cùng lúc, nên khi vùng liên hệ đã hiện mà
   * không có nút SĐT → quán không có SĐT (không cần chờ thêm).
   */
  function overviewContactButtonExists(kind) {
    const pane = findOverviewContactRoot() || getDetailPane();
    if (!pane) return false;
    const sel =
      kind === "phone"
        ? 'button[data-item-id^="phone:"], button[data-item-id="phone"]'
        : 'button[data-item-id="address"], button[data-item-id^="address"]';
    for (const el of pane.querySelectorAll(sel)) {
      if (isOverviewContactButton(el)) return true;
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

    tbLog("Đang thoát panel Giờ → về Tổng quan", "warn");

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
    if (!ok) tbLog("Không thoát được panel Giờ", "warn");
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
    const ohBtn = pane.querySelector('button[data-item-id^="oh"]');
    if (!ohBtn) return "";
    const label = ohBtn.getAttribute("aria-label") || "";
    let hours = label
      .replace(/^Giờ hoạt động:\s*/i, "")
      .replace(/^Hours:\s*/i, "")
      .replace(/^Đang mở cửa[:\s]*/i, "")
      .replace(/^Open now[:\s]*/i, "")
      .trim();
    if (!hours) {
      const row = queryBodyText(ohBtn);
      if (row && !/^giờ$/i.test(row) && !/^hours$/i.test(row)) hours = row;
    }
    return hours;
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
    const kMatch = t.match(/^([\d.,]+)\s*([kK])(?:\s*(đánh giá|reviews?|nhận xét))?$/i);
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
    const label = t.match(/([\d.,]+)\s*([kK])?\s*(đánh giá|reviews?|nhận xét)/i);
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
              (aria.match(/([\d.,]+)\s*(đánh giá|reviews?|nhận xét)/i)?.[1]?.replace(/,/g, "") || "");
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

      for (const img of ancestor.querySelectorAll('span[role="img"][aria-label], span[role="img"]')) {
        const aria = img.getAttribute("aria-label") || "";
        const starM = aria.match(/(\d[.,]\d)\s*(sao|star)/i);
        if (starM) {
          const reviewM = aria.match(/([\d.,]+)\s*(đánh giá|reviews?|nhận xét)/i);
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
      }
      if (/^https?:\/\//i.test(u.href) && !u.hostname.includes("google.com/maps")) {
        return u.href;
      }
    } catch {}
    return href.startsWith("http") ? href : "";
  }

  function readWebsite(scope) {
    const root = scope || document;
    const selectors = [
      'a[data-item-id="authority"]',
      'a[data-item-id^="authority"]',
      'button[data-item-id="authority"]',
      'button[data-item-id^="authority"]'
    ];
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        const href = el.getAttribute("href") || el.getAttribute("data-url") || "";
        const unwrapped = unwrapGoogleUrl(href);
        if (unwrapped && !unwrapped.includes("google.com/maps")) return unwrapped;
        const io = el.querySelector('[class*="fontBody"], [class*="Io6YTe"]') || el;
        const text = io?.textContent?.trim() || el.textContent?.trim() || "";
        if (text && /^https?:\/\//i.test(text)) return text;
        if (text && text.includes(".") && !text.includes("google.com")) {
          return text.startsWith("http") ? text : `https://${text}`;
        }
      }
    }
    for (const a of root.querySelectorAll('a[href^="http"]')) {
      if (a.closest('[role="feed"]')) continue;
      const label = (a.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("website") || label.includes("trang web")) {
        const u = unwrapGoogleUrl(a.href);
        if (u && !u.includes("google.com/maps")) return u;
      }
    }
    return "";
  }

  function readRatingAndReviews(scope) {
    const h1 = findDetailPaneH1();
    const fromH1 = findRatingAndReviews(h1);
    if (fromH1.rating) return fromH1;

    const root = scope || document;
    const ratingEl =
      root.querySelector('span[aria-hidden="true"]') ||
      root.querySelector('[class*="fontBody"] span');
    const rating = parseRatingText(ratingEl?.textContent) || "";

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

  function hasEndMarker(feed) {
    if (!feed) return false;
    // KHÔNG check khi feed đang loading — chờ load xong trước
    if (isFeedLoading(feed)) return false;

    // CHỈ detect bằng cấu trúc chính xác: p.fontBodyMedium > span > span.HlvSq
    // Phải là phần tử CON TRỰC TIẾP cuối cùng của feed (hoặc gần cuối)
    const allP = feed.querySelectorAll("p.fontBodyMedium");
    if (!allP.length) return false;

    for (const p of allP) {
      const hlvSq = p.querySelector("span.HlvSq");
      if (!hlvSq) continue;
      const text = (hlvSq.textContent || "").trim();
      if (text.length < 4) continue;

      // Kiểm tra thẻ p nằm ở phần CUỐI feed (không phải ở giữa)
      // Dùng so sánh DOM order: p phải là 1 trong 5 children cuối
      const children = Array.from(feed.children);
      const pIndex = children.indexOf(p.closest(`:scope > *`) || p);
      // Nếu p không phải con trực tiếp, tìm ancestor trực tiếp
      let directChild = p;
      while (directChild.parentElement && directChild.parentElement !== feed) {
        directChild = directChild.parentElement;
      }
      const directIndex = children.indexOf(directChild);
      if (directIndex >= 0 && directIndex >= children.length - 5) {
        return true;
      }

      // Fallback: so sánh với số result item — p phải nằm SAU tất cả
      const resultItems = getResultItems(feed);
      if (resultItems.length === 0) continue;
      const lastResultItem = resultItems[resultItems.length - 1];
      // Dùng compareDocumentPosition thay vì getBoundingClientRect (không bị ảnh hưởng bởi scroll)
      const pos = p.compareDocumentPosition(lastResultItem);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        // lastResultItem nằm TRƯỚC p → p ở sau → end marker hợp lệ
        return true;
      }
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
  async function waitForFeedContentReady(feed, maxMs = 6000) {
    if (!feed) return false;
    const start = Date.now();
    let lastCount = -1;
    let lastHeight = -1;
    let stableRounds = 0;

    while (Date.now() - start < maxMs) {
      feed = getFeedPanel() || feed;
      if (!feed?.isConnected) return false;

      if (isFeedLoading(feed)) {
        await waitForFeedSettled(feed, Math.min(4000, maxMs - (Date.now() - start)));
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
        await sleep(150);
        if (!isFeedLoading(feed)) return true;
        stableRounds = 1;
      }

      await sleep(180);
    }

    return !isFeedLoading(feed);
  }

  async function waitForFeedSettled(feed, maxMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!isFeedLoading(feed)) {
        await sleep(120);
        if (!isFeedLoading(feed)) return true;
      }
      await sleep(200);
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
      if (el.querySelector('button[data-item-id^="address"], a[data-item-id="authority"]')) return el;
    }
    return getDetailRoot();
  }

  async function revealContactButtons(pane) {
    await ensureDetailOverviewReady(true);
    const root = pane || getDetailPane();
    if (!root) return;
    await revealPhoneButton(root);
    const sels = [
      'button[data-item-id^="phone"]',
      'button[aria-label*="Số điện thoại"]',
      'button[aria-label*="Điện thoại"]',
      'button[aria-label*="Phone"]',
      'button[aria-label*="Sao chép số"]',
      'button[aria-label*="Copy phone"]'
    ];
    for (const sel of sels) {
      for (const btn of root.querySelectorAll(sel)) {
        if (btn.closest('[role="feed"]') || isDetailNavTab(btn)) continue;
        try {
          btn.click();
        } catch {}
        if (isHoursSubPanelOpen()) await exitHoursSubPanelIfNeeded();
        await sleep(90);
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

    if (!out.address || !out.phone) {
      for (const el of pane.querySelectorAll("[data-item-id], a[href], button")) {
        if (isInSearchFeed(el)) continue;
        const id = (el.getAttribute("data-item-id") || "").toLowerCase();
        const href = el.getAttribute("href") || "";
        const label = el.getAttribute("aria-label") || "";

        if (!out.phone) {
          const phoneM = id.match(/phone:tel:([^;]+)/i);
          if (phoneM) out.phone = decodeURIComponent(phoneM[1]);
          if (href.startsWith("tel:") && !out.phone) {
            out.phone = href.replace(/^tel:/i, "").trim();
          }
        }

        if (id.includes("authority") || /website|trang web/i.test(label)) {
          const u = unwrapGoogleUrl(href || el.querySelector("a")?.getAttribute("href") || "");
          if (u && !u.includes("google.com/maps")) out.website = u;
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

  // Dọn DOM cũ để giảm bloat — xóa các detail pane không còn visible
  function cleanupStaleDom() {
    try {
      const feed = getFeedPanel();
      const main = document.querySelector('[role="main"]');
      if (!main) return;
      const currentH1 = findDetailPaneH1();
      const currentPane = currentH1 ? findDetailPaneFromH1(currentH1) : null;

      // Tìm và ẩn các sibling panel cũ (Google Maps giữ lại DOM từ các place đã xem)
      let cleaned = 0;
      for (const el of main.querySelectorAll('[class*="m6QErb"]')) {
        if (el === feed || el === currentPane) continue;
        if (feed && feed.contains(el)) continue;
        if (currentPane && currentPane.contains(el)) continue;
        if (el.contains(feed) || (currentPane && el.contains(currentPane))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && el.querySelector('button[data-item-id^="address"]')) {
          el.remove();
          cleaned++;
        }
      }
      if (cleaned > 0) {
        tbLog(`Dọn ${cleaned} DOM pane cũ`);
      }
    } catch {}
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
          tbLog("Đã khôi phục list bằng URL ô tìm kiếm");
          return true;
        }
      } catch {}
    }

    if (!isOnResultList()) {
      tbLog("Không về được list — bỏ qua, tiếp quán sau", "warn");
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
    const { needPhone = true, needAddress = true, maxMs = 2800 } = options;
    await ensureDetailOverviewReady(true);
    let phone = "";
    let address = "";
    let lastAddrLen = 0;
    let addrStableRounds = 0;
    let phoneRevealCount = 0;
    const start = Date.now();

    while (Date.now() - start < maxMs) {
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
      needWebsite = false
    } = options;

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
      if (needWebsite && !website) website = snap.website;

      if (phone && (!needAddress || addressLooksComplete(address)) && (!needWebsite || website)) break;
      if (phone && !needAddress && !needWebsite) break;
      if (phone && needAddress && addressLooksComplete(address)) break;

      if (needPhone && !phone) await revealContactButtons(activePane);
      await sleep(pollMs);
    }

    for (let i = 0; i < detailRetry && needPhone && normalizePhone(phone).length < 9; i++) {
      await sleep(fast ? 150 : 280);
      phone = pickBestPhone(
        phone,
        readPhoneFromContactButtons(getDetailPane()),
        readOverviewSnapshot(getDetailPane()).phone
      );
    }

    if (needAddress) {
      for (let i = 0; i < (fast ? 6 : 8) && !addressLooksComplete(address); i++) {
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

  function isGarbageAddressText(text) {
    const t = (text || "").trim();
    if (!t) return true;
    if (typeof isVisitedLinkText === "function" && isVisitedLinkText(t)) return true;
    if (/đường liên kết đã truy cập|visited link/i.test(t)) return true;
    if (/mua sắm tại cửa hàng|shop in store|in-store shopping/i.test(t)) return true;
    if (/tổng quan|overview|bài đánh giá|reviews?|giới thiệu|about|gần đó|nearby/i.test(t)) return true;
    if (/\d[.,]\d\s*\(\d+\)/.test(t)) return true;
    if (/\d[.,]\d\s*\/\s*(cửa hàng|shop|store|tạp hóa|bách hóa|siêu thị|quán|tiệm)/i.test(t)) return true;
    if (
      /(cửa hàng tiện lợi|convenience store|bách hóa|tạp hóa|siêu thị)/i.test(t) &&
      !/,.*(quận|huyện|phường|thành phố|hà nội|việt nam|vietnam)/i.test(t)
    ) {
      return true;
    }
    if (/[A-Za-zÀ-ỹ].*\/.*[A-Za-zÀ-ỹ]/.test(t) && !/,|quận|huyện|phường|đường|phố|việt nam|vietnam/i.test(t)) {
      return true;
    }
    return false;
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
      /,|\d{2,}|phố|đường|quận|huyện|thành phố|thị trấn|thôn|xã|ngõ|ngách|hẻm|ward|district|street|st\.|ave|road|rd\.|vietnam|việt nam/i.test(
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
    if (t.length < 5) return false;
    if (
      /,|phố|đường|đ\.|d\.|ngõ|ngách|hẻm|quận|huyện|thành phố|thị trấn|thôn|xã|ấp|khu|lô|tổ|p\.|tp\.|ward|district|việt nam|vietnam/i.test(
        t
      )
    ) {
      return true;
    }
    if (/\d+\s*(đường|phố)/i.test(t)) return true;
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
    let name = "";
    const titleEl =
      item.querySelector('a[href*="/maps/place"] [class*="fontHeadline"]') ||
      item.querySelector('[class*="fontHeadline"]');
    if (titleEl?.textContent?.trim()) {
      name = cleanPlaceName(titleEl.textContent.trim());
    }
    if (!name) {
      name = cleanPlaceName(link.getAttribute("aria-label") || link.textContent?.trim() || "");
    }
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
    return {
      placeId: googlePlaceId || placeId,
      googlePlaceId,
      name, href,
      rating,
      reviews,
      category: meta.category,
      address: hasReliableAddress(address) ? cleanAddressText(address) : "",
      phone: "",
      lat: pinCoords?.lat ?? null,
      lng: pinCoords?.lng ?? null,
      listDistanceKm: meta.listDistanceKm,
      mapsUrl: pinCoords ? getPlacePageUrl(href) || buildPlaceMapsUrl(pinCoords.lat, pinCoords.lng, googlePlaceId, name) : ""
    };
  }

  async function waitForDetailPanel(listData) {
    const start = Date.now();
    while (Date.now() - start < T.detail) {
      const h1 = findDetailPaneH1();
      if (h1) {
        if (!listData?.name || verifyDetailMatchesList(listData)) {
          await sleep(280);
          return true;
        }
      }
      await sleep(T.detailPoll);
    }
    return !!findDetailPaneH1();
  }

  async function extractPlaceDetails(listData, searchParams, options = {}) {
    const {
      enrich = false,
      fast = false,
      quick = false,
      needAddress = true,
      needPhone = true,
      needWebsite = false
    } = options;
    const hasCoords = listData?.lat != null && listData?.lng != null && !isNaN(listData.lat);
    const hasRating = !!(listData?.rating && /\d/.test(String(listData.rating)));
    const hasReviews = !!(listData?.reviews && String(listData.reviews).replace(/\D/g, "").length > 0);
    const listAddress = hasReliableAddress(listData?.address) ? pickAddress(listData?.address) : "";
    const useQuick = !!quick;

    await ensureDetailOverviewReady(useQuick, listData);
    if (!useQuick && !isOverviewTabActive()) {
      await ensureDetailOverviewReady(false, listData);
    }
    if (isHoursSubPanelOpen()) await exitHoursSubPanelIfNeeded();

    await sleep(useQuick ? 50 : fast ? 90 : 180);

    const pane = getDetailPane();
    let snap = readOverviewSnapshot(pane);
    let phone = needPhone
      ? pickBestPhone(readPhoneFromContactButtons(pane), snap.phone)
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
          maxMs: missingPhone ? (missingAddr ? 5200 : 2800) : missingAddr ? 5000 : 1200
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
          needWebsite
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
      website = readWebsite(getDetailPane()) || snap.website;
    }

    const hours = readHoursFromOverviewButton(pane);
    const pageUrl = window.location.href;
    const coords = hasCoords
      ? { lat: listData.lat, lng: listData.lng, exact: true }
      : useQuick
        ? { lat: listData.lat, lng: listData.lng, exact: false }
        : await waitForPlaceCoords(listData, searchParams, fast ? 500 : enrich ? 1800 : T.coordWait);
    const googlePlaceId =
      getCanonicalPlaceId(pageUrl) ||
      getCanonicalPlaceId(listData?.href || "") ||
      listData?.googlePlaceId;
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

  function getFirstListPlaceHref(feed) {
    const items = getResultItems(feed || getFeedPanel());
    return items[0]?.querySelector("a[href*='/maps/place']")?.href?.split("?")[0] || "";
  }

  /** Chờ Maps tải đúng vùng — tránh đọc list cũ sau khi background chuyển URL (Apify: mỗi ô = search mới) */
  async function waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex = 0, maxMs = 28000, totalCells = 0) {
    const start = Date.now();
    const oldFirstHref = cellIndex > 0 ? getFirstListPlaceHref(getFeedPanel()) : "";
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
        `Bước ${cellIndex + 1}/${cellsHint} — đang chờ danh sách Maps... (${waited}s)`
      );
    };

    while (Date.now() - start < maxMs) {
      heartbeat();
      if (urlCenterMatchesCell(window.location.href, cellLat, cellLng)) break;
      await sleep(200);
    }

    let sawLoading = false;
    let stableRounds = 0;
    let lastCount = -1;

    while (Date.now() - start < maxMs) {
      if (isAborted) throw new Error("Đã hủy");
      heartbeat();

      const feed = getFeedPanel();
      if (isFeedLoading(feed)) {
        sawLoading = true;
        stableRounds = 0;
        lastCount = -1;
        await sleep(300);
        continue;
      }

      const count = feed ? getResultItems(feed).length : 0;
      const firstHref = getFirstListPlaceHref(feed);
      const hrefChanged = cellIndex > 0 && oldFirstHref && firstHref && firstHref !== oldFirstHref;
      const readyByChange = cellIndex > 0 && (sawLoading || hrefChanged) && count > 0;

      if (count > 0) {
        const urlOk = urlCenterMatchesCell(window.location.href, cellLat, cellLng);
        const minWait = cellIndex > 0 && Date.now() - start > 1600;
        if (cellIndex === 0 || readyByChange || (urlOk && minWait)) {
          if (count === lastCount) {
            stableRounds++;
          } else {
            stableRounds = 0;
            lastCount = count;
          }
          if (stableRounds >= 3 || (readyByChange && stableRounds >= 2)) {
            feed.scrollTop = 0;
            await sleep(T.scrollInit);
            await waitForFeedContentReady(feed, 12000);
            tbLog(`Vùng ${cellIndex + 1}: feed sẵn sàng — ${count} mục` + (hrefChanged ? " (list mới)" : ""));
            return feed;
          }
        }
      }

      await sleep(220);
    }

    const feed = getFeedPanel();
    if (feed && getResultItems(feed).length > 0) {
      feed.scrollTop = 0;
      tbLog(`Vùng ${cellIndex + 1}: dùng feed hiện có (timeout)`, "warn");
      return feed;
    }
    throw new Error("Không tìm thấy danh sách kết quả trên Google Maps");
  }

  let _lastKnownTotalCells = 1;

  async function enrichPlaceOnPage(listData, searchParams, progressText, percent, options = {}) {
    const { fast = false, quick = false, needAddress = true, needPhone = true } = options;
    if (!shieldEl) {
      showShield(progressText || `Bổ sung: ${listData?.name || ""}`, percent ?? 55);
    } else {
      updateShield(progressText || `Bổ sung: ${listData?.name || ""}`, percent ?? 55);
    }
    tbLog(`${fast ? "Nhanh" : "Bổ sung"}: ${listData?.name || "?"}`);

    if (!fast) {
      const panelReady = await waitForDetailPanel(listData);
      if (!panelReady) {
        tbLog(`Chưa load panel: ${listData?.name || "?"}`, "warn");
        await sleep(700);
      }
    } else {
      for (let i = 0; i < 8; i++) {
        if (findDetailPaneH1()) break;
        await sleep(100);
      }
    }
    await ensureDetailOverviewReady(quick || fast);

    const details = await extractPlaceDetails(listData, searchParams, {
      enrich: true,
      fast,
      quick: quick || fast,
      needAddress,
      needPhone,
      needWebsite: false
    });
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
      `${merged.name}: ${gotPhone ? "✓SĐT" : "—SĐT"} | ${merged.rating || "—"} sao | ${gotAddr ? "✓địa chỉ" : "—địa chỉ"}`
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
      if (verifyDetailMatchesList(listData) || findDetailPaneH1()) {
        await sleep(280);
        return item;
      }
      if (i === 5 || i === 12) link.click();
      await sleep(220);
    }
    return findDetailPaneH1() ? item : null;
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

    const contactWait = { address: "", phone: "" };
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

    const hasContactData =
      !!contactWait.address ||
      normalizePhone(contactWait.phone).length >= 9 ||
      !!liveAddr ||
      normalizePhone(livePhone).length >= 9;

    if (!opened && !hasContactData) {
      return null;
    }

    const preContact = {
      address: pickBestAddress(contactWait.address, liveAddr),
      phone: pickBestPhone(contactWait.phone, livePhone)
    };

    const details = await extractPlaceDetails(listData, searchParams, {
      enrich: true,
      fast,
      quick,
      needAddress,
      needPhone,
      needWebsite: false
    });
    details.address = pickBestAddress(preContact.address, details.address);
    details.phone = pickBestPhone(preContact.phone, details.phone);

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
    // Hiện tổng unique đã gửi + version để biết đã load bản mới
    sendProgress(
      pct,
      `v${window.__timDiemBanVersion || "?"} · Bước ${cellIndex + 1}/${totalCells} — ${cellLabel || "Tâm"} | ${posLabel}: ${data.name}${data.phone ? " ✓SĐT" : ""}`
    );
    if (!quiet) sendItem(data, searchParams, uniqueIndex, uniqueIndex);

    const gotPhone = normalizePhone(data.phone).length >= 9;
    const gotAddr = !!pickAddress(data.address);
    tbLog(
      `${data.name}: ${gotPhone ? "✓SĐT" : "—SĐT"} | ${data.rating || "—"} sao | ${gotAddr ? "✓địa chỉ" : "—địa chỉ"}`
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
      tbLog(`Không thấy trong list: ${place.name}`, "warn");
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
      tbLog(`Lỗi enrich: ${place.name} — ${err.message}`, "warn");
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
      `Giai đoạn 2/2 — Bổ sung ${startIndex + 1}–${startIndex + places.length}/${totalEnrich}`,
      55
    );

    let feed;
    try {
      feed = await waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex, 22000);
    } catch (err) {
      tbLog(`Không load list vùng: ${err.message}`, "warn");
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
      const progressText = `Giai đoạn 2/2 — ${globalIdx}/${totalEnrich}: ${place.name}`;
      updateShield(progressText, pct);
      tbLog(`${fast ? "⚡" : "→"} ${place.name}`);

      let item = findListItemForPlace(place, feed);
      if (!item) item = await scrollToFindListItem(place, feed);
      if (!item) {
        tbLog(`Không thấy trong list — dùng URL: ${place.name}`, "warn");
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
          try {
            chrome.runtime.sendMessage({
              action: "SEARCH_PROGRESS",
              percent: pct,
              text: `${progressText}${merged.phone ? " ✓SĐT" : ""}`
            });
          } catch {}
        } else {
          needFallback.push(place);
        }
      } catch (err) {
        tbLog(`Lỗi enrich ${place.name}: ${err.message}`, "warn");
        needFallback.push(place);
        await backToResultList(2500);
      }
    }

    tbLog(`Xong batch: ${enriched.length} quán, ${needFallback.length} cần URL`);
    return { success: true, places: enriched, needFallback };
  }

  async function scrollFeed(feed, onItems, options = {}) {
    const {
      requireEndMarker = true,
      safetyMax = 80,
      maxMs = 150000,
      fastScroll = false,
      onProgress = null
    } = options;
    const scrollPause = fastScroll ? 120 : T.scroll;
    const scrollInitPause = fastScroll ? 80 : T.scrollInit;
    const staleLimit = requireEndMarker ? 999 : fastScroll ? 8 : 10;
    const staleHardLimit = requireEndMarker ? 30 : fastScroll ? 14 : 18;
    const settleMs = fastScroll ? 2500 : 5000;
    const endConfirmMs = fastScroll ? 900 : 2000;
    const stepRatio = fastScroll ? 0.75 : 0.65;
    const stepMin = fastScroll ? 320 : 280;
    let lastTotal = 0;
    let staleBottomRounds = 0;
    let lastScrollHeight = 0;
    const scrollStart = Date.now();
    feed = getFeedPanel() || feed;
    if (feed) {
      feed.scrollTop = 0;
      await sleep(scrollInitPause);
      await waitForFeedContentReady(feed, settleMs);
    }

    for (let round = 0; round < safetyMax; round++) {
      if (isAborted) break;
      if (Date.now() - scrollStart > maxMs) {
        tbLog(`Dừng cuộn — hết ${maxMs / 1000}s`);
        break;
      }

      feed = getFeedPanel();
      if (!feed?.isConnected) {
        try {
          feed = await waitForFeed(5000);
        } catch {
          break;
        }
      }
      if (!feed) break;

      await waitForFeedContentReady(feed, settleMs);

      const found = await onItems(feed, round);
      if (typeof onProgress === "function") onProgress(found.total, round);

      const maxScroll = Math.max(0, feed.scrollHeight - feed.clientHeight);
      const atBottom = feed.scrollTop >= maxScroll - 40;

      if (feed.scrollHeight > lastScrollHeight + 30) {
        staleBottomRounds = 0;
        lastScrollHeight = feed.scrollHeight;
      }

      if (found.total > lastTotal) {
        lastTotal = found.total;
        staleBottomRounds = 0;
      } else if (atBottom) {
        staleBottomRounds++;
      }

      if (atBottom) {
        // Bước 1: Chờ feed load xong hoàn toàn
        await waitForFeedContentReady(feed, settleMs);
        
        // Bước 2: Cuộn nhẹ xuống đáy để trigger Google Maps load thêm
        feed.scrollTop = feed.scrollHeight;
        await sleep(400);
        
        // Bước 3: Chờ lại — nếu Google Maps đang load thêm item
        if (isFeedLoading(feed)) {
          await waitForFeedContentReady(feed, settleMs);
          // Sau khi load xong, feed có thể dài hơn → chưa phải đáy thật
          const newMaxScroll = Math.max(0, feed.scrollHeight - feed.clientHeight);
          if (feed.scrollTop < newMaxScroll - 40) {
            // Feed dài thêm → tiếp tục cuộn, không check end marker
            staleBottomRounds = 0;
            const afterLoad = await onItems(feed, round);
            if (afterLoad.total > lastTotal) {
              lastTotal = afterLoad.total;
              staleBottomRounds = 0;
            }
            await sleep(scrollPause);
            continue;
          }
        }
        
        // Bước 4: Feed đã load xong, thật sự ở đáy — giờ mới check end marker
        await sleep(300);
        feed.scrollTop = feed.scrollHeight;
        await sleep(200);
        const afterNudge = await onItems(feed, round);
        
        if (hasEndMarker(feed)) {
          // Thấy end marker — nhưng phải đảm bảo feed THẬT SỰ không còn load
          tbLog(`Thấy "hết danh sách" — ${afterNudge.total} quán, xác nhận...`);
          
          // Chờ thêm rồi kiểm tra lại
          await sleep(endConfirmMs);
          await waitForFeedContentReady(feed, 4000);
          feed.scrollTop = feed.scrollHeight;
          await sleep(500);
          
          const finalCheck = await onItems(feed, round);
          
          // Kiểm tra end marker lần cuối SAU KHI chờ load
          if (hasEndMarker(feed) && !isFeedLoading(feed)) {
            tbLog(`Xác nhận hết danh sách — tổng ${finalCheck.total} quán`);
            break;
          } else {
            tbLog(`End marker biến mất sau khi chờ — tiếp tục cuộn`);
            staleBottomRounds = 0;
            await sleep(scrollPause);
            continue;
          }
        }
        
        if (!requireEndMarker) break;
        if (staleBottomRounds >= staleLimit && found.total > 0) {
          tbLog(`Dừng cuộn — list ổn định ở đáy (${found.total} quán, ${staleBottomRounds} vòng)`);
          await onItems(feed, round);
          break;
        }
        if (staleBottomRounds >= staleHardLimit) {
          tbLog(`Dừng cuộn — quá nhiều vòng ở đáy (${staleBottomRounds} vòng, chưa thấy hết list)`);
          await onItems(feed, round);
          break;
        }
        await sleep(scrollPause + 200);
        continue;
      }

      const step = feedScrollStep(feed, stepRatio, stepMin);
      feed.scrollTop = Math.min(feed.scrollTop + step, feed.scrollHeight);
      await sleep(scrollPause);
    }
    return feed;
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
    searchUrl = ""
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
    const processed = new Set();
    let clickAttempts = 0;
    let skippedCount = 0;
    let detailIdx = 0;
    const maxPerCell = parseInt(searchParams.maxPlacesPerCell, 10) || 0;
    const fastMode = !!searchParams.fastMode;

    const mapLat = cellLat ?? searchParams.lat;
    const mapLng = cellLng ?? searchParams.lng;
    const cellDist =
      mapLat != null && mapLng != null
        ? haversineDistance(searchParams.lat, searchParams.lng, mapLat, mapLng)
        : 0;

    feed = await waitForCellFeedReady(searchUrl, mapLat, mapLng, cellIndex);
    if (!feed) {
      try {
        feed = await waitForFeed(20000);
      } catch (err) {
        console.warn(`TimDiemBan ${cellLabel}: không có feed`, err);
        return { places: [], skippedCount: 0, clickAttempts: 0, earlyExit: true };
      }
    }
    await sleep(120);

    sendProgress(
      calcProgressPercent(cellIndex, totalCells, 0.05),
      `Bước ${cellIndex + 1}/${totalCells} — ${cellLabel} | Cuộn list...`
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

    const collectOnly = async (panel) => {
      let newInRound = 0;
      for (const item of getResultItems(panel)) {
        if (isAborted) break;
        if (maxPerCell > 0 && pending.size >= maxPerCell) break;

        const listData = extractListItemData(item);
        if (!listData?.name) continue;
        if (isAlreadyCollected(listData, seenTrack, seenKeys, seenCanonical, results)) {
          skippedCount++;
          continue;
        }

        const track = getItemTrackKey(listData);
        if (pending.has(track)) continue;

        const place = buildPlaceFromList(listData);
        if (!place) continue;

        pending.set(track, { listData, place });
        newInRound++;
      }
      return { newCount: newInRound, total: pending.size };
    };

    const onScrollProgress = (total, round) => {
      const ratio = Math.min(0.42, 0.05 + round * 0.008);
      sendProgress(
        calcProgressPercent(cellIndex, totalCells, ratio),
        `Bước ${cellIndex + 1}/${totalCells} — ${cellLabel} | Cuộn... ${total} quán`
      );
    };

    feed = await scrollFeed(feed, collectOnly, {
      requireEndMarker: true,
      safetyMax: fastMode ? 55 : 80,
      maxMs: fastMode ? 90000 : 150000,
      fastScroll: fastMode,
      onProgress: onScrollProgress
    });

    if (pending.size === 0 && !hasEndMarker(feed)) {
      tbLog(`${cellLabel}: chưa có kết quả — cuộn thêm...`);
      feed = await scrollFeed(feed, collectOnly, {
        requireEndMarker: false,
        safetyMax: fastMode ? 28 : 40,
        maxMs: fastMode ? 35000 : 60000,
        fastScroll: fastMode
      });
    }

    if (pending.size > 0) {
      sendProgress(
        calcProgressPercent(cellIndex, totalCells, 0.48),
        `Bước ${cellIndex + 1}/${totalCells} — ${cellLabel} | Lấy chi tiết ${pending.size} quán...`
      );
      if (feed) {
        feed.scrollTop = 0;
        await waitForFeedContentReady(feed, 12000);
      }
    }

    const scrapeOneFromList = async (item, listData, place) => {
      const track = getItemTrackKey(listData);
      if (processed.has(track)) return false;

      processed.add(track);
      clickAttempts++;
      detailIdx++;

      sendProgress(
        calcProgressPercent(cellIndex, totalCells, 0.48 + Math.min(detailIdx / Math.max(pending.size, 1), 0.48)),
        `Bước ${cellIndex + 1}/${totalCells} — ${cellLabel} | #${detailIdx}/${pending.size}: ${place.name}`
      );

      try {
        const data = await scrapeItemInPlace(
          item,
          listData,
          searchParams,
          detailIdx,
          cellIndex,
          totalCells,
          cellLabel,
          mapLat,
          mapLng,
          {
            quiet: false,
            fast: fastMode,
            quick: fastMode,
            needAddress: !fastMode,
            needPhone: true,
            searchUrl,
            totalInCell: pending.size
          }
        );
        if (data) {
          mergePlaceRecord(place, data);
          place._phase = "detail";
          place.name = cleanPlaceName(data.name || place.name);
          place.phone = data.phone || place.phone || "";
          const mergedAddr = pickBestAddress(data.address, place.address);
          place.address = mergedAddr || "";
          place.rating = data.rating || place.rating || "";
          place.reviews = data.reviews || place.reviews || "";
        } else {
          place._phase = "list";
          place.name = cleanPlaceName(place.name);
          if (!hasReliableAddress(place.address)) place.address = "";
        }
      } catch (err) {
        console.warn("TimDiemBan detail:", place.name, err.message);
        place._phase = "list";
        if (!hasReliableAddress(place.address)) place.address = "";
        await prepareForNextListClick({ searchUrl, cellLat: mapLat, cellLng: mapLng, cellIndex, maxBackMs: 2000 });
      }

      markCollected(listData, place, seenTrack, seenKeys, seenCanonical);
      if (typeof sanitizeAddressField === "function") {
        place.address = sanitizeAddressField(place.address);
      }
      results.push(place);
      if (!place._webSent) {
        sendItem(place, searchParams, detailIdx, pending.size);
      }
      return true;
    };

    for (const { listData, place } of pending.values()) {
      if (isAborted) break;
      if (maxPerCell > 0 && results.length >= maxPerCell) break;

      let item = findListItemForPlace(listData, getFeedPanel());
      if (!item) {
        item = await scrollToFindListItem(listData, getFeedPanel(), fastMode ? 5000 : 9000);
      }
      if (!item) {
        markCollected(listData, place, seenTrack, seenKeys, seenCanonical);
        if (typeof sanitizeAddressField === "function") {
          place.address = sanitizeAddressField(place.address);
        }
        results.push(place);
        sendItem(place, searchParams, results.length, pending.size);
        continue;
      }

      await scrapeOneFromList(item, listData, place);
    }

    if (results.length > 0) {
      sendProgress(
        calcProgressPercent(cellIndex, totalCells, 0.96),
        `Bước ${cellIndex + 1}/${totalCells} — ${cellLabel} | ${results.length} quán`
      );
    }

    tbLog(`${cellLabel}: xong ${results.length} quán (${clickAttempts} click)`);
    return { places: results, skippedCount, clickAttempts, earlyExit: false };
  }

  async function waitForFeed(maxMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const feed = getFeedPanel();
      if (feed && getResultItems(feed).length > 0) return feed;
      await sleep(300);
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
      searchUrl
    } = data;
    isAborted = false;
    if (totalCells > 0) _lastKnownTotalCells = totalCells;
    const label = cellLabel || cellId || `Vùng ${cellIndex + 1}`;
    showShield(`Ô ${cellIndex + 1}/${totalCells}: ${label} — cuộn + lấy DOM`, 2, {
      webUrl: searchParams?.webUrl
    });
    sendProgress(
      calcProgressPercent(cellIndex, totalCells, 0.03),
      `Bước ${cellIndex + 1}/${totalCells} — ${label} | Đang chờ danh sách Maps...`
    );

    const feed = await waitForCellFeedReady(searchUrl, cellLat, cellLng, cellIndex, 28000, totalCells);
    const outcome = await scrollAndScrapePlaces(
      feed,
      searchParams,
      cellIndex,
      totalCells,
      globalSeen || [],
      label,
      cellLat,
      cellLng,
      searchUrl || ""
    );

    return {
      success: true,
      places: outcome.places,
      skippedCount: outcome.skippedCount,
      clickAttempts: outcome.clickAttempts,
      cellIndex,
      totalCells,
      cellLabel: label
    };
  }

  window.__timDiemBanWake = function () {
    startAntiThrottle();
    if (scrapeInProgress && document.hidden) startBackgroundWakeLoop();
    document.dispatchEvent(new CustomEvent("timdiemban-wake", { bubbles: true }));
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "PING") {
      sendResponse({ ok: true, v: window.__timDiemBanVersion || 0 });
      return;
    }
    if (message.action === "KEEPALIVE_TICK") {
      window.__timDiemBanWake();
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "SCRAPE_ABORT") {
      abortScrape();
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
      scrapeCellList(message.data)
        .then((outcome) => sendResponse(outcome || { success: false }))
        .catch((err) => {
          hideShield();
          console.warn("SCRAPE_CELL_LIST:", err.message);
          sendResponse({ success: false, places: [], error: err.message });
        });
      return true;
    }
    if (message.action === "ENRICH_PLACE") {
      const { listData, searchParams, progressText, percent, fast = false } = message.data || {};
      const profile = typeof getEnrichProfile === "function" ? getEnrichProfile(listData) : null;
      enrichPlaceOnPage(listData, searchParams, progressText, percent, {
        fast: fast || profile?.fast,
        quick: profile?.quick,
        needAddress: profile?.needAddress !== false,
        needPhone: profile?.needPhone !== false
      })
        .then((place) => sendResponse({ success: !!place, place }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
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
  });
})();

