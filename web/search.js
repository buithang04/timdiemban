/**
 * Form tìm kiếm trên trang kết quả — gửi lệnh tới extension qua web-bridge.
 */
(function () {
  const MIN_RADIUS_KM = 0.5;
  const MAX_RADIUS_KM = 20;
  const LAST_SEARCH_KEY = "timdiemban_last_search";
  const MAPS_AUTO_FOCUS_KEY = "timdiemban_maps_auto_focus";
  const MAPS_AUTO_REOPEN_KEY = "timdiemban_maps_auto_reopen";
  const SEARCH_OPTIONS_OPEN_KEY = "timdiemban_search_options_open";

  const els = {
    form: document.getElementById("searchForm"),
    keyword: document.getElementById("searchKeyword"),
    radius: document.getElementById("searchRadius"),
    lat: document.getElementById("searchLat"),
    lng: document.getElementById("searchLng"),
    centerPreview: document.getElementById("centerPreview"),
    btnFromMaps: document.getElementById("btnFromMaps"),
    btnFromGps: document.getElementById("btnFromGps"),
    btnPickCenter: document.getElementById("btnPickCenter"),
    startBtn: document.getElementById("startSearchBtn"),
    cancelSearchBtn: document.getElementById("cancelSearchBtn"),
    searchStatus: document.getElementById("searchStatus"),
    searchProgress: document.getElementById("searchProgress"),
    searchProgressBar: document.getElementById("searchProgressBar"),
    searchProgressText: document.getElementById("searchProgressText"),
    scrapeLog: document.getElementById("scrapeLog"),
    extHint: document.getElementById("extHint"),
    mapsFocusModal: document.getElementById("mapsFocusModal"),
    mapsFocusModalOk: document.getElementById("mapsFocusModalOk"),
    mapsFocusModalClose: document.getElementById("mapsFocusModalClose"),
    gpsDeniedModal: document.getElementById("gpsDeniedModal"),
    gpsDeniedModalOk: document.getElementById("gpsDeniedModalOk"),
    gpsDeniedModalClose: document.getElementById("gpsDeniedModalClose"),
    mapsAutoFocus: document.getElementById("searchMapsAutoFocus"),
    mapsAutoFocusLabel: document.getElementById("searchMapsAutoFocusLabel"),
    mapsAutoReopen: document.getElementById("searchMapsAutoReopen"),
    mapsAutoReopenLabel: document.getElementById("searchMapsAutoReopenLabel"),
    searchOptionsPanel: document.getElementById("searchOptionsPanel"),
    searchOptionsToggle: document.getElementById("searchOptionsToggle"),
    searchOptionsBody: document.getElementById("searchOptionsBody"),
    searchOptionsHint: document.getElementById("searchOptionsHint"),
    fastMode: document.getElementById("searchFastMode")
  };

  function getMapsAutoFocusMinutes() {
    const n = Number(window.TIMDIEMBAN_CONFIG?.MAPS_AUTO_FOCUS_MINUTES);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  }

  function isMapsAutoFocusChecked() {
    return !!els.mapsAutoFocus?.checked;
  }

  function loadMapsAutoFocusPref() {
    try {
      if (!els.mapsAutoFocus) return;
      const saved = localStorage.getItem(MAPS_AUTO_FOCUS_KEY);
      // Chỉ focus để phục hồi khi Maps thật sự ngừng phản hồi.
      els.mapsAutoFocus.checked = saved == null ? true : saved === "1";
      if (saved == null) localStorage.setItem(MAPS_AUTO_FOCUS_KEY, "1");
    } catch {}
    updateMapsAutoFocusLabel();
  }

  function saveMapsAutoFocusPref() {
    try {
      localStorage.setItem(MAPS_AUTO_FOCUS_KEY, isMapsAutoFocusChecked() ? "1" : "0");
    } catch {}
  }

  function updateMapsAutoFocusLabel() {
    if (!els.mapsAutoFocusLabel) return;
    els.mapsAutoFocusLabel.textContent =
      "Chỉ đưa Google Maps lên trước khi không phản hồi trong 5 phút hoặc thao tác thất bại. Bình thường bạn có thể làm việc ở tab khác.";
  }

  function syncMapsAutoFocusCheckbox(enabled) {
    if (!els.mapsAutoFocus || els.mapsAutoFocus.checked === enabled) return;
    els.mapsAutoFocus.checked = enabled;
    saveMapsAutoFocusPref();
    updateSearchOptionsHint();
  }

  function postMapsAutoFocus(enabled) {
    postToExt("SET_MAPS_AUTO_FOCUS", { enabled });
  }

  function isMapsAutoReopenChecked() {
    return !!els.mapsAutoReopen?.checked;
  }

  function loadMapsAutoReopenPref() {
    try {
      if (!els.mapsAutoReopen) return;
      const saved = localStorage.getItem(MAPS_AUTO_REOPEN_KEY);
      // Tự khôi phục là mặc định an toàn cho các lượt quét kéo dài.
      els.mapsAutoReopen.checked = saved == null ? true : saved === "1";
      if (saved == null) localStorage.setItem(MAPS_AUTO_REOPEN_KEY, "1");
    } catch {}
    updateMapsAutoReopenLabel();
  }

  function saveMapsAutoReopenPref() {
    try {
      localStorage.setItem(MAPS_AUTO_REOPEN_KEY, isMapsAutoReopenChecked() ? "1" : "0");
    } catch {}
  }

  function updateMapsAutoReopenLabel() {
    if (!els.mapsAutoReopenLabel) return;
    const max = Number(window.TIMDIEMBAN_CONFIG?.MAPS_AUTO_REOPEN_MAX);
    const maxN = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 5;
    els.mapsAutoReopenLabel.textContent = `Nếu tab Maps bị đóng, tự mở lại ở nền để tiếp tục; tối đa ${maxN} lần. Quá giới hạn sẽ dừng và giữ kết quả đã có.`;
  }

  function syncMapsAutoReopenCheckbox(enabled) {
    if (!els.mapsAutoReopen || els.mapsAutoReopen.checked === enabled) return;
    els.mapsAutoReopen.checked = enabled;
    saveMapsAutoReopenPref();
    updateSearchOptionsHint();
  }

  function postMapsAutoReopen(enabled) {
    postToExt("SET_MAPS_AUTO_REOPEN", { enabled });
  }

  function isSearchOptionsOpen() {
    return els.searchOptionsPanel?.classList.contains("is-open");
  }

  function setSearchOptionsOpen(open, persist = true) {
    if (!els.searchOptionsPanel || !els.searchOptionsBody || !els.searchOptionsToggle) return;
    els.searchOptionsPanel.classList.toggle("is-open", open);
    els.searchOptionsBody.classList.toggle("hidden", !open);
    els.searchOptionsToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (persist) {
      try {
        localStorage.setItem(SEARCH_OPTIONS_OPEN_KEY, open ? "1" : "0");
      } catch {}
    }
  }

  function loadSearchOptionsOpen() {
    try {
      setSearchOptionsOpen(localStorage.getItem(SEARCH_OPTIONS_OPEN_KEY) === "1", false);
    } catch {
      setSearchOptionsOpen(false, false);
    }
  }

  function updateSearchOptionsHint() {
    if (!els.searchOptionsHint) return;
    const tags = [];
    if (els.fastMode?.checked) tags.push("Nhanh");
    if (els.mapsAutoFocus?.checked) tags.push("Khôi phục Maps khi treo");
    if (els.mapsAutoReopen?.checked) tags.push("Mở lại tab");
    els.searchOptionsHint.textContent = tags.length ? tags.join(" · ") : "Chưa bật";
  }

  function onSearchOptionChange() {
    updateSearchOptionsHint();
  }

  // Trạng thái chọn tâm từ bản đồ
  let pickCenterMode = false;

  let searchWatchdog = null;
  let searchSyncTimer = null;
  let lastProgressAt = 0;
  let lastKnownMergedCount = 0;

  function clearSearchSyncPoll() {
    if (searchSyncTimer) {
      clearInterval(searchSyncTimer);
      searchSyncTimer = null;
    }
  }

  let lastPollSyncAt = 0;
  function startSearchSyncPoll() {
    clearSearchSyncPoll();
    const tick = () => {
      if (!searchRunning) {
        clearSearchSyncPoll();
        return;
      }
      window.TimDiemBanDrainQueue?.();
      const shown =
        parseInt(document.getElementById("infoTotal")?.textContent || "0", 10) || 0;
      if (lastKnownMergedCount > 0 && shown < lastKnownMergedCount) {
        requestSearchSync(`Bù ${lastKnownMergedCount - shown} quán (poll ${shown}/${lastKnownMergedCount})`);
      } else if (lastKnownMergedCount > 0 && shown >= lastKnownMergedCount) {
        /* đã khớp — không gọi sync */
      } else if (Date.now() - lastPollSyncAt > 30000) {
        lastPollSyncAt = Date.now();
        requestSearchSync("Heartbeat 30s");
      }
    };
    tick();
    searchSyncTimer = setInterval(tick, 1500);
  }

  function clearSearchWatchdog() {
    if (searchWatchdog) {
      clearTimeout(searchWatchdog);
      searchWatchdog = null;
    }
  }

  function requestSearchStatusAsync(timeoutMs = 8000) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve(null);
      }, timeoutMs);

      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext" || event.data?.type !== "search_status") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMsg);
        resolve(event.data.payload || null);
      }

      window.addEventListener("message", onMsg);
      postToExt("GET_SEARCH_STATUS");
    });
  }

  function isExtensionSearchAlive(status) {
    if (!status?.running) return false;
    const now = Date.now();
    const heartbeatMs = status.lastHeartbeat ? now - status.lastHeartbeat : Infinity;
    const progressMs = status.lastProgressAt ? now - status.lastProgressAt : Infinity;
    const mergedGrew = (status.mergedCount ?? 0) > lastKnownMergedCount;
    return heartbeatMs < 120000 || progressMs < 180000 || mergedGrew;
  }

  function armSearchWatchdog() {
    clearSearchWatchdog();
    lastProgressAt = Date.now();
    searchWatchdog = setTimeout(async () => {
      if (!searchRunning) return;
      if (Date.now() - lastProgressAt < 300000) return;

      const status = await requestSearchStatusAsync();
      if (!searchRunning) return;

      if (isExtensionSearchAlive(status)) {
        if (status.mergedCount != null) lastKnownMergedCount = status.mergedCount;
        touchSearchProgress();
        armSearchWatchdog();
        if (status.totalCells) {
          updateSearchProgress(
            Math.round(((status.gridIndex || 0) / status.totalCells) * 95),
            `Khu vực ${(status.gridIndex || 0) + 1}/${status.totalCells} · Đã thu thập ${status.mergedCount || 0} điểm bán`
          );
        }
        return;
      }

      if (status?.running) {
        showSearchStatus(
          "Tiến độ chưa thay đổi. Tiện ích đang kết nối lại với Google Maps; bạn có thể dừng lượt tìm kiếm nếu không muốn chờ.",
          "info"
        );
        touchSearchProgress();
        armSearchWatchdog();
        return;
      }

      showSearchStatus(
        "Tìm kiếm có thể đã dừng — bấm 'Dừng quét điểm bán' hoặc thử tìm kiếm lại.",
        "info"
      );
    }, 310000);
  }

  function touchSearchProgress() {
    lastProgressAt = Date.now();
  }

  let centerSource = "manual";
  /** Tọa độ GPS/tâm đã biết — tái dùng khi bấm Tìm lại, không gọi GPS lần nữa */
  let lastKnownCenter = null;
  /** Một promise GPS duy nhất — tránh autoDetect + Tìm kiếm chạy song song */
  let centerDetectPromise = null;
  let searchRunning = false;
  let formBusy = false;
  let busyOperation = "";
  let submitting = false;
  /** Đang chạy chuỗi nhiều từ khóa (khóa form tới khi xong hết) */
  let multiKeywordBatch = false;
  let multiKeywordAbort = false;

  function busyMessage() {
    if (multiKeywordBatch || searchRunning) return "Đang tìm kiếm — vui lòng đợi hoàn tất.";
    if (submitting || busyOperation === "search") return "Đang chuẩn bị tìm kiếm — vui lòng đợi.";
    if (busyOperation === "gps") return "Đang lấy GPS — vui lòng đợi xong.";
    if (busyOperation === "maps") return "Đang lấy tọa độ từ Maps — vui lòng đợi.";
    if (formBusy) return "Đang xử lý — vui lòng đợi xong.";
    return "Đang bận — vui lòng đợi.";
  }

  function isFormLocked() {
    return formBusy || searchRunning || submitting || multiKeywordBatch;
  }

  /** Tách "tạp hóa, phòng khám, quán ăn" → ["tạp hóa", "phòng khám", "quán ăn"] */
  function parseSearchKeywords(raw) {
    return String(raw || "")
      .split(/[,，;|]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((kw, i, arr) => arr.findIndex((x) => x.toLowerCase() === kw.toLowerCase()) === i)
      .slice(0, 10);
  }

  function waitForSearchEnd(expectedSearchId, timeoutMs = 45 * 60 * 1000) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        window.removeEventListener("timdiemban:search-finished", onFinished);
        resolve(result);
      };
      const payloadSearchId = (payload = {}) =>
        payload.searchParams?.searchId ||
        payload.searchId ||
        payload.search?.searchId ||
        "";
      const matchesSearch = (payload = {}) => {
        if (!expectedSearchId) return true;
        const sid = payloadSearchId(payload);
        // Bắt buộc khớp searchId — tránh lượt trước kết thúc sớm làm nhảy từ khóa
        return !!sid && sid === expectedSearchId;
      };
      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext") return;
        const t = event.data.type;
        if (t === "complete" || t === "error" || t === "tab_closed") {
          const payload = event.data.payload || {};
          if (!matchesSearch(payload)) return;
          finish({ type: t, payload });
        }
      }
      function onFinished(ev) {
        const sid = ev?.detail?.searchId;
        // Chỉ nhận finished khi có searchId khớp (bỏ qua finished mồ côi)
        if (!expectedSearchId || !sid || sid !== expectedSearchId) return;
        finish({ type: "finished", payload: ev?.detail || {} });
      }
      timer = setTimeout(() => {
        finish({
          type: "timeout",
          payload: { error: "Hết thời gian chờ kết thúc lượt tìm — dừng chuỗi từ khóa." }
        });
      }, timeoutMs);
      window.addEventListener("message", onMsg);
      window.addEventListener("timdiemban:search-finished", onFinished);
    });
  }

  /** Chờ extension thật sự rảnh trước khi START từ khóa tiếp */
  async function waitForExtensionIdle(timeoutMs = 45000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await requestSearchStatusAsync(4000);
      // Chỉ coi bận khi đang quét thật — không dùng mapsTabId từ checkpoint cũ (tab có thể đã đóng)
      const busy = !!(status?.running || status?.stalled);
      if (!busy) {
        await new Promise((r) => setTimeout(r, 400));
        const again = await requestSearchStatusAsync(3000);
        if (!(again?.running || again?.stalled)) return true;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  /** Chỉ dừng chuỗi khi user bấm Dừng — không dừng vì partialReason có chữ "dừng" */
  function isUserCancelEnd(end) {
    if (multiKeywordAbort) return true;
    if (!end) return false;
    if (end.payload?.partialCode === "USER_CANCEL") return true;
    const reason = String(end.payload?.partialReason || end.payload?.error || "");
    return /người dùng\s*(dừng|hủy)|user\s*cancel|abandon/i.test(reason);
  }

  async function startSearchExclusive(searchParams, { retries = 4 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const idle = await waitForExtensionIdle(attempt === 0 ? 20000 : 30000);
      if (!idle && attempt === retries) {
        throw new Error(
          "Tiện ích vẫn đang bận / tab Google Maps chưa đóng. Hãy đóng tab Maps thừa rồi thử lại."
        );
      }
      try {
        return await requestStartSearch(searchParams);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || "");
        const busy =
          /đang chạy|đang có tìm|Maps|đợi hoàn tất|Dừng quét/i.test(msg);
        if (!busy || attempt === retries) throw err;
        showSearchStatus(
          `Chờ tiện ích sẵn sàng rồi tìm tiếp "${searchParams.keyword}"… (${attempt + 1}/${retries})`,
          "info"
        );
        await new Promise((r) => setTimeout(r, 1000 + attempt * 500));
      }
    }
    throw lastErr || new Error("Không bắt đầu được tìm kiếm");
  }

  function updateFormControls() {
    const locked = isFormLocked();
    if (els.startBtn) {
      els.startBtn.disabled = false;
      els.startBtn.title = locked ? busyMessage() : "";
      els.startBtn.classList.toggle("is-busy", locked);
      els.startBtn.classList.toggle("hidden", searchRunning || multiKeywordBatch);
    }
    if (els.cancelSearchBtn) {
      const canCancel = searchRunning || multiKeywordBatch;
      els.cancelSearchBtn.classList.toggle("hidden", !canCancel);
      els.cancelSearchBtn.disabled = !canCancel;
    }
    if (els.btnFromGps) {
      els.btnFromGps.disabled = locked;
      els.btnFromGps.title = locked ? busyMessage() : "Lấy GPS";
    }
    if (els.btnFromMaps) {
      els.btnFromMaps.disabled = locked;
      els.btnFromMaps.title = locked ? busyMessage() : "Lấy từ tab Maps";
    }
    if (els.form) {
      els.form.querySelectorAll("input, select").forEach((el) => {
        if (
          el.id === "searchMapsAutoFocus" ||
          el.id === "searchMapsAutoReopen" ||
          el.id === "searchFastMode"
        ) {
          return;
        }
        el.disabled = locked;
      });
      els.form.querySelectorAll('button:not([type="submit"])').forEach((el) => {
        if (el.id === "cancelSearchBtn" || el.id === "searchOptionsToggle") return;
        el.disabled = locked;
      });
    }
    if (els.cancelSearchBtn && searchRunning) {
      els.cancelSearchBtn.disabled = false;
    }
  }

  function resetFormLock() {
    submitting = false;
    if (!searchRunning) {
      formBusy = false;
      busyOperation = "";
    }
    updateFormControls();
  }

  function setFormBusy(busy, operation = "") {
    formBusy = busy;
    busyOperation = busy ? operation : "";
    updateFormControls();
  }

  async function runExclusive(operation, fn) {
    if (isFormLocked()) {
      showSearchStatus(busyMessage(), "error");
      return null;
    }
    setFormBusy(true, operation);
    try {
      return await fn();
    } finally {
      setFormBusy(false);
    }
  }

  let extBridgeDead = false;

  function postToExt(type, payload) {
    // Bridge orphan sau reload extension — đừng spam postMessage
    if (extBridgeDead && type !== "PING_EXT") return;
    window.postMessage({ source: "timdiemban-web", type, payload }, window.location.origin);
  }

  function normalizeCenterCoords(lat, lng) {
    const la = Number(lat);
    const lo = Number(lng);
    if (isNaN(la) || isNaN(lo)) return null;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
    return {
      lat: Math.round(la * 1e6) / 1e6,
      lng: Math.round(lo * 1e6) / 1e6
    };
  }

  function parseCoordInput(value) {
    if (value == null || String(value).trim() === "") return NaN;
    return parseFloat(String(value).trim().replace(",", "."));
  }

  function clampRadiusKm(km) {
    const n = parseFloat(String(km ?? "").replace(",", "."));
    if (!Number.isFinite(n)) return NaN;
    const stepped = Math.round(n / 0.5) * 0.5;
    return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, stepped));
  }

  function formatRadiusKm(km) {
    const n = Number(km);
    if (!Number.isFinite(n)) return "";
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  }

  function enforceRadiusInput(opts = {}) {
    if (!els.radius) return NaN;
    const raw = parseFloat(String(els.radius.value || "").replace(",", "."));
    if (!Number.isFinite(raw)) return NaN;
    const clamped = clampRadiusKm(raw);
    const formatted = formatRadiusKm(clamped);
    if (els.radius.value !== formatted) {
      els.radius.value = formatted;
      if (opts.showHint && Math.abs(raw - clamped) > 1e-9) {
        showSearchStatus(`Bán kính hợp lệ: ${MIN_RADIUS_KM}–${MAX_RADIUS_KM} km — đã chỉnh về ${formatted} km`, "info");
      }
    }
    return clamped;
  }

  function radiusKmFromInput() {
    return clampRadiusKm(els.radius?.value);
  }

  function dispatchMapPreview(opts = {}) {
    const c = readCenterFromForm();
    const radiusKm = radiusKmFromInput();
    if (c && radiusKm > 0) {
      window.dispatchEvent(
        new CustomEvent("timdiemban:map-preview", {
          detail: { lat: c.lat, lng: c.lng, radius: radiusKm, fit: opts.fit !== false }
        })
      );
    }
  }

  function setCenterFields(lat, lng, source, extra = "", opts = {}) {
    const c = normalizeCenterCoords(lat, lng);
    if (!c) return false;
    const prevLat = parseCoordInput(els.lat?.value);
    const prevLng = parseCoordInput(els.lng?.value);
    const same =
      Number.isFinite(prevLat) &&
      Number.isFinite(prevLng) &&
      Math.abs(prevLat - c.lat) < 1e-7 &&
      Math.abs(prevLng - c.lng) < 1e-7;

    els.lat.value = String(c.lat);
    els.lng.value = String(c.lng);
    centerSource = source;
    lastKnownCenter = { lat: c.lat, lng: c.lng, source, accuracy: null, at: Date.now() };
    els.centerPreview.textContent = `${c.lat}, ${c.lng}${extra ? ` (${extra})` : ""}`;
    els.centerPreview.classList.remove("hidden");

    // Cùng tọa độ → không preview (tránh nháy)
    if (!same || opts.forcePreview) {
      dispatchMapPreview({ fit: opts.fit !== false && !same });
    }
    return true;
  }

  function readCenterFromForm() {
    const lat = parseCoordInput(els.lat.value);
    const lng = parseCoordInput(els.lng.value);
    if (isNaN(lat) || isNaN(lng)) return null;
    return normalizeCenterCoords(lat, lng);
  }

  /**
   * Chỉ lấy tọa độ người dùng đã chọn trong phiên này (form / GPS / Maps / chọn tâm).
   * Không dùng lat/lng phiên tìm kiếm trước.
   */
  function readCenterFromFormOrCache() {
    const fromForm = readCenterFromForm();
    if (fromForm) return fromForm;
    if (
      lastKnownCenter?.lat != null &&
      lastKnownCenter?.lng != null &&
      lastKnownCenter.source &&
      lastKnownCenter.source !== "saved"
    ) {
      return { lat: lastKnownCenter.lat, lng: lastKnownCenter.lng };
    }
    return null;
  }

  function showSearchStatus(message, type = "info") {
    if (!els.searchStatus) return;
    els.searchStatus.textContent = message;
    els.searchStatus.className = `search-status-inline search-status-${type}`;
    els.searchStatus.classList.remove("hidden");
  }

  function updateSearchProgress(percent, text) {
    if (!els.searchProgress) return;
    touchSearchProgress();
    els.searchProgress.classList.remove("hidden");
    if (els.searchProgressBar) els.searchProgressBar.style.width = `${percent}%`;
    if (els.searchProgressText) els.searchProgressText.textContent = text || `${percent}%`;
    if (els.scrapeLog) els.scrapeLog.classList.remove("hidden");
  }

  function clearScrapeLog() {
    if (els.scrapeLog) {
      els.scrapeLog.textContent = "";
      els.scrapeLog.classList.add("hidden");
    }
  }

  function appendScrapeLog(line) {
    if (!els.scrapeLog || !line) return;
    els.scrapeLog.classList.remove("hidden");
    els.scrapeLog.textContent = (els.scrapeLog.textContent ? els.scrapeLog.textContent + "\n" : "") + line;
    els.scrapeLog.scrollTop = els.scrapeLog.scrollHeight;
  }

  function showMapsFocusModal() {
    els.mapsFocusModal?.classList.remove("hidden");
  }

  function hideMapsFocusModal() {
    els.mapsFocusModal?.classList.add("hidden");
  }

  function getShownResultCount() {
    return parseInt(document.getElementById("infoTotal")?.textContent || "0", 10) || 0;
  }

  function shouldShowMapsIssueModal(status) {
    if (!status) return false;
    if (status.stalled) return true;
    const extCount = Number(status.mergedCount || 0);
    const shown = getShownResultCount();
    // Chỉ coi là thiếu khi chênh lệch đủ lớn để tránh false positive lúc realtime.
    return extCount > 0 && extCount - shown >= 5;
  }

  function setSearchRunning(running) {
    searchRunning = running;
    if (!running) {
      clearSearchWatchdog();
      clearSearchSyncPoll();
      hideMapsFocusModal();
    } else {
      startSearchSyncPoll();
    }
    updateBackgroundSearchHint();
    updateFormControls();
  }

  function updateBackgroundSearchHint() {
    if (!searchRunning || !els.searchStatus) return;
    if (document.visibilityState === "hidden") {
      showSearchStatus(
        "Tìm kiếm vẫn tiếp tục và kết quả đang được đồng bộ. Giữ tab Maps mở; Findmap chỉ đưa Maps lên trước nếu không phản hồi trong 5 phút hoặc thao tác nền thất bại.",
        "info"
      );
    }
  }

  function saveLastSearch(params) {
    try {
      localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(params));
    } catch {}
  }

  function loadLastSearch() {
    try {
      const raw = localStorage.getItem(LAST_SEARCH_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      // Chỉ khôi phục từ khóa + bán kính — KHÔNG lấy lat/lng phiên cũ
      // (tọa độ phải lấy GPS/Maps/chọn tâm hiện tại)
      if (s.keyword) els.keyword.value = s.keyword;
      if (s.radius != null) {
        const r = Number(s.radius);
        const km = r >= 100 ? r / 1000 : r;
        els.radius.value = formatRadiusKm(clampRadiusKm(km));
      }
    } catch {}
  }

  function getQuickLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Trình duyệt không hỗ trợ GPS"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          }),
        (err) => reject(err || new Error("Không lấy được GPS")),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
      );
    });
  }

  async function getHighAccuracyLocation() {
    return new Promise((resolve, reject) => {
      let best = null;
      let watchId = null;

      const finish = (result, err) => {
        clearTimeout(timer);
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        if (result) resolve(result);
        else reject(err || new Error("Không lấy được GPS"));
      };

      const timer = setTimeout(() => {
        finish(best, new Error("GPS quá lâu — thử 'Lấy từ tab Maps' hoặc nhập tay"));
      }, 18000);

      if (!navigator.geolocation) {
        finish(null, new Error("Trình duyệt không hỗ trợ GPS"));
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const sample = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          };
          if (!best || sample.accuracy < best.accuracy) best = sample;
          if (sample.accuracy <= 25) finish(best);
        },
        (err) => {
          if (best) finish(best);
          else finish(null, err);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 18000 }
      );
    });
  }

  async function reverseGeocodeAddress(lat, lng) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=vi`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) return "";
      const data = await res.json();
      return data?.display_name || "";
    } catch {
      return "";
    }
  }

  async function detectFreshGpsCenter({ force = false } = {}) {
    if (!force) {
      const existing = readCenterFromFormOrCache();
      if (existing) return existing;
    }

    if (centerDetectPromise) return centerDetectPromise;

    centerDetectPromise = (async () => {
      try {
        let loc;
        try {
          loc = await getQuickLocation();
        } catch (err) {
          // Lỗi từ chối quyền: dừng ngay — để Chrome giữ UI hỏi quyền/icon định vị,
          // không retry watchPosition (sẽ fail ngay, không hỏi lại).
          if (isGeoDeniedError(err)) throw err;
          loc = await getHighAccuracyLocation();
        }
        const extra = loc.accuracy ? `±${Math.round(loc.accuracy)}m` : "";
        setCenterFields(loc.lat, loc.lng, "gps", extra);
        if (lastKnownCenter) lastKnownCenter.accuracy = loc.accuracy ?? null;
        return normalizeCenterCoords(loc.lat, loc.lng);
      } finally {
        centerDetectPromise = null;
      }
    })();

    return centerDetectPromise;
  }

  async function getOrDetectCenter() {
    return detectFreshGpsCenter({ force: false });
  }

  function isGeoDeniedError(err) {
    return err?.code === 1 || /denied|permission/i.test(String(err?.message || err || ""));
  }

  function formatGpsCenterStatus(center) {
    const extra = lastKnownCenter?.accuracy
      ? `±${Math.round(lastKnownCenter.accuracy)}m`
      : "";
    return reverseGeocodeAddress(center.lat, center.lng).then((address) =>
      address
        ? `Tâm: ${address.split(",").slice(0, 2).join(",")}${extra ? ` (GPS ${extra})` : ""}`
        : `Tâm: ${center.lat}, ${center.lng}${extra ? ` (GPS ${extra})` : ""}`
    );
  }

  const GPS_DENIED_HINT = "Chrome đang chặn vị trí — xem hướng dẫn trong hộp thoại.";
  const GPS_ASKING_HINT = "Đang xin vị trí từ Chrome…";

  function getGpsDeniedModalEl() {
    return els.gpsDeniedModal || document.getElementById("gpsDeniedModal");
  }

  function showGpsDeniedModal() {
    const modal = getGpsDeniedModalEl();
    if (!modal) {
      console.warn("[Findmap] Thiếu #gpsDeniedModal trong HTML");
      return;
    }
    els.gpsDeniedModal = modal;
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    modal.classList.remove("hidden");
    modal.style.display = "flex";
  }

  function hideGpsDeniedModal() {
    const modal = getGpsDeniedModalEl();
    if (!modal) return;
    modal.classList.add("hidden");
    modal.style.display = "";
  }

  function notifyGpsDenied(err) {
    showSearchStatus(humanizeGeoError(err) || GPS_DENIED_HINT, "error");
    // Mở sau microtask để không bị nuốt bởi UI update đồng bộ khác
    requestAnimationFrame(() => showGpsDeniedModal());
  }

  function humanizeGeoError(err) {
    const raw = String(err?.message || err || "");
    if (isGeoDeniedError(err) || /User denied|permission denied|denied Geolocation/i.test(raw)) {
      return GPS_DENIED_HINT;
    }
    if (/timeout|took too long/i.test(raw)) {
      return "GPS quá lâu — thử lại Tìm kiếm ngay hoặc dùng Chọn tâm.";
    }
    return raw || "Không lấy được GPS — dùng Chọn tâm trên bản đồ.";
  }

  async function applyGpsCenter(center, { quiet = false } = {}) {
    window.TimDiemBanMap?.focusPoint?.(center.lat, center.lng);
    if (!quiet) showSearchStatus(await formatGpsCenterStatus(center), "success");
    if (els.btnFromGps) els.btnFromGps.classList.add("hidden");
    return center;
  }

  async function queryGeolocationPermission() {
    try {
      if (!navigator.permissions?.query) return "unknown";
      const status = await navigator.permissions.query({ name: "geolocation" });
      return status.state; // granted | denied | prompt
    } catch {
      return "unknown";
    }
  }

  async function requestGpsCenterFromUserGesture() {
    showSearchStatus(GPS_ASKING_HINT, "info");
    try {
      return await applyGpsCenter(await detectFreshGpsCenter({ force: true }));
    } catch (err) {
      if (isGeoDeniedError(err)) notifyGpsDenied(err);
      else showSearchStatus(humanizeGeoError(err), "error");
      throw err;
    }
  }

  /**
   * Chỉ lấy GPS ngầm khi đã Cho phép.
   * Chưa có quyền: không hỏi lúc load — hỏi ngầm khi bấm Tìm kiếm ngay (Chrome hiện UI trên thanh địa chỉ).
   */
  async function autoDetectGpsSilent() {
    if (!navigator.geolocation) return;
    if (els.btnFromGps) els.btnFromGps.classList.add("hidden");
    const perm = await queryGeolocationPermission();
    if (perm !== "granted") return;
    try {
      const center = await detectFreshGpsCenter({ force: true });
      await applyGpsCenter(center, { quiet: true });
    } catch (err) {
      console.warn("GPS silent:", err?.code, err?.message || err);
    }
  }

  autoDetectGpsSilent();

  function requestMapsCenter() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("Chưa nhận được dữ liệu từ tiện ích. Hãy kiểm tra tiện ích đang bật và tải lại trang Findmap."));
      }, 8000);

      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext" || event.data?.type !== "maps_center") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMsg);
        const p = event.data.payload || {};
        if (p.error) reject(new Error(p.error));
        else resolve(p.center);
      }

      window.addEventListener("message", onMsg);
      postToExt("GET_MAPS_CENTER");
    });
  }

  function requestCancelSearch(reason) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("Chưa nhận được xác nhận dừng. Hãy kiểm tra kết nối với tab Google Maps rồi thử lại."));
      }, 45000);

      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext" || event.data?.type !== "cancel_ack") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMsg);
        const p = event.data.payload || {};
        if (p.success) resolve(p);
        else reject(new Error(p.error || "Không dừng được tìm kiếm"));
      }

      window.addEventListener("message", onMsg);
      postToExt("CANCEL_SEARCH", { reason });
    });
  }

  function requestSearchStatus() {
    postToExt("GET_SEARCH_STATUS");
  }

  function requestSearchSync(reason) {
    postToExt("REQUEST_SEARCH_SYNC", { reason });
  }

  function abandonExtensionSearch() {
    postToExt("ABANDON_SEARCH", { reason: "Làm mới trang" });
  }

  function maybeRequestSearchSync(status) {
    if (!status) return;
    const active = !!(status.running || status.stalled);
    const ext = status.mergedCount || 0;
    const shown = parseInt(document.getElementById("infoTotal")?.textContent || "0", 10) || 0;
    if (active && ext > 0 && shown < ext - 2) {
      requestSearchSync("Đồng bộ lại sau khi tải trang");
    }
  }

  function applySearchStatus(status) {
    if (!status) return;
    window.dispatchEvent(new CustomEvent("timdiemban:search-status", { detail: status }));
    if (status.mergedCount != null) lastKnownMergedCount = status.mergedCount;
    if (status.running || status.stalled) {
      setSearchRunning(true);
      if (status.mapsAutoFocus != null) syncMapsAutoFocusCheckbox(!!status.mapsAutoFocus);
      if (status.mapsAutoReopen != null) syncMapsAutoReopenCheckbox(!!status.mapsAutoReopen);
      if (shouldShowMapsIssueModal(status)) showMapsFocusModal();
      else hideMapsFocusModal();
      maybeRequestSearchSync(status);
      if (isExtensionSearchAlive(status) || status.stalled) {
        touchSearchProgress();
      }
      armSearchWatchdog();
      if (status.stalled) {
        if (status.totalCells) {
          updateSearchProgress(
            Math.round(((status.gridIndex || 0) / status.totalCells) * 95),
            `Đang khôi phục — vùng ${(status.gridIndex || 0) + 1}/${status.totalCells} · ${status.mergedCount || 0} quán`
          );
        }
        showSearchStatus(
          "Maps đang chậm phản hồi. Findmap sẽ thử khôi phục ở nền và chỉ đưa tab Maps lên trước khi thật sự cần thiết.",
          "info"
        );
      } else if (status.totalCells) {
        updateSearchProgress(
          Math.round(((status.gridIndex || 0) / status.totalCells) * 95),
          `Khu vực ${(status.gridIndex || 0) + 1}/${status.totalCells} · Đã thu thập ${status.mergedCount || 0} điểm bán`
        );
      }
    } else if (!status.running && searchRunning) {
      setSearchRunning(false);
    }
  }

  function requestStartSearch(searchParams) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(
          new Error(
            "Không kết nối được với tiện ích Findmap. Hãy kiểm tra tiện ích đã được cài và bật."
          )
        );
      }, 30000);

      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext" || event.data?.type !== "search_ack") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMsg);
        const p = event.data.payload || {};
        if (p.success === false || p.error) reject(new Error(p.error || "Không bắt đầu được tìm kiếm"));
        else resolve(p);
      }

      window.addEventListener("message", onMsg);
      postToExt("START_SEARCH", searchParams);
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (isFormLocked()) {
      showSearchStatus(busyMessage(), "error");
      return;
    }

    const token = localStorage.getItem("timdiemban_token");
    if (!token) {
      showSearchStatus("Vui lòng đăng nhập trước khi tìm kiếm.", "error");
      window.dispatchEvent(new CustomEvent("timdiemban:need-login"));
      return;
    }

    if (window.TimDiemBanExtension?.isInstalled?.() !== true) {
      showSearchStatus("Chưa phát hiện tiện ích Findmap. Hãy cài hoặc bật tiện ích trước khi tìm.", "error");
      return;
    }

    const keywords = parseSearchKeywords(els.keyword.value);
    enforceRadiusInput();
    const radiusKm = radiusKmFromInput();
    if (!keywords.length) {
      showSearchStatus("Nhập từ khóa tìm kiếm (có thể nhiều từ khóa, cách nhau bằng dấu phẩy).", "error");
      return;
    }
    if (!Number.isFinite(radiusKm) || radiusKm < MIN_RADIUS_KM || radiusKm > MAX_RADIUS_KM) {
      showSearchStatus(`Bán kính hợp lệ: ${MIN_RADIUS_KM}–${MAX_RADIUS_KM} km.`, "error");
      return;
    }

    // Xin GPS chỉ khi form chưa có tọa độ.
    // Đã chọn tâm (map/manual): tuyệt đối không chạy GPS — tránh GPS Hà Nội đè tâm Bắc Ninh.
    let center = readCenterFromForm();
    let gpsPromise = null;

    if (!navigator.geolocation) {
      if (!center) {
        showSearchStatus("Trình duyệt không hỗ trợ định vị. Hãy nhập vĩ độ, kinh độ hoặc dùng Chọn tâm.", "error");
        return;
      }
    } else if (!center) {
      showSearchStatus(GPS_ASKING_HINT, "info");
      gpsPromise = detectFreshGpsCenter({ force: true });
    }

    submitting = true;
    setFormBusy(true, "search");

    try {
      if (!center) {
        busyOperation = "gps";
        updateFormControls();
        try {
          center = await gpsPromise;
          window.TimDiemBanMap?.focusPoint?.(center.lat, center.lng);
        } catch (err) {
          if (isGeoDeniedError(err)) notifyGpsDenied(err);
          else showSearchStatus(humanizeGeoError(err), "error");
          return;
        }
      }

      if (!center) {
        showSearchStatus("Tọa độ không hợp lệ (lat: -90..90, lng: -180..180).", "error");
        return;
      }

      // Khóa tâm vào form — không force preview nếu đã đúng tọa độ
      setCenterFields(center.lat, center.lng, centerSource || "manual", "", { fit: false });

      const keywordLabel = keywords.join(", ");
      saveLastSearch({
        keyword: keywordLabel,
        radius: radiusKm,
        lat: center.lat,
        lng: center.lng,
        centerSource
      });

      // Luôn khóa batch — kể cả 1 từ khóa — tránh double-submit / START chồng
      multiKeywordBatch = true;
      multiKeywordAbort = false;
      setSearchRunning(true);
      armSearchWatchdog();
      clearScrapeLog();
      lastKnownMergedCount = 0;
      updateFormControls();

      // Vẽ vùng đúng 1 lần khi bắt đầu chuỗi tìm
      window.TimDiemBanMap?.setSearchArea?.(
        { lat: center.lat, lng: center.lng },
        radiusKm,
        { fit: true }
      );

      const baseParams = {
        radius: radiusKm,
        lat: center.lat,
        lng: center.lng,
        centerSource,
        webUrl: window.location.origin,
        authToken: token,
        fastMode: document.getElementById("searchFastMode")?.checked || false,
        mapsAutoFocus: isMapsAutoFocusChecked(),
        mapsAutoReopen: isMapsAutoReopenChecked(),
        keywords,
        keywordTotal: keywords.length
      };

      const batchId = Date.now();
      let stoppedEarly = false;

      if (keywords.length > 1) {
        showSearchStatus(
          `Sẽ tìm lần lượt ${keywords.length} từ khóa: ${keywords.map((k) => `"${k}"`).join(" → ")}`,
          "info"
        );
      }

      // Đảm bảo không còn lượt cũ / tab Maps trước khi bắt đầu chuỗi
      showSearchStatus(
        keywords.length > 1
          ? `Đang kiểm tra tiện ích — chuẩn bị từ khóa 1/${keywords.length}…`
          : "Đang kiểm tra tiện ích sẵn sàng…",
        "info"
      );
      const ready0 = await waitForExtensionIdle(30000);
      if (!ready0) {
        throw new Error(
          "Tiện ích hoặc tab Google Maps vẫn đang bận. Đóng tab Maps thừa rồi thử lại."
        );
      }

      for (let i = 0; i < keywords.length; i++) {
        if (multiKeywordAbort) {
          stoppedEarly = true;
          break;
        }

        const keyword = keywords[i];
        const searchParams = {
          ...baseParams,
          keyword,
          keywordIndex: i,
          searchId: `search_${batchId}_${i}`
        };

        // Trước mỗi từ khóa (trừ đầu): chờ idle tuyệt đối — 1 tab Maps / 1 lúc
        if (i > 0) {
          showSearchStatus(
            `Đã xong từ khóa trước — đóng Maps và chuẩn bị "${keyword}"…`,
            "info"
          );
          const idle = await waitForExtensionIdle(60000);
          if (!idle) {
            showSearchStatus(
              "Không thể bắt đầu từ khóa tiếp theo — tab Google Maps chưa đóng hết.",
              "error"
            );
            stoppedEarly = true;
            break;
          }
          // Đồng bộ nốt kết quả lượt trước về bảng trước khi tìm tiếp
          try {
            await window.TimDiemBanSearch?.requestSearchSync?.(
              "Đồng bộ kết quả trước khi tìm từ khóa tiếp theo"
            );
          } catch {}
          await new Promise((r) => setTimeout(r, 600));
        }

        if (multiKeywordAbort) {
          stoppedEarly = true;
          break;
        }

        window.dispatchEvent(
          new CustomEvent("timdiemban:search-starting", { detail: searchParams })
        );

        const stepLabel =
          keywords.length > 1
            ? `Từ khóa ${i + 1}/${keywords.length}: "${keyword}"`
            : `Đang tìm "${keyword}"`;
        showSearchStatus(`${stepLabel} — tâm ${center.lat}, ${center.lng}`, "info");
        updateSearchProgress(Math.round((i / keywords.length) * 100), stepLabel);
        setSearchRunning(true);
        armSearchWatchdog();

        try {
          // Gắn listener TRƯỚC START — và chỉ nhận đúng searchId này
          const endPromise = waitForSearchEnd(searchParams.searchId);
          await startSearchExclusive(searchParams);
          const autoFocusHint = searchParams.mapsAutoFocus
            ? "Bạn có thể làm việc ở tab khác; Maps chỉ được đưa lên trước nếu không phản hồi trong 5 phút."
            : "Đang tắt tự khôi phục tab Maps khi tiến trình không phản hồi.";
          showSearchStatus(`${stepLabel} — ${autoFocusHint}`, "info");

          const end = await endPromise;
          clearSearchWatchdog();
          setSearchRunning(false);

          // User bấm Dừng → dừng cả chuỗi
          if (isUserCancelEnd(end)) {
            stoppedEarly = true;
            showSearchStatus(
              end.payload?.partialReason || end.payload?.error || "Đã dừng — kết quả đã lưu.",
              "info"
            );
            await waitForExtensionIdle(20000).catch(() => false);
            break;
          }

          // Lỗi cứng / đóng tab / timeout → dừng chuỗi
          if (end.type === "error" || end.type === "tab_closed" || end.type === "timeout") {
            stoppedEarly = true;
            showSearchStatus(
              end.payload?.error || end.payload?.partialReason || `Dừng tại từ khóa "${keyword}"`,
              "error"
            );
            await waitForExtensionIdle(20000).catch(() => false);
            break;
          }

          // complete / finished / partial (không phải user cancel) → tiếp tục từ khóa sau
          if (end.type === "complete" && end.payload?.partial) {
            showSearchStatus(
              `Xong "${keyword}" (kết thúc sớm) — chuẩn bị từ khóa tiếp theo…`,
              "info"
            );
          } else if (keywords.length > 1 && i < keywords.length - 1) {
            showSearchStatus(
              `Xong "${keyword}" (${i + 1}/${keywords.length}) — sang từ khóa tiếp theo…`,
              "info"
            );
          }

          try {
            await window.TimDiemBanSearch?.requestSearchSync?.(
              `Đồng bộ kết quả "${keyword}"`
            );
          } catch {}
        } catch (err) {
          showSearchStatus(err.message, "error");
          stoppedEarly = true;
          await waitForExtensionIdle(20000).catch(() => false);
          break;
        }
      }

      if (!stoppedEarly) {
        updateSearchProgress(100, "Hoàn tất");
        showSearchStatus(
          keywords.length > 1
            ? `Hoàn tất ${keywords.length} từ khóa — xem các tab kết quả bên dưới.`
            : "Hoàn tất — xem bảng kết quả bên dưới.",
          "success"
        );
      } else if (keywords.length > 1) {
        // Giữ thông báo đã set ở trên; bổ sung nếu vòng lặp thoát vì idle
        /* no-op */
      }
    } catch (err) {
      if (isGeoDeniedError(err)) {
        notifyGpsDenied(err);
      } else {
        showSearchStatus(
          err.message || "Chưa có tọa độ trung tâm. Hãy nhập vĩ độ, kinh độ hoặc dùng Chọn tâm.",
          "error"
        );
      }
    } finally {
      multiKeywordBatch = false;
      multiKeywordAbort = false;
      submitting = false;
      setFormBusy(false);
      setSearchRunning(false);
      updateFormControls();
    }
  }

  function pingExtensionBridge() {
    postToExt("PING_EXT");
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== "timdiemban-ext") return;

    if (event.data.type === "maps_center") return;

    if (event.data.type === "bridge_ready") {
      const payload = event.data.payload || {};
      extBridgeDead = !!(payload.dead || (payload.ok === false && /context invalidated|reload/i.test(String(payload.error || ""))));
      if (payload.ok) {
        extBridgeDead = false;
        requestSearchStatus();
      } else {
        clearSearchSyncPoll();
      }
      window.dispatchEvent(new CustomEvent("timdiemban:bridge-ready", { detail: payload }));
      return;
    }

    if (event.data.type === "log") {
      appendScrapeLog(event.data.payload?.line);
      return;
    }

    if (event.data.type === "start") {
      const cells = event.data.payload?.searchParams?.gridCells;
      updateSearchProgress(2, cells ? `Lưới ${cells} ô — đang mở Google Maps...` : "Đang mở Google Maps...");
      setSearchRunning(true);
      hideMapsFocusModal();
      armSearchWatchdog();
      return;
    }

    if (event.data.type === "progress") {
      touchSearchProgress();
      armSearchWatchdog();
      const { percent, text } = event.data.payload || {};
      if (text) updateSearchProgress(percent || 0, text);
      const maybeStatus = event.data.payload || {};
      if (shouldShowMapsIssueModal(maybeStatus)) showMapsFocusModal();
      return;
    }

    if (event.data.type === "search_status") {
      applySearchStatus(event.data.payload);
      return;
    }

    if (event.data.type === "cancel_ack") {
      return;
    }

    if (event.data.type === "error") {
      clearSearchWatchdog();
      setSearchRunning(false);
      showSearchStatus(event.data.payload?.error || "Lỗi tìm kiếm", "error");
      return;
    }

    if (event.data.type === "complete" || event.data.type === "tab_closed") {
      clearSearchWatchdog();
      setSearchRunning(false);
      // Chuỗi nhiều từ khóa: handleSubmit tự cập nhật trạng thái từng bước
      if (multiKeywordBatch) return;
      if (event.data.type === "complete") {
        const partial = event.data.payload?.partial;
        updateSearchProgress(100, partial ? "Dừng sớm" : "Hoàn tất");
        showSearchStatus(
          partial
            ? event.data.payload?.partialReason || "Đã dừng — kết quả đã lưu. Xem bảng kết quả."
            : "Hoàn tất — xem bảng kết quả bên dưới.",
          partial ? "info" : "success"
        );
      } else {
        showSearchStatus(
          event.data.payload?.error || "Tìm kiếm bị gián đoạn — mở lại trang và thử lại.",
          "error"
        );
      }
    }
  });

  window.addEventListener("timdiemban:search-finished", () => {
    setSearchRunning(false);
  });

  if (els.mapsFocusModalOk) {
    els.mapsFocusModalOk.addEventListener("click", () => hideMapsFocusModal());
  }
  if (els.mapsFocusModalClose) {
    els.mapsFocusModalClose.addEventListener("click", () => hideMapsFocusModal());
  }
  if (els.mapsFocusModal) {
    els.mapsFocusModal.addEventListener("click", (e) => {
      if (e.target === els.mapsFocusModal) hideMapsFocusModal();
    });
  }

  if (els.searchOptionsToggle) {
    els.searchOptionsToggle.addEventListener("click", () => {
      setSearchOptionsOpen(!isSearchOptionsOpen());
    });
  }

  if (els.fastMode) {
    els.fastMode.addEventListener("change", onSearchOptionChange);
  }

  if (els.mapsAutoFocus) {
    els.mapsAutoFocus.addEventListener("change", () => {
      saveMapsAutoFocusPref();
      onSearchOptionChange();
      if (searchRunning) postMapsAutoFocus(isMapsAutoFocusChecked());
    });
  }

  if (els.mapsAutoReopen) {
    els.mapsAutoReopen.addEventListener("change", () => {
      saveMapsAutoReopenPref();
      onSearchOptionChange();
      postMapsAutoReopen(isMapsAutoReopenChecked());
    });
  }

  // Ẩn Tab Maps / GPS — GPS xin qua hộp thoại Chrome + nút định vị bản đồ
  if (els.btnFromMaps) els.btnFromMaps.classList.add("hidden");
  if (els.btnFromGps) els.btnFromGps.classList.add("hidden");

  // Bấm trên bản đồ → đặt tâm tìm kiếm (CHỈ khi đang ở chế độ chọn tâm)
  window.addEventListener("timdiemban:map-pick-center", (e) => {
    if (!pickCenterMode) return; // Chỉ xử lý khi đang ở chế độ chọn tâm
    if (isFormLocked()) return;
    const { lat, lng } = e.detail || {};
    if (lat == null || lng == null) return;
    setCenterFields(lat, lng, "map_click", "bấm bản đồ", { fit: true, forcePreview: true });
    showSearchStatus(
      `Tâm: ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)} — đã chọn`,
      "success"
    );
    exitPickCenterMode();
  });

  // Nút định vị trên bản đồ (user gesture) → đặt tâm GPS + Chrome hỏi quyền nếu cần
  window.addEventListener("timdiemban:gps-center", async (e) => {
    if (isFormLocked()) return;
    const { lat, lng, accuracy } = e.detail || {};
    if (lat == null || lng == null) return;
    const extra = accuracy ? `±${Math.round(accuracy)}m` : "";
    setCenterFields(lat, lng, "gps", extra);
    if (lastKnownCenter) lastKnownCenter.accuracy = accuracy ?? null;
    try {
      showSearchStatus(await formatGpsCenterStatus({ lat, lng }), "success");
    } catch {
      showSearchStatus(`Tâm GPS: ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`, "success");
    }
  });

  window.addEventListener("timdiemban:gps-denied", () => {
    notifyGpsDenied();
  });

  function bindGpsDeniedModalUi() {
    const modal = getGpsDeniedModalEl();
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    els.gpsDeniedModal = modal;
    document.getElementById("gpsDeniedModalOk")?.addEventListener("click", hideGpsDeniedModal);
    document.getElementById("gpsDeniedModalClose")?.addEventListener("click", hideGpsDeniedModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideGpsDeniedModal();
    });
  }
  bindGpsDeniedModalUi();

  // Bấm dòng cảnh báo → mở lại hướng dẫn
  els.searchStatus?.addEventListener("click", () => {
    const t = els.searchStatus?.textContent || "";
    if (/chặn vị trí|hộp thoại/i.test(t)) showGpsDeniedModal();
  });
  if (els.searchStatus) {
    els.searchStatus.style.cursor = "pointer";
    els.searchStatus.title = "Bấm để xem hướng dẫn bật vị trí";
  }

  function enterPickCenterMode() {
    pickCenterMode = true;
    if (els.btnPickCenter) {
      els.btnPickCenter.classList.add("active");
      els.btnPickCenter.textContent = "Đang chọn…";
    }
    // Ẩn vòng bán kính / lưới / marker phiên cũ để dễ bấm chọn tâm mới
    window.TimDiemBanMap?.clearAll?.();
    showSearchStatus("Bấm vào vị trí trên bản đồ để chọn tâm tìm kiếm", "info");
    document.body.classList.add("picking-center");
  }

  function exitPickCenterMode() {
    pickCenterMode = false;
    if (els.btnPickCenter) {
      els.btnPickCenter.classList.remove("active");
      els.btnPickCenter.textContent = "Chọn tâm";
    }
    document.body.classList.remove("picking-center");
  }

  if (els.btnPickCenter) {
    els.btnPickCenter.addEventListener("click", () => {
      if (isFormLocked()) return;
      if (pickCenterMode) {
        exitPickCenterMode();
        // Hủy chọn → vẽ lại vùng theo lat/lng đang có trên form (nếu có)
        dispatchMapPreview();
        showSearchStatus("Đã tắt chế độ chọn tâm", "info");
      } else {
        enterPickCenterMode();
      }
    });
  }

  if (els.btnFromGps) {
    els.btnFromGps.addEventListener("click", async () => {
      await runExclusive("gps", async () => {
        try {
          await requestGpsCenterFromUserGesture();
        } catch {
          // Thông báo đã hiện trong requestGpsCenterFromUserGesture
        }
      });
    });
  }

  // Khi user đổi quyền ở thanh địa chỉ → thử lấy GPS lại
  try {
    navigator.permissions?.query?.({ name: "geolocation" }).then((status) => {
      status.addEventListener?.("change", () => {
        if (status.state === "granted") autoDetectGpsSilent();
      });
    });
  } catch {}

  let previewInputTimer = null;
  els.radius?.addEventListener("blur", () => {
    enforceRadiusInput({ showHint: true });
    const c = readCenterFromForm();
    if (c) dispatchMapPreview({ fit: true });
  });
  [els.lat, els.lng, els.radius].forEach((input) => {
    input?.addEventListener("input", () => {
      const c = readCenterFromForm();
      if (c) {
        centerSource = "manual";
        els.centerPreview.textContent = `${c.lat}, ${c.lng} (nhập tay)`;
        els.centerPreview.classList.remove("hidden");
        if (previewInputTimer) clearTimeout(previewInputTimer);
        previewInputTimer = setTimeout(() => {
          if (input === els.radius) {
            const raw = parseFloat(String(els.radius?.value || "").replace(",", "."));
            if (Number.isFinite(raw) && raw > MAX_RADIUS_KM) {
              enforceRadiusInput({ showHint: true });
            }
          }
          dispatchMapPreview({ fit: true });
        }, 280);
      } else {
        els.centerPreview.classList.add("hidden");
      }
    });
  });

  els.form?.addEventListener("submit", handleSubmit);

  els.cancelSearchBtn?.addEventListener("click", async () => {
    if (!searchRunning && !multiKeywordBatch) return;
    multiKeywordAbort = true;
    els.cancelSearchBtn.disabled = true;
    showSearchStatus("Đang dừng quét...", "info");
    try {
      if (searchRunning) {
        await requestCancelSearch("Người dùng dừng tìm kiếm");
        showSearchStatus("Đã dừng — đang tổng hợp kết quả...", "info");
      }
    } catch (err) {
      showSearchStatus(err.message, "error");
      els.cancelSearchBtn.disabled = false;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestSearchStatus();
      if (searchRunning) requestSearchSync("Quay lại tab kết quả");
    } else if (searchRunning) {
      updateBackgroundSearchHint();
    }
  });

  window.addEventListener("focus", () => {
    if (searchRunning) requestSearchSync("Focus cửa sổ");
  });

  window.addEventListener("timdiemban:merged-count", (e) => {
    const count = e.detail?.count;
    if (count != null && count > lastKnownMergedCount) lastKnownMergedCount = count;
  });

  // GPS đã được gọi ngay sau khi định nghĩa autoDetectGpsSilent — không gọi lại ở đây
  loadMapsAutoFocusPref();
  loadMapsAutoReopenPref();
  loadSearchOptionsOpen();
  updateSearchOptionsHint();
  loadLastSearch();
  resetFormLock();

  pingExtensionBridge();
  setTimeout(pingExtensionBridge, 1500);

  window.TimDiemBanSearch = {
    setSearchRunning,
    showSearchStatus,
    updateSearchProgress,
    pingExtensionBridge,
    isFormLocked,
    resetFormLock,
    isMapsAutoReopenChecked,
    abandonExtensionSearch,
    requestSearchSync
  };
})();
