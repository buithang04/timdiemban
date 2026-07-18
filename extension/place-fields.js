/**
 * place-fields.js — chuẩn hóa địa chỉ / SĐT / enrich (dùng chung background + content).
 * Load trước grid.js / content.js.
 */
(function (root) {
  "use strict";

  function foldTextForMatch(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .trim();
  }

  function isVisitedLinkText(text) {
    const folded = foldTextForMatch(text);
    if (!folded) return false;
    return (
      /duong\s+lien\s+ket(\s+da)?\s+truy\s*c?ap/.test(folded) ||
      /visited\s+link/.test(folded)
    );
  }

  function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "");
  }

  function formatPhoneVN(phone) {
    const digits = normalizePhone(phone);
    if (digits.length < 9) return String(phone || "").trim();
    let d = digits;
    if (d.startsWith("84") && d.length >= 11) d = "0" + d.slice(2);
    if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
    if (d.length === 10 && d.startsWith("0")) {
      return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`.trim();
    }
    return d;
  }

  /** Nhãn UI Maps — không dùng \\b (lệch với tiếng Việt). */
  // (strip dùng isPureUiToken / đầu-cuỗi — tránh xóa "Đường Website")


  function stripPhoneFromAddress(text) {
    let t = String(text || "").trim();
    if (!t) return "";
    t = t.replace(/\s+(?:\+?84|0)[\d\s.\-()]{8,20}\s*$/i, "").trim();
    t = t.replace(/\s+\d{2,4}(?:[\s.\-]\d{2,4}){2,4}\s*$/i, "").trim();
    t = t.replace(/^(?:\+?84|0)[\d\s.\-()]{8,20}\s*/i, "").trim();
    t = t.replace(/^\d{2,4}(?:[\s.\-]\d{2,4}){2,4}\s*/i, "").trim();
    return t;
  }

  function isPureUiToken(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    return /^(trang\s*web|website|đường\s*đi|directions|gửi tới điện thoại|send to (your )?phone|chia sẻ|share|tổng quan|overview|bài đánh giá|reviews?|giới thiệu|about|gần đó|nearby|xem ảnh|see photos?|lưu|save|đặt chỗ|order|menu|thực đơn|sao chép.*|copy.*)$/i.test(
      t
    );
  }

  function stripMapsUiChromeFromAddress(text) {
    let t = String(text || "").trim();
    if (!t) return "";
    // Tách theo · — bỏ segment chỉ là nhãn UI (không đụng tên đường chứa "Website")
    if (/[·]/.test(t)) {
      t = t
        .split("·")
        .map((s) => s.trim())
        .filter((s) => s && !isPureUiToken(s) && !isMapsUiLabel(s))
        .join(", ");
    }
    // Chỉ gỡ nhãn UI ở đầu/cuối — không xóa giữa câu (vd: "Đường Website, …")
    let prev;
    do {
      prev = t;
      t = t
        .replace(
          /[\s,;|/]+(trang\s*web|website|đường\s*đi|directions|gửi tới điện thoại|chia sẻ|share|tổng quan|overview|bài đánh giá|reviews?|giới thiệu|about|gần đó|nearby)\s*$/i,
          ""
        )
        .trim();
    } while (t !== prev);
    do {
      prev = t;
      t = t
        .replace(
          /^(trang\s*web|website|đường\s*đi|directions|gửi tới điện thoại|chia sẻ|share|tổng quan|overview|bài đánh giá|reviews?|giới thiệu|about|gần đó|nearby)[\s,;|/]+/i,
          ""
        )
        .trim();
    } while (t !== prev);
    t = t.replace(/\s{2,}/g, " ").replace(/^[\s,·\-–]+|[\s,·\-–]+$/g, "").trim();
    if (isPureUiToken(t) || isMapsUiLabel(t)) return "";
    return t;
  }

  function isCoordinateOnlyText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/^@?-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+(?:,\d+z)?$/i.test(t)) return true;
    if (/^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(t)) return true;
    return false;
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

  function decodeContactValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Đọc SĐT từ metadata của một dòng liên hệ Google Maps.
   * Maps có thể render cùng dữ liệu dưới button[data-item-id], link tel: hoặc aria-label.
   */
  function extractPhoneFromContactMeta(meta = {}) {
    const itemId = decodeContactValue(meta.itemId || meta.dataItemId);
    const href = decodeContactValue(meta.href);
    const sources = [];

    if (/^tel:/i.test(href)) {
      sources.push(href.replace(/^tel:/i, "").split(/[;?]/, 1)[0]);
    }

    const itemPhone = itemId.match(/(?:^|:)phone:tel:([^;?]+)/i);
    if (itemPhone) sources.push(itemPhone[1]);

    sources.push(
      meta.ariaLabel,
      meta.title,
      meta.tooltip,
      meta.text
    );

    for (const source of sources) {
      const phone = extractPhoneFromText(decodeContactValue(source));
      if (normalizePhone(phone).length >= 9) return formatPhoneVN(phone);
    }
    return "";
  }

  function isPhoneContactMeta(meta = {}) {
    if (extractPhoneFromContactMeta(meta)) return true;
    const itemId = String(meta.itemId || meta.dataItemId || "").toLowerCase();
    const href = String(meta.href || "").toLowerCase();
    const label = foldTextForMatch(
      [meta.ariaLabel, meta.title, meta.tooltip].filter(Boolean).join(" ")
    );
    if (itemId.startsWith("phone") || href.startsWith("tel:")) return true;
    return /^(so\s*)?(dien thoai|phone)(\s*(number))?\s*:/.test(label) ||
      /^(sao chep|copy)\s+(so\s+)?(dien thoai|phone)/.test(label) ||
      /^(goi|call)\s+(so\s+)?(dien thoai|phone|\+?\d|0\d)/.test(label);
  }

  function extractPhoneFromListText(text) {
    const phone = extractPhoneFromText(text);
    return normalizePhone(phone).length >= 9 ? formatPhoneVN(phone) : "";
  }

  /** Không kết luận "không có SĐT" khi vùng liên hệ vẫn đang render. */
  function shouldKeepWaitingForPhone(state = {}) {
    if (state.needPhone === false || normalizePhone(state.phone).length >= 9) return false;
    const elapsedMs = Math.max(0, Number(state.elapsedMs) || 0);
    const maxMs = Math.max(0, Number(state.maxMs) || 0);
    if (maxMs > 0 && elapsedMs >= maxMs) return false;
    if (state.phoneElementExists) return true;

    const contactFieldsAgeMs = Math.max(0, Number(state.contactFieldsAgeMs) || 0);
    const contactStableMs = Math.max(0, Number(state.contactStableMs) || 0);
    const minAbsentWaitMs = Math.max(0, Number(state.minAbsentWaitMs) || 1800);
    const stableWaitMs = Math.max(0, Number(state.stableWaitMs) || 900);
    return contactFieldsAgeMs < minAbsentWaitMs || contactStableMs < stableWaitMs;
  }

  function isMapsUiLabel(text) {
    const t = String(text || "").trim();
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

  function hasStreetKeyword(text) {
    // "đường đi" = Directions — không tính là tên đường
    return /phố|đường(?!\s*đi)|đ\.|d\.|ngõ|ngách|hẻm|quận|huyện|thành phố|thị trấn|thôn|xã|ấp|khu|lô|tổ|p\.|tp\.|ward|district|street|road|ave|vietnam|việt nam/i.test(
      String(text || "")
    );
  }

  function isMapsUiChromeText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (
      /tổng quan.*bài đánh giá|overview.*reviews?|giới thiệu.*đường đi|about.*directions/i.test(t)
    ) {
      return true;
    }
    if (/gửi tới điện thoại|send to.*phone/i.test(t) && /tổng quan|overview|chia sẻ|share/i.test(t)) {
      return true;
    }
    const hasPhone = /(?:\+?84|0)[\d\s.\-]{8,}|^\d{2,4}(?:[\s.\-]\d{2,4}){2,}/.test(t);
    const hasUiChrome = /(trang\s*web|website|đường\s*đi|directions)/i.test(t);
    if (hasPhone && hasUiChrome) return true;
    if (hasUiChrome && !/,|phường|quận|huyện|thành phố|việt nam|vietnam/i.test(t) && t.length < 80) {
      return true;
    }
    const parts = t.split(/[,·]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return isMapsUiLabel(t);
    const uiHits = parts.filter(
      (p) =>
        isMapsUiLabel(p) ||
        /^(đường đi|directions|gần đó|nearby|gửi|send|chia sẻ|share|xem ảnh|trang web|website)/i.test(p)
    ).length;
    if (uiHits >= 2) return true;
    if (uiHits >= 1 && parts.length >= 3 && !hasStreetKeyword(t) && !/,/.test(t)) return true;
    return false;
  }

  function isGarbageAddressText(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (isVisitedLinkText(t)) return true;
    if (isCoordinateOnlyText(t)) return true;
    if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) return true;
    if (/đường liên kết đã truy cập|visited link/i.test(t)) return true;
    if (/mua sắm tại cửa hàng|shop in store|in-store shopping/i.test(t)) return true;
    if (/tổng quan|overview|bài đánh giá|reviews?|giới thiệu|about|gần đó|nearby/i.test(t)) return true;
    if (/(trang\s*web|website)/i.test(t) && /(đường\s*đi|directions)/i.test(t)) return true;
    if (/^(đường\s*đi|directions|trang\s*web|website)$/i.test(t)) return true;
    const digits = (t.match(/\d/g) || []).length;
    const letters = (t.replace(/[^\p{L}]/gu, "") || "").length;
    if (/(?:\+?84|0)[\d\s.\-]{8,}/.test(t) && digits >= 9 && letters < 12) return true;
    if (/\d[.,]\d\s*\(\d+\)/.test(t)) return true;
    if (/\d[.,]\d\s*\/\s*(cửa hàng|shop|store|tạp hóa|bách hóa|siêu thị|quán|tiệm)/i.test(t)) {
      return true;
    }
    if (
      /(cửa hàng tiện lợi|convenience store|bách hóa|tạp hóa|siêu thị)/i.test(t) &&
      !/,.*(quận|huyện|phường|thành phố|hà nội|việt nam|vietnam)/i.test(t)
    ) {
      return true;
    }
    if (
      /[A-Za-zÀ-ỹ].*\/.*[A-Za-zÀ-ỹ]/.test(t) &&
      !/,|quận|huyện|phường|đường(?!\s*đi)|phố|việt nam|vietnam/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  function sanitizeAddressField(address) {
    let a = String(address || "").trim();
    if (!a) return "";
    if (isVisitedLinkText(a)) return "";
    const folded = foldTextForMatch(a);
    if (/mua\s+sam\s+tai\s+cua\s+hang|shop\s+in\s+store|in-?store\s+shopping/.test(folded)) {
      return "";
    }
    if (isMapsUiChromeText(a) || isGarbageAddressText(a)) {
      a = stripMapsUiChromeFromAddress(stripPhoneFromAddress(a));
      if (!a || isMapsUiChromeText(a) || isGarbageAddressText(a)) return "";
    } else {
      a = stripMapsUiChromeFromAddress(stripPhoneFromAddress(a));
    }
    if (!a) return "";
    if (/(trang\s*web|website)/i.test(a) && /(đường\s*đi|directions)/i.test(a)) return "";
    if (/^(đường\s*đi|directions|trang\s*web|website)$/i.test(a)) return "";
    const digits = (a.match(/\d/g) || []).length;
    const letters = (a.replace(/[^\p{L}]/gu, "") || "").length;
    if (/(?:\+?84|0)[\d\s.\-]{8,}/.test(a) && digits >= 9 && letters < 12) return "";
    return a;
  }

  function isValidAddressField(address) {
    const a = sanitizeAddressField(address);
    if (!a || a.length < 6) return false;
    if (isVisitedLinkText(a)) return false;
    if (isCoordinateOnlyText(a)) return false;
    if (isGarbageAddressText(a) || isMapsUiChromeText(a)) return false;
    if (/mở cửa|đóng cửa|đang mở|^["'""]/i.test(a)) return false;
    if (/^\d[.,]\d\s*\(/.test(a)) return false;
    if (/\d[.,]\d\s*\(\d+\)/.test(a)) return false;
    if (/(trang\s*web|website|đường\s*đi|directions)/i.test(a) && a.length < 40) {
      // Cho phép tên đường chứa "Website"; chỉ loại khi thiếu tín hiệu địa chỉ thật
      if (!/,/.test(a) && !/quận|huyện|phường|thành phố|tỉnh|việt nam|vietnam/i.test(a)) {
        return false;
      }
    }
    // Chỉ có tọa độ / số thập phân — không phải địa chỉ
    if (/^-?\d+\.\d+\s*,\s*-?\d+\.\d+/.test(a) && !hasStreetKeyword(a)) return false;
    return (
      /,/.test(a) ||
      hasStreetKeyword(a) ||
      /sn\.|số\s*\d/i.test(a) ||
      /\d+\s+[\p{L}]/u.test(a)
    );
  }

  function isSuspectAddress(address) {
    const a = String(address || "").trim();
    if (!a) return true;
    if (isValidAddressField(a)) return false;
    if (/mở cửa|đóng cửa|^["'""]/i.test(a) && !/,/.test(a)) return true;
    if (/^\d[.,]\d/.test(a)) return true;
    return a.length < 8;
  }

  function recoverContactFieldsFromAddress(place) {
    if (!place) return place;
    const rawAddr = String(place.address || "").trim();
    if (!rawAddr) return place;

    const phoneFromAddr = extractPhoneFromText(rawAddr);
    if (phoneFromAddr && normalizePhone(place.phone).length < 9) {
      place.phone = formatPhoneVN(phoneFromAddr);
    }
    place.address = sanitizeAddressField(rawAddr);
    return place;
  }

  function pickBetterPhone(a, b) {
    const pa = normalizePhone(a).length >= 9;
    const pb = normalizePhone(b).length >= 9;
    // Cả hai hợp lệ → giữ a (không để SĐT tách từ địa chỉ rác ghi đè SĐT đã có)
    if (pa && pb) return String(a || "").trim();
    if (pb) return String(b || "").trim();
    if (pa) return String(a || "").trim();
    return String(b || a || "").trim();
  }

  function pickBetterAddress(a, b) {
    const reject = (t) => {
      const s = sanitizeAddressField(t);
      if (!s) return true;
      if (isVisitedLinkText(s) || isGarbageAddressText(s) || isMapsUiChromeText(s)) return true;
      if (/mở cửa|đóng cửa|đang mở|^["'""]/i.test(s)) return true;
      if (/^\d[.,]\d\s*\(/.test(s) || /\d[.,]\d\s*\(\d+\)/.test(s)) return true;
      return false;
    };
    if (reject(a) && reject(b)) return sanitizeAddressField(a) || sanitizeAddressField(b);
    if (reject(a)) return sanitizeAddressField(b);
    if (reject(b)) return sanitizeAddressField(a);
    const aClean = sanitizeAddressField(a);
    const bClean = sanitizeAddressField(b);
    const aOk = isValidAddressField(aClean);
    const bOk = isValidAddressField(bClean);
    if (aOk && !bOk) return aClean;
    if (bOk && !aOk) return bClean;
    const score = (t) => {
      const s = sanitizeAddressField(t);
      if (!s) return -1;
      if (/mở cửa|đóng cửa|đang mở/i.test(s)) return 0;
      if (/^["'""]/.test(s)) return 0;
      if (/^\d[.,]\d\s*\(/.test(s)) return 1;
      if (/,.*(việt nam|vietnam|hà nội|quận|huyện|phường|thành phố)/i.test(s)) return 80 + s.length;
      if (/,|phố|đường(?!\s*đi)|quận|huyện/i.test(s)) return 10 + s.length;
      if (/^\d+[\w\s./-]*?(p\.|đ\.|ng\.)/i.test(s) && !/,/.test(s)) return 2 + s.length;
      return 3 + s.length;
    };
    const sa = score(a);
    const sb = score(b);
    if (sa >= sb) return aClean || bClean;
    return bClean || aClean;
  }

  function getEnrichProfile(p) {
    if (!p) return null;
    const recovered = recoverContactFieldsFromAddress({ ...p, address: p.address, phone: p.phone });
    const phoneOk = normalizePhone(recovered.phone).length >= 9;
    const ratingOk = !!(p.rating && /\d/.test(String(p.rating)));
    const reviewsOk = !!(p.reviews && String(p.reviews).replace(/\D/g, "").length > 0);
    const addrOk = isValidAddressField(recovered.address) && !isSuspectAddress(recovered.address);

    if (phoneOk && ratingOk && reviewsOk && addrOk) return null;

    return {
      fast: ratingOk && reviewsOk,
      quick: ratingOk && reviewsOk && addrOk,
      needPhone: !phoneOk,
      needRating: !ratingOk,
      needReviews: !reviewsOk,
      needAddress: !addrOk || isSuspectAddress(recovered.address),
      needWebsite: false
    };
  }

  function placeNeedsEnrich(p) {
    return getEnrichProfile(p) != null;
  }

  const api = {
    foldTextForMatch,
    isVisitedLinkText,
    normalizePhone,
    formatPhoneVN,
    stripPhoneFromAddress,
    stripMapsUiChromeFromAddress,
    extractPhoneFromText,
    extractPhoneFromContactMeta,
    isPhoneContactMeta,
    extractPhoneFromListText,
    shouldKeepWaitingForPhone,
    isMapsUiLabel,
    isMapsUiChromeText,
    isGarbageAddressText,
    hasStreetKeyword,
    isPureUiToken,
    isCoordinateOnlyText,
    sanitizeAddressField,
    isValidAddressField,
    isSuspectAddress,
    recoverContactFieldsFromAddress,
    pickBetterPhone,
    pickBetterAddress,
    getEnrichProfile,
    placeNeedsEnrich
  };

  root.PlaceFields = api;
  // Expose globals for existing grid.js / content.js / background.js callers
  Object.keys(api).forEach((k) => {
    root[k] = api[k];
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
