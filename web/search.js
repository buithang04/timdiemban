/**
 * Form tìm kiếm trên trang kết quả — gửi lệnh tới extension qua web-bridge.
 */
(function () {
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
      els.mapsAutoFocus.checked = saved === "1";
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
    const mins = getMapsAutoFocusMinutes();
    els.mapsAutoFocusLabel.textContent = `Tự chuyển sang tab Google Maps mỗi ${mins} phút — tránh tab nền bị treo (có thể gây nhảy cửa sổ)`;
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
      els.mapsAutoReopen.checked = saved === "1";
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
    els.mapsAutoReopenLabel.textContent = `Tự mở lại tab Google Maps nếu bị đóng — tiếp tục quét (tối đa ${maxN} lần, áp dụng tìm kiếm & quét lại)`;
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
    if (els.mapsAutoFocus?.checked) tags.push("Focus Maps");
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
            `Đang chạy vùng ${(status.gridIndex || 0) + 1}/${status.totalCells} — ${status.mergedCount || 0} quán`
          );
        }
        return;
      }

      if (status?.running) {
        showSearchStatus(
          "Tiến trình im lặng — extension đang thử kết nối lại tab Maps. Bấm 'Dừng quét điểm bán' nếu muốn kết thúc sớm.",
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

  function busyMessage() {
    if (searchRunning) return "Đang tìm kiếm — vui lòng đợi hoàn tất.";
    if (submitting || busyOperation === "search") return "Đang chuẩn bị tìm kiếm — vui lòng đợi.";
    if (busyOperation === "gps") return "Đang lấy GPS — vui lòng đợi xong.";
    if (busyOperation === "maps") return "Đang lấy tọa độ từ Maps — vui lòng đợi.";
    if (formBusy) return "Đang xử lý — vui lòng đợi xong.";
    return "Đang bận — vui lòng đợi.";
  }

  function isFormLocked() {
    return formBusy || searchRunning || submitting;
  }

  function updateFormControls() {
    const locked = isFormLocked();
    if (els.startBtn) {
      els.startBtn.disabled = false;
      els.startBtn.title = locked ? busyMessage() : "";
      els.startBtn.classList.toggle("is-busy", locked);
      els.startBtn.classList.toggle("hidden", searchRunning);
    }
    if (els.cancelSearchBtn) {
      els.cancelSearchBtn.classList.toggle("hidden", !searchRunning);
      els.cancelSearchBtn.disabled = !searchRunning;
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

  function postToExt(type, payload) {
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

  function radiusKmFromInput() {
    return parseFloat(String(els.radius?.value || "").replace(",", "."));
  }

  function dispatchMapPreview() {
    const c = readCenterFromForm();
    const radiusKm = radiusKmFromInput();
    if (c && radiusKm > 0) {
      window.dispatchEvent(
        new CustomEvent("timdiemban:map-preview", {
          detail: { lat: c.lat, lng: c.lng, radius: radiusKm }
        })
      );
    }
  }

  function setCenterFields(lat, lng, source, extra = "") {
    const c = normalizeCenterCoords(lat, lng);
    if (!c) return false;
    els.lat.value = String(c.lat);
    els.lng.value = String(c.lng);
    centerSource = source;
    lastKnownCenter = { lat: c.lat, lng: c.lng, source, accuracy: null, at: Date.now() };
    els.centerPreview.textContent = `${c.lat}, ${c.lng}${extra ? ` (${extra})` : ""}`;
    els.centerPreview.classList.remove("hidden");
    dispatchMapPreview();
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
        "Đang quét nền — kết quả tự gửi & lưu. Quay lại tab này bất cứ lúc nào.",
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
        els.radius.value = r >= 100 ? (r / 1000).toFixed(1).replace(/\.0$/, "") : String(r);
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
        reject(new Error("Extension không phản hồi — kiểm tra đã cài và bật findmap"));
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
        reject(new Error("Extension không phản hồi khi dừng tìm kiếm"));
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
          "Phát hiện tab Maps có dấu hiệu treo / chậm phản hồi. Hãy chuyển sang tab Google Maps để tiếp tục ổn định.",
          "info"
        );
      } else if (status.totalCells) {
        updateSearchProgress(
          Math.round(((status.gridIndex || 0) / status.totalCells) * 95),
          `Đang chạy vùng ${(status.gridIndex || 0) + 1}/${status.totalCells} — ${status.mergedCount || 0} quán`
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
            `Extension không phản hồi — mở ${(window.TIMDIEMBAN_CONFIG?.APP_ORIGIN || window.location.origin).replace(/\/$/, "")}, reload extension findmap rồi thử lại`
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

    const extUp = window.TimDiemBanExtVersion?.isUpToDate?.();
    if (extUp === false) {
      showSearchStatus(
        "Extension chưa cập nhật mới nhất — reload tại chrome://extensions trước khi tìm.",
        "error"
      );
      return;
    }
    if (extUp === null && !window.TimDiemBanExtVersion?.getStatus?.()?.bridgeOk) {
      showSearchStatus("Chưa kết nối extension — cài/reload findmap.", "error");
      return;
    }

    const keyword = els.keyword.value.trim();
    const radiusKm = radiusKmFromInput();
    if (!keyword) {
      showSearchStatus("Nhập từ khóa tìm kiếm.", "error");
      return;
    }
    if (!radiusKm || radiusKm < 0.5 || radiusKm > 50) {
      showSearchStatus("Bán kính hợp lệ: 0.5–50 km.", "error");
      return;
    }

    // Xin GPS ngay trong gesture bấm Tìm kiếm (ngầm — không thêm panel/nút trong form).
    // - Chưa có lat/lng: bắt buộc chờ GPS (Chrome hỏi trên thanh địa chỉ nếu còn "prompt")
    // - Đã có lat/lng: vẫn kick GPS trong cùng gesture để Chrome kịp hiện UI nếu còn hỏi được;
    //   không chặn luồng tìm. Đã "denied": Chrome không mở panel (giới hạn trình duyệt).
    let center = readCenterFromForm();
    let gpsPromise = null;

    if (!navigator.geolocation) {
      if (!center) {
        showSearchStatus("Trình duyệt không hỗ trợ GPS — nhập lat/lng hoặc dùng Chọn tâm.", "error");
        return;
      }
    } else {
      if (!center) showSearchStatus(GPS_ASKING_HINT, "info");
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
      } else if (gpsPromise) {
        // Không await — để Chrome có thể hiện hộp thoại trong lúc tìm chạy
        gpsPromise
          .then((c) => {
            if (c) window.TimDiemBanMap?.focusPoint?.(c.lat, c.lng);
          })
          .catch(() => {});
      }

      if (!center) {
        showSearchStatus("Tọa độ không hợp lệ (lat: -90..90, lng: -180..180).", "error");
        return;
      }

      const searchParams = {
        keyword,
        radius: radiusKm,
        lat: center.lat,
        lng: center.lng,
        centerSource,
        webUrl: window.location.origin,
        authToken: token,
        searchId: `search_${Date.now()}`,
        fastMode: document.getElementById("searchFastMode")?.checked || false,
        mapsAutoFocus: isMapsAutoFocusChecked(),
        mapsAutoReopen: isMapsAutoReopenChecked()
      };

      saveLastSearch({
        keyword,
        radius: radiusKm,
        lat: center.lat,
        lng: center.lng,
        centerSource
      });

      setSearchRunning(true);
      armSearchWatchdog();
      clearScrapeLog();
      lastKnownMergedCount = 0;
      showSearchStatus(`Tâm: ${center.lat}, ${center.lng} — đang khởi động...`, "info");
      updateSearchProgress(0, "0%");

      try {
        await requestStartSearch(searchParams);
        const autoFocusHint = searchParams.mapsAutoFocus
          ? `Extension sẽ tự chuyển sang tab Maps mỗi ${getMapsAutoFocusMinutes()} phút nếu bạn rời tab.`
          : "Hãy chuyển sang tab Google Maps và giữ tab đó mở.";
        showSearchStatus(`Đang tìm "${keyword}" — ${autoFocusHint}`, "info");
      } catch (err) {
        showSearchStatus(err.message, "error");
        setSearchRunning(false);
      }
    } catch (err) {
      if (isGeoDeniedError(err)) {
        notifyGpsDenied(err);
      } else {
        showSearchStatus(
          err.message || "Cần tọa độ trung tâm — nhập lat/lng hoặc dùng Chọn tâm.",
          "error"
        );
      }
    } finally {
      submitting = false;
      setFormBusy(false);
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
      window.dispatchEvent(new CustomEvent("timdiemban:bridge-ready", { detail: event.data.payload }));
      requestSearchStatus();
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
    setCenterFields(lat, lng, "map_click", "bấm bản đồ");
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

  [els.lat, els.lng, els.radius].forEach((input) => {
    input?.addEventListener("input", () => {
      const c = readCenterFromForm();
      if (c) {
        centerSource = "manual";
        els.centerPreview.textContent = `${c.lat}, ${c.lng} (nhập tay)`;
        els.centerPreview.classList.remove("hidden");
        dispatchMapPreview();
      } else {
        els.centerPreview.classList.add("hidden");
      }
    });
  });

  els.form?.addEventListener("submit", handleSubmit);

  els.cancelSearchBtn?.addEventListener("click", async () => {
    if (!searchRunning) return;
    els.cancelSearchBtn.disabled = true;
    showSearchStatus("Đang dừng quét...", "info");
    try {
      await requestCancelSearch("Người dùng dừng tìm kiếm");
      showSearchStatus("Đã dừng — đang tổng hợp kết quả...", "info");
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
