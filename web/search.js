/**
 * Form tìm kiếm trên trang kết quả — gửi lệnh tới extension qua web-bridge.
 * Chế độ tìm: theo Phường/Xã (ward boundary GeoJSON).
 */
(function () {
  const LAST_SEARCH_KEY = "timdiemban_last_search";
  const MAPS_AUTO_FOCUS_KEY = "timdiemban_maps_auto_focus";
  const MAPS_AUTO_REOPEN_KEY = "timdiemban_maps_auto_reopen";
  const SEARCH_OPTIONS_OPEN_KEY = "timdiemban_search_options_open";
  const SEARCH_BATCH_RECOVERY_KEY = "timdiemban_search_batch_recovery_v3";

  const els = {
    form: document.getElementById("searchForm"),
    keyword: document.getElementById("searchKeyword"),
    searchAreas: document.getElementById("searchAreas"),
    addSearchAreaBtn: document.getElementById("addSearchAreaBtn"),
    startBtn: document.getElementById("startSearchBtn"),
    pauseSearchBtn: document.getElementById("pauseSearchBtn"),
    resumeSearchBtn: document.getElementById("resumeSearchBtn"),
    cancelSearchBtn: document.getElementById("cancelSearchBtn"),
    searchStatus: document.getElementById("searchStatus"),
    searchProgress: document.getElementById("searchProgress"),
    searchProgressBar: document.getElementById("searchProgressBar"),
    searchProgressText: document.getElementById("searchProgressText"),
    mapsAutoFocus: document.getElementById("searchMapsAutoFocus"),
    mapsAutoFocusLabel: document.getElementById("searchMapsAutoFocusLabel"),
    mapsAutoReopen: document.getElementById("searchMapsAutoReopen"),
    mapsAutoReopenLabel: document.getElementById("searchMapsAutoReopenLabel"),
    searchOptionsPanel: document.getElementById("searchOptionsPanel"),
    searchOptionsToggle: document.getElementById("searchOptionsToggle"),
    searchOptionsBody: document.getElementById("searchOptionsBody"),
    searchOptionsHint: document.getElementById("searchOptionsHint"),
    quickScan: document.getElementById("searchQuickScan")
  };

  /** @type {{id:string, el:HTMLElement, province:HTMLSelectElement, ward:HTMLSelectElement, hint:HTMLElement, removeBtn:HTMLButtonElement, provinceCombo:any, wardCombo:any, info:any, boundary:any, cells:number, capped:boolean}[]} */
  let areaCards = [];
  let cachedProvinces = [];
  let areaCardSeq = 0;

  function stripDiacritics(str) {
    return String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .trim();
  }

  /**
   * Combobox gõ-để-lọc trên <select> (Tỉnh / Phường).
   * Giữ select gốc để code cũ đọc .value / lắng nghe change.
   */
  function enhanceSearchableSelect(selectEl, { placeholder = "Gõ để tìm…" } = {}) {
    if (!selectEl || selectEl.dataset.searchable === "1") return selectEl?._combo || null;
    selectEl.dataset.searchable = "1";

    const wrap = document.createElement("div");
    wrap.className = "wm-combo";
    selectEl.parentNode.insertBefore(wrap, selectEl);
    wrap.appendChild(selectEl);
    selectEl.classList.add("wm-combo-native");
    selectEl.setAttribute("aria-hidden", "true");
    selectEl.tabIndex = -1;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "wm-control wm-combo-input";
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    wrap.appendChild(input);

    const list = document.createElement("ul");
    list.className = "wm-combo-list hidden";
    list.setAttribute("role", "listbox");
    wrap.appendChild(list);

    let activeIndex = -1;
    let open = false;

    function optionEntries() {
      return [...selectEl.options]
        .filter((o) => o.value !== "")
        .map((o) => ({ value: o.value, label: o.textContent || o.value }));
    }

    function syncInputFromSelect() {
      const opt = selectEl.selectedOptions?.[0];
      if (opt && opt.value) input.value = opt.textContent || "";
      else if (!open) input.value = "";
    }

    function setOpen(next) {
      open = next;
      list.classList.toggle("hidden", !open);
      input.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) activeIndex = -1;
    }

    function renderList(filterText = "") {
      const q = stripDiacritics(filterText);
      const items = optionEntries().filter((it) => {
        if (!q) return true;
        return stripDiacritics(it.label).includes(q) || stripDiacritics(it.value).includes(q);
      });
      list.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("li");
        empty.className = "wm-combo-empty";
        empty.textContent = "Không có kết quả";
        list.appendChild(empty);
        activeIndex = -1;
        return items;
      }
      items.forEach((it, idx) => {
        const li = document.createElement("li");
        li.className = "wm-combo-option";
        li.setAttribute("role", "option");
        li.dataset.value = it.value;
        li.textContent = it.label;
        if (it.value === selectEl.value) li.classList.add("is-selected");
        if (idx === activeIndex) li.classList.add("is-active");
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(it.value, it.label);
        });
        list.appendChild(li);
      });
      return items;
    }

    function pick(value, label) {
      const prev = selectEl.value;
      selectEl.value = value;
      input.value = label || selectEl.selectedOptions?.[0]?.textContent || "";
      setOpen(false);
      if (prev !== value) {
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    function highlight(delta, itemsLen) {
      if (!itemsLen) return;
      activeIndex = (activeIndex + delta + itemsLen) % itemsLen;
      [...list.querySelectorAll(".wm-combo-option")].forEach((el, i) => {
        el.classList.toggle("is-active", i === activeIndex);
        if (i === activeIndex) el.scrollIntoView({ block: "nearest" });
      });
    }

    input.addEventListener("focus", () => {
      if (selectEl.disabled) return;
      activeIndex = -1;
      renderList(input.value);
      setOpen(true);
    });

    input.addEventListener("input", () => {
      if (selectEl.disabled) return;
      activeIndex = -1;
      renderList(input.value);
      setOpen(true);
    });

    input.addEventListener("keydown", (e) => {
      if (selectEl.disabled) return;
      const options = [...list.querySelectorAll(".wm-combo-option")];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open) {
          renderList(input.value);
          setOpen(true);
        }
        highlight(1, options.length || renderList(input.value).length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight(-1, options.length);
      } else if (e.key === "Enter") {
        if (open && activeIndex >= 0 && options[activeIndex]) {
          e.preventDefault();
          pick(options[activeIndex].dataset.value, options[activeIndex].textContent);
        }
      } else if (e.key === "Escape") {
        setOpen(false);
        syncInputFromSelect();
      }
    });

    input.addEventListener("blur", () => {
      setTimeout(() => {
        setOpen(false);
        if (selectEl.value) syncInputFromSelect();
        else input.value = "";
      }, 150);
    });

    const combo = {
      refresh() {
        input.disabled = !!selectEl.disabled;
        wrap.classList.toggle("is-disabled", !!selectEl.disabled);
        syncInputFromSelect();
        if (open) renderList(input.value);
      },
      syncFromSelect: syncInputFromSelect
    };
    selectEl._combo = combo;
    combo.refresh();

    const mo = new MutationObserver(() => combo.refresh());
    mo.observe(selectEl, { attributes: true, attributeFilter: ["disabled"] });
    return combo;
  }

  // ——— Maps Auto Focus helpers ———
  function isMapsAutoFocusChecked() {
    return !!els.mapsAutoFocus?.checked;
  }

  function loadMapsAutoFocusPref() {
    try {
      if (!els.mapsAutoFocus) return;
      const saved = localStorage.getItem(MAPS_AUTO_FOCUS_KEY);
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
      "Maps luôn được đưa lên trước một lần khi bắt đầu lấy danh sách. Bật tùy chọn này để tự khôi phục Maps nếu không có dữ liệu mới trong 5 phút hoặc thao tác thất bại.";
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

  // ——— Maps Auto Reopen helpers ———
  function isMapsAutoReopenChecked() {
    return !!els.mapsAutoReopen?.checked;
  }

  function loadMapsAutoReopenPref() {
    try {
      if (!els.mapsAutoReopen) return;
      const saved = localStorage.getItem(MAPS_AUTO_REOPEN_KEY);
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

  // ——— Search options panel ———
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
    if (els.quickScan?.checked) tags.push("Quét nhanh: 2 tab");
    if (els.mapsAutoFocus?.checked) tags.push("Khôi phục Maps khi treo");
    if (els.mapsAutoReopen?.checked) tags.push("Mở lại tab");
    els.searchOptionsHint.textContent = tags.length ? tags.join(" · ") : "Chưa bật";
  }

  function onSearchOptionChange() {
    updateSearchOptionsHint();
  }

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

  // ——— Form state ———
  let searchRunning = false;
  let searchPaused = false;
  let formBusy = false;
  let busyOperation = "";
  let submitting = false;
  let multiKeywordBatch = false;
  let multiKeywordAbort = false;
  let pendingBatchResume = null;
  let batchRecoveryStarting = false;
  let workspaceReady = false;
  let latestSearchStatus = null;
  let activeSearchEndWaiter = null;

  // ——— Multi-area ward selection ———

  function fillProvinceSelect(selectEl, selectedCode = "") {
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="">-- Chọn Tỉnh / Thành phố --</option>';
    for (const p of cachedProvinces) {
      const opt = document.createElement("option");
      opt.value = p.code;
      opt.textContent = p.fullName || p.name;
      selectEl.appendChild(opt);
    }
    if (selectedCode) selectEl.value = selectedCode;
    selectEl._combo?.refresh?.();
  }

  function computeScanCells(boundaryGeoJSON) {
    if (!boundaryGeoJSON || typeof generateGridFromPolygon !== "function") {
      return { cells: 0, capped: false, cellSizeM: 0 };
    }
    try {
      const grid = generateGridFromPolygon(boundaryGeoJSON);
      return {
        cells: Number(grid?.totalCells) || 0,
        capped: grid?.capped === true,
        cellSizeM: Math.round((Number(grid?.viewportM) || Number(grid?.cellSizeKm) * 1000) || 0)
      };
    } catch {
      return { cells: 0, capped: false, cellSizeM: 0 };
    }
  }

  function showAreaHint(card, info, cells, capped, cellSizeM = 0) {
    if (!card?.hint) return;
    const name = info?.fullName || info?.name || "";
    if (!name && !cells) {
      card.hint.classList.add("hidden");
      return;
    }
    let text = name || "Khu vực";
    let type = "info";
    if (cells > 0) {
      text = `${name} · ~${cells} ô quét`;
      if (cellSizeM > 0) text += ` (ô ~${cellSizeM}m)`;
      if (capped) {
        text += " — phường/xã lớn, chỉ quét phần gần tâm";
        type = "warn";
      }
    }
    card.hint.textContent = text;
    card.hint.className = `ward-hint ward-hint-${type}`;
    card.hint.classList.remove("hidden");
  }

  function renumberAreaCards() {
    areaCards.forEach((card, idx) => {
      const title = card.el.querySelector(".wm-area-card-title");
      if (title) title.textContent = `Khu vực ${idx + 1}`;
      if (card.removeBtn) {
        card.removeBtn.classList.toggle("hidden", areaCards.length <= 1);
      }
    });
    if (els.addSearchAreaBtn) {
      els.addSearchAreaBtn.disabled = false;
    }
  }

  /** Cache khu vực của batch đang chạy — để map giữ đủ polygon khi nhảy KV. */
  let lastBatchAreasForMap = null;

  /**
   * Vẽ lại TẤT CẢ khu vực + lưới ô quét (không xóa khu vực cũ).
   * opts.areas: mảng payload batch (ưu tiên hơn form cards)
   * opts.activeAreaIndex: làm nổi khu vực đang quét
   */
  function redrawAllAreaMaps(opts = {}) {
    if (typeof window.TimDiemBanMap?.drawSearchAreas !== "function") return;

    const sourceAreas = Array.isArray(opts.areas)
      ? opts.areas
      : Array.isArray(lastBatchAreasForMap) && lastBatchAreasForMap.length
        ? lastBatchAreasForMap
        : null;

    const areas = [];
    if (sourceAreas?.length) {
      sourceAreas.forEach((area, idx) => {
        const boundary = area.wardBoundary || area.boundary;
        if (!boundary?.features?.length) return;
        let gridPoints = [];
        let cellSizeKm = 0.4;
        if (typeof generateGridFromPolygon === "function") {
          try {
            const grid = generateGridFromPolygon(boundary);
            gridPoints = grid.points || [];
            cellSizeKm = grid.cellSizeKm || 0.4;
          } catch {}
        }
        areas.push({
          wardCode: area.wardCode || "",
          wardName: area.wardName || "",
          wardFullName: area.wardFullName || area.wardName || "",
          boundary,
          gridPoints,
          cellSizeKm,
          colorIndex: idx,
          active: Number(opts.activeAreaIndex) === idx
        });
      });
    } else {
      areaCards.forEach((card, idx) => {
        if (!card?.boundary?.features?.length) return;
        let gridPoints = [];
        let cellSizeKm = 0.4;
        if (typeof generateGridFromPolygon === "function") {
          try {
            const grid = generateGridFromPolygon(card.boundary);
            gridPoints = grid.points || [];
            cellSizeKm = grid.cellSizeKm || 0.4;
            card.cells = Number(grid.totalCells) || gridPoints.length;
            card.capped = grid.capped === true;
            card.cellSizeM = Math.round(Number(grid.viewportM) || cellSizeKm * 1000) || 0;
          } catch {}
        }
        areas.push({
          wardCode: card.info?.code || card.ward?.value || "",
          wardName: card.info?.name || "",
          wardFullName: card.info?.fullName || card.info?.name || "",
          boundary: card.boundary,
          gridPoints,
          cellSizeKm,
          colorIndex: idx,
          active: Number(opts.activeAreaIndex) === idx
        });
      });
    }

    window.TimDiemBanMap.drawSearchAreas(areas, {
      fit: opts.fit !== false,
      force: opts.force === true,
      activeAreaIndex:
        opts.activeAreaIndex != null && Number.isFinite(Number(opts.activeAreaIndex))
          ? Number(opts.activeAreaIndex)
          : null
    });
  }

  async function loadWardsIntoCard(card, provinceCode, preferredWardCode = "") {
    if (!card?.ward) return;
    card.ward.innerHTML = '<option value="">-- Đang tải... --</option>';
    card.ward.disabled = true;
    card.wardCombo?.refresh?.();
    card.info = null;
    card.boundary = null;
    card.cells = 0;
    card.capped = false;
    card.hint?.classList.add("hidden");
    redrawAllAreaMaps({ fit: false, force: true });

    if (!provinceCode) {
      card.ward.innerHTML = '<option value="">-- Chọn Phường / Xã --</option>';
      card.wardCombo?.refresh?.();
      return;
    }

    try {
      const res = await fetch(`/api/geo/wards?province_code=${encodeURIComponent(provinceCode)}`);
      if (!res.ok) throw new Error("fetch wards failed");
      const wards = await res.json();
      if (!Array.isArray(wards)) throw new Error("invalid response");

      card.ward.innerHTML = '<option value="">-- Chọn Phường / Xã --</option>';
      for (const w of wards) {
        const opt = document.createElement("option");
        opt.value = w.code;
        opt.textContent = w.fullName || w.name;
        card.ward.appendChild(opt);
      }
      card.ward.disabled = false;
      if (preferredWardCode && wards.some((w) => w.code === preferredWardCode)) {
        card.ward.value = preferredWardCode;
        await onAreaWardSelected(card);
      }
      card.wardCombo?.refresh?.();
    } catch (err) {
      console.warn("[Findmap] loadWardsIntoCard:", err);
      card.ward.innerHTML = '<option value="">-- Lỗi tải dữ liệu --</option>';
      card.wardCombo?.refresh?.();
    }
  }

  async function onAreaWardSelected(card) {
    const code = card.ward?.value;
    if (!code) {
      card.info = null;
      card.boundary = null;
      card.cells = 0;
      card.capped = false;
      card.hint?.classList.add("hidden");
      redrawAllAreaMaps({ fit: true, force: true });
      return;
    }

    try {
      const [infoRes, boundaryRes] = await Promise.all([
        fetch(`/api/geo/ward-info/${encodeURIComponent(code)}`),
        fetch(`/api/geo/ward-boundary/${encodeURIComponent(code)}`)
      ]);
      let info = null;
      if (infoRes.ok) {
        try { info = await infoRes.json(); } catch {}
      }
      let boundary = null;
      if (boundaryRes.ok) {
        try { boundary = await boundaryRes.json(); } catch {}
      }
      card.info = info;
      card.boundary = boundary;
      const scan = computeScanCells(boundary);
      card.cells = scan.cells;
      card.capped = scan.capped;
      card.cellSizeM = scan.cellSizeM || 0;
      showAreaHint(
        card,
        info || { fullName: `Phường ${code}` },
        card.cells,
        card.capped,
        card.cellSizeM
      );
      redrawAllAreaMaps({ fit: true, force: true });
    } catch (err) {
      console.warn("[Findmap] onAreaWardSelected:", err);
      card.hint.textContent = "Không tải được thông tin phường/xã.";
      card.hint.className = "ward-hint ward-hint-warn";
      card.hint.classList.remove("hidden");
    }
  }

  function createAreaCard({ provinceCode = "", wardCode = "" } = {}) {
    const id = `area_${++areaCardSeq}`;
    const el = document.createElement("div");
    el.className = "wm-area-card";
    el.dataset.areaId = id;
    el.innerHTML = `
      <div class="wm-area-card-head">
        <span class="wm-area-card-title">Khu vực</span>
        <button type="button" class="wm-area-remove" data-area-remove>Xóa</button>
      </div>
      <div class="wm-field">
        <label>Tỉnh / Thành phố</label>
        <select class="wm-control area-province">
          <option value="">-- Chọn Tỉnh / Thành phố --</option>
        </select>
      </div>
      <div class="wm-field">
        <label>Phường / Xã</label>
        <select class="wm-control area-ward" disabled>
          <option value="">-- Chọn Phường / Xã --</option>
        </select>
      </div>
      <p class="ward-hint hidden area-hint"></p>
    `;

    const province = el.querySelector(".area-province");
    const ward = el.querySelector(".area-ward");
    const hint = el.querySelector(".area-hint");
    const removeBtn = el.querySelector("[data-area-remove]");
    els.searchAreas?.appendChild(el);

    const provinceCombo = enhanceSearchableSelect(province, {
      placeholder: "Gõ tên tỉnh / thành phố…"
    });
    const wardCombo = enhanceSearchableSelect(ward, {
      placeholder: "Gõ tên phường / xã…"
    });

    const card = {
      id,
      el,
      province,
      ward,
      hint,
      removeBtn,
      provinceCombo,
      wardCombo,
      info: null,
      boundary: null,
      cells: 0,
      capped: false
    };
    areaCards.push(card);

    fillProvinceSelect(province, provinceCode);
    province.addEventListener("change", () => {
      provinceCombo?.syncFromSelect?.();
      loadWardsIntoCard(card, province.value || "");
    });
    ward.addEventListener("change", () => {
      wardCombo?.syncFromSelect?.();
      onAreaWardSelected(card);
    });
    removeBtn?.addEventListener("click", () => removeAreaCard(card.id));

    if (provinceCode) {
      loadWardsIntoCard(card, provinceCode, wardCode);
    }

    renumberAreaCards();
    return card;
  }

  function removeAreaCard(id) {
    if (areaCards.length <= 1) return;
    const idx = areaCards.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const [card] = areaCards.splice(idx, 1);
    card.el?.remove();
    renumberAreaCards();
    redrawAllAreaMaps({ fit: true, force: true });
  }

  async function loadProvinces() {
    try {
      const res = await fetch("/api/geo/provinces");
      if (!res.ok) return;
      const provinces = await res.json();
      if (!Array.isArray(provinces)) return;
      cachedProvinces = provinces;
      for (const card of areaCards) {
        const keep = card.province?.value || "";
        fillProvinceSelect(card.province, keep);
      }
    } catch (err) {
      console.warn("[Findmap] loadProvinces:", err);
    }
  }

  function buildAreaPayload(card, areaIndex = 0) {
    if (!card?.info || !card?.boundary) return null;
    const wardCode = card.info.code || card.ward?.value || "";
    const wardName = card.info.name || "";
    const wardFullName = card.info.fullName || wardName;
    return {
      provinceCode: card.info.provinceCode || card.province?.value || "",
      provinceName: card.info.provinceName || "",
      wardCode,
      wardName,
      wardFullName,
      wardBoundary: card.boundary,
      // null = extension tự chọn kích thước ô theo diện tích khu vực
      viewportM: null,
      areaIndex,
      areaLabel: wardFullName || wardName || `Khu vực ${areaIndex + 1}`,
      estimatedCells: card.cells || 0
    };
  }

  function collectAreaPayloads() {
    return areaCards.map((card, idx) => buildAreaPayload(card, idx));
  }

  function validateAreasOrError() {
    const payloads = collectAreaPayloads();
    if (!payloads.length) return { error: "Thêm ít nhất một khu vực tìm kiếm." };
    for (let i = 0; i < payloads.length; i++) {
      if (!payloads[i]) {
        return { error: `Khu vực ${i + 1}: chọn đủ Tỉnh và Phường/Xã.` };
      }
      if (!payloads[i].wardBoundary?.features?.length) {
        return { error: `Khu vực ${i + 1}: chưa có ranh giới — chọn lại phường/xã.` };
      }
    }
    const codes = payloads.map((p) => p.wardCode);
    if (new Set(codes).size !== codes.length) {
      return { error: "Các khu vực không được trùng cùng một phường/xã." };
    }
    return { areas: payloads };
  }

  async function hydrateAreaBoundary(areaMeta) {
    if (areaMeta?.wardBoundary?.features?.length) return areaMeta;
    const code = areaMeta?.wardCode;
    if (!code) return null;
    const [infoRes, boundaryRes] = await Promise.all([
      fetch(`/api/geo/ward-info/${encodeURIComponent(code)}`),
      fetch(`/api/geo/ward-boundary/${encodeURIComponent(code)}`)
    ]);
    let info = areaMeta;
    if (infoRes.ok) {
      try { info = { ...areaMeta, ...(await infoRes.json()) }; } catch {}
    }
    let boundary = null;
    if (boundaryRes.ok) {
      try { boundary = await boundaryRes.json(); } catch {}
    }
    if (!boundary?.features?.length) return null;
    return {
      provinceCode: info.provinceCode || areaMeta.provinceCode || "",
      provinceName: info.provinceName || areaMeta.provinceName || "",
      wardCode: info.code || areaMeta.wardCode || "",
      wardName: info.name || areaMeta.wardName || "",
      wardFullName: info.fullName || areaMeta.wardFullName || areaMeta.wardName || "",
      wardBoundary: boundary,
      areaLabel: info.fullName || areaMeta.areaLabel || areaMeta.wardName || "",
      estimatedCells: computeScanCells(boundary).cells
    };
  }

  function slimAreaForRecovery(area) {
    return {
      provinceCode: area.provinceCode || "",
      provinceName: area.provinceName || "",
      wardCode: area.wardCode || "",
      wardName: area.wardName || "",
      wardFullName: area.wardFullName || "",
      areaLabel: area.areaLabel || area.wardFullName || area.wardName || ""
    };
  }

  function buildPlannedContexts(areas, keywords) {
    const out = [];
    for (let ai = 0; ai < areas.length; ai++) {
      const area = areas[ai];
      for (let ki = 0; ki < keywords.length; ki++) {
        const keyword = keywords[ki];
        const wardCode = area.wardCode || "";
        const wardName = area.wardName || area.wardFullName || `KV${ai + 1}`;
        const key = `${wardCode}::${keyword}`;
        out.push({
          key,
          wardCode,
          wardName,
          wardFullName: area.wardFullName || wardName,
          keyword,
          label: `${wardName} · ${keyword}`,
          areaIndex: ai,
          keywordIndex: ki
        });
      }
    }
    return out;
  }

  function isFormLocked() {
    return (
      formBusy ||
      searchRunning ||
      searchPaused ||
      submitting ||
      multiKeywordBatch ||
      batchRecoveryStarting
    );
  }

  function busyMessage() {
    if (searchPaused) return "Lượt quét đang tạm dừng — hãy tiếp tục hoặc dừng hẳn trước.";
    if (multiKeywordBatch || searchRunning) return "Đang tìm kiếm — vui lòng đợi hoàn tất.";
    if (submitting) return "Đang chuẩn bị tìm kiếm — vui lòng đợi.";
    if (formBusy) return "Đang xử lý — vui lòng đợi xong.";
    return "Đang bận — vui lòng đợi.";
  }

  function waitForSearchEnd(expectedSearchId, inactiveTimeoutMs = 12 * 60 * 1000) {
    let markStarted = () => {};
    let cancel = () => {};
    const promise = new Promise((resolve) => {
      let done = false;
      let started = false;
      let pollTimer = null;
      let pollBusy = false;
      let lastConfirmedAliveAt = 0;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (pollTimer) clearInterval(pollTimer);
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
        return !!sid && sid === expectedSearchId;
      };
      const confirmAlive = () => {
        if (!started) return;
        lastConfirmedAliveAt = Date.now();
      };
      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext") return;
        const t = event.data.type;
        const payload = event.data.payload || {};
        if ((t === "start" || t === "progress") && matchesSearch(payload)) {
          confirmAlive();
        }
        if (t === "complete" || t === "error" || t === "tab_closed") {
          if (!matchesSearch(payload)) return;
          finish({ type: t, payload });
        }
      }
      function onFinished(ev) {
        const sid = ev?.detail?.searchId;
        if (!expectedSearchId || !sid || sid !== expectedSearchId) return;
        const payload = ev?.detail || {};
        finish({ type: payload.type || "finished", payload });
      }

      const pollStatus = async () => {
        if (!started || done || pollBusy) return;
        pollBusy = true;
        try {
          const status = await requestSearchStatusAsync(6000);
          if (done) return;
          const sameSearch = !expectedSearchId || status?.searchId === expectedSearchId;
          if (
            sameSearch &&
            (status?.running || status?.stalled || status?.paused || status?.canResume)
          ) {
            confirmAlive();
            if (status?.mergedCount != null) {
              lastKnownMergedCount = Math.max(lastKnownMergedCount, Number(status.mergedCount) || 0);
            }
            return;
          }
          if (Date.now() - lastConfirmedAliveAt >= inactiveTimeoutMs) {
            lastConfirmedAliveAt = Date.now();
            showSearchStatus(
              "Tạm thời chưa xác nhận được trạng thái extension. Findmap vẫn giữ lượt quét và tiếp tục chờ; bạn có thể tải lại trang để kết nối lại.",
              "info"
            );
          }
        } finally {
          pollBusy = false;
        }
      };

      window.addEventListener("message", onMsg);
      window.addEventListener("timdiemban:search-finished", onFinished);
      pollTimer = setInterval(pollStatus, 15000);
      markStarted = () => {
        if (done || started) return;
        started = true;
        lastConfirmedAliveAt = Date.now();
        pollStatus();
      };
      cancel = (result = { type: "cancelled", payload: {} }) => finish(result);
    });

    return { promise, markStarted, cancel };
  }

  /** Chờ extension thật sự rảnh trước khi START từ khóa / khu vực tiếp */
  async function waitForExtensionIdle(timeoutMs = 45000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await requestSearchStatusAsync(4000);
      // canResume khi paused mới coi là bận; checkpoint mồ côi không chặn
      const busy = !!(
        status?.running ||
        status?.stalled ||
        status?.paused ||
        (status?.canResume && status?.paused)
      );
      if (!busy) {
        await new Promise((r) => setTimeout(r, 700));
        const again = await requestSearchStatusAsync(3000);
        const stillBusy = !!(
          again?.running ||
          again?.stalled ||
          again?.paused ||
          (again?.canResume && again?.paused)
        );
        if (!stillBusy) return true;
      }
      await new Promise((r) => setTimeout(r, 700));
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
      els.startBtn.disabled = locked;
      els.startBtn.title = locked ? busyMessage() : "";
      els.startBtn.classList.toggle("is-busy", locked);
      els.startBtn.classList.toggle("hidden", searchRunning || searchPaused || multiKeywordBatch);
    }
    if (els.addSearchAreaBtn) {
      els.addSearchAreaBtn.disabled = locked;
    }
    for (const card of areaCards) {
      if (card.province) card.province.disabled = locked;
      if (card.ward) card.ward.disabled = locked || !card.province?.value;
      card.provinceCombo?.refresh?.();
      card.wardCombo?.refresh?.();
      if (card.removeBtn) card.removeBtn.disabled = locked || areaCards.length <= 1;
    }
    if (els.pauseSearchBtn) {
      const canPause = searchRunning && !searchPaused;
      els.pauseSearchBtn.classList.toggle("hidden", !canPause);
      els.pauseSearchBtn.disabled = !canPause;
    }
    if (els.resumeSearchBtn) {
      els.resumeSearchBtn.classList.toggle("hidden", !searchPaused);
      els.resumeSearchBtn.disabled = !searchPaused;
    }
    if (els.cancelSearchBtn) {
      const canCancel = searchRunning || searchPaused || multiKeywordBatch;
      els.cancelSearchBtn.classList.toggle("hidden", !canCancel);
      els.cancelSearchBtn.disabled = !canCancel;
    }
    if (els.cancelSearchBtn && searchRunning) {
      els.cancelSearchBtn.disabled = false;
    }
    if (els.cancelSearchBtn && searchPaused) {
      els.cancelSearchBtn.disabled = false;
    }
    for (const buttonId of ["resetBtn", "clearBtn"]) {
      const button = document.getElementById(buttonId);
      if (!button) continue;
      if (!button.dataset.defaultTitle) button.dataset.defaultTitle = button.title || "";
      button.disabled = locked;
      button.title = locked
        ? "Hãy tạm dừng rồi dừng hẳn lượt quét trước khi xóa kết quả."
        : button.dataset.defaultTitle;
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
    if (extBridgeDead && type !== "PING_EXT") return;
    window.postMessage({ source: "timdiemban-web", type, payload }, window.location.origin);
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
  }

  function showMapsFocusModal(status = {}) {
    const listInterrupted = status.mapsTabHiddenDuringList === true;
    if (els.mapsFocusModal) {
      els.mapsFocusModal.dataset.mode = listInterrupted ? "list-hidden" : "recovery";
    }
    if (els.mapsFocusModalTitle) {
      els.mapsFocusModalTitle.textContent = listInterrupted
        ? "Hãy quay lại tab Google Maps"
        : "Đang khôi phục tab Maps";
    }
    if (els.mapsFocusModalLead) {
      els.mapsFocusModalLead.textContent = listInterrupted
        ? "Findmap đang lấy danh sách URL của khu vực hiện tại. Khi Maps ở nền, bước này có thể bị gián đoạn; hãy quay lại tab Google Maps để hệ thống tiếp tục lấy đủ danh sách."
        : "Tiến trình đang chậm hoặc kết quả về Findmap bị trễ. Hãy giữ tab Google Maps mở; Findmap sẽ thử kết nối lại ở nền. Nếu không có dữ liệu mới trong 5 phút hoặc thao tác nền thất bại, tiện ích mới tự đưa tab Maps lên trước để khôi phục.";
    }
    els.mapsFocusModal?.classList.remove("hidden");
  }

  function hideMapsFocusModal() {
    els.mapsFocusModal?.classList.add("hidden");
    if (els.mapsFocusModal) delete els.mapsFocusModal.dataset.mode;
  }

  function hideMapsListInterruptionModal() {
    if (els.mapsFocusModal?.dataset.mode === "list-hidden") hideMapsFocusModal();
  }

  function getShownResultCount() {
    return parseInt(document.getElementById("infoTotal")?.textContent || "0", 10) || 0;
  }

  function shouldShowMapsIssueModal(status) {
    if (!status) return false;
    if (status.mapsTabHiddenDuringList === true) return true;
    if (status.stalled) return true;
    const extCount = Number(status.mergedCount || 0);
    const shown = getShownResultCount();
    return extCount > 0 && extCount - shown >= 5;
  }

  function setSearchRunning(running) {
    searchRunning = running;
    if (running) searchPaused = false;
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

  function setSearchPaused(paused) {
    searchPaused = paused;
    if (paused) {
      searchRunning = false;
      clearSearchWatchdog();
      clearSearchSyncPoll();
      hideMapsFocusModal();
    }
    updateBackgroundSearchHint();
    updateFormControls();
  }

  function updateBackgroundSearchHint() {
    if (!searchRunning || !els.searchStatus) return;
    if (document.visibilityState === "hidden") {
      showSearchStatus(
        "Tìm kiếm vẫn tiếp tục và kết quả đang được đồng bộ. Khi Maps đang lấy danh sách URL, hãy giữ tab đó ở phía trước; giai đoạn đọc chi tiết vẫn có thể chạy khi bạn dùng tab khác.",
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
      if (s.keyword) els.keyword.value = s.keyword;
      const areas = Array.isArray(s.areas) && s.areas.length
        ? s.areas
        : s.wardCode && s.provinceCode
          ? [{ provinceCode: s.provinceCode, wardCode: s.wardCode }]
          : [];
      if (!areas.length) return;
      while (areaCards.length) {
        const card = areaCards.pop();
        card.el?.remove();
      }
      for (const a of areas) {
        createAreaCard({
          provinceCode: a.provinceCode || "",
          wardCode: a.wardCode || ""
        });
      }
      if (!areaCards.length) createAreaCard();
    } catch {}
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

  function requestPauseSearch(reason) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("Chưa nhận được xác nhận tạm dừng. Tiến trình vẫn có thể đang chạy."));
      }, 30000);

      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext" || event.data?.type !== "pause_ack") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMsg);
        const p = event.data.payload || {};
        if (p.success) resolve(p);
        else reject(new Error(p.error || "Không tạm dừng được lượt quét"));
      }

      window.addEventListener("message", onMsg);
      postToExt("PAUSE_SEARCH", { reason });
    });
  }

  function requestResumeSearch() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("Chưa mở lại được tiến trình. Hãy kiểm tra extension và thử lại."));
      }, 45000);

      function onMsg(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== "timdiemban-ext" || event.data?.type !== "resume_ack") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMsg);
        const p = event.data.payload || {};
        if (p.success) resolve(p);
        else reject(new Error(p.error || "Không tiếp tục được lượt quét"));
      }

      window.addEventListener("message", onMsg);
      postToExt("RESUME_SEARCH");
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
    const pausedOrRecoverable = !!(
      status.paused ||
      (!status.running && !status.stalled && status.canResume)
    );
    if (pausedOrRecoverable) {
      setSearchPaused(true);
      if (status.mapsAutoFocus != null) syncMapsAutoFocusCheckbox(!!status.mapsAutoFocus);
      if (status.mapsAutoReopen != null) syncMapsAutoReopenCheckbox(!!status.mapsAutoReopen);
      hideMapsFocusModal();
      if (status.totalCells) {
        updateSearchProgress(
          Math.round(((status.gridIndex || 0) / status.totalCells) * 95),
          `Đã tạm dừng tại khu vực ${(status.gridIndex || 0) + 1}/${status.totalCells} · ${status.mergedCount || 0} điểm bán`
        );
      }
      showSearchStatus(
        status.pauseReason || "Tiến độ đang được giữ an toàn. Bấm 'Tiếp tục quét' để chạy tiếp đúng chỗ đang dở.",
        "info"
      );
      return;
    }
    if (status.running || status.stalled) {
      setSearchPaused(false);
      setSearchRunning(true);
      if (status.mapsAutoFocus != null) syncMapsAutoFocusCheckbox(!!status.mapsAutoFocus);
      if (status.mapsAutoReopen != null) syncMapsAutoReopenCheckbox(!!status.mapsAutoReopen);
      if (shouldShowMapsIssueModal(status)) showMapsFocusModal(status);
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
    } else if (!status.running && (searchRunning || searchPaused)) {
      setSearchPaused(false);
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

  // ——— Batch recovery (areas × keywords) ———

  function getBatchAccountScope() {
    const token = String(localStorage.getItem("timdiemban_token") || "");
    if (!token) return "";
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `session-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function readBatchRecovery() {
    try {
      const value = JSON.parse(localStorage.getItem(SEARCH_BATCH_RECOVERY_KEY) || "null");
      if (!value || value.version !== 3) return null;
      if (!Array.isArray(value.keywords) || !value.keywords.length || value.keywords.length > 10) {
        return null;
      }
      if (!Array.isArray(value.areas) || !value.areas.length) {
        return null;
      }
      if (!Number.isSafeInteger(value.nextJobIndex) || value.nextJobIndex < 0) return null;
      if (!value.baseParams || typeof value.baseParams !== "object") return null;
      const accountScope = getBatchAccountScope();
      if (!accountScope) return null;
      if (value.accountScope !== accountScope) {
        localStorage.removeItem(SEARCH_BATCH_RECOVERY_KEY);
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function writeBatchRecovery(value) {
    try {
      const baseParams = { ...(value.baseParams || {}) };
      delete baseParams.authToken;
      delete baseParams.wardBoundary;
      const areas = (value.areas || []).map(slimAreaForRecovery);
      localStorage.setItem(
        SEARCH_BATCH_RECOVERY_KEY,
        JSON.stringify({
          ...value,
          version: 3,
          accountScope: getBatchAccountScope(),
          baseParams,
          areas,
          savedAt: Date.now()
        })
      );
    } catch {}
  }

  function clearBatchRecovery() {
    try {
      localStorage.removeItem(SEARCH_BATCH_RECOVERY_KEY);
      localStorage.removeItem("timdiemban_search_batch_recovery_v2");
    } catch {}
  }

  function totalJobs(areasLen, keywordsLen) {
    return Math.max(0, areasLen) * Math.max(0, keywordsLen);
  }

  function jobCoords(jobIndex, keywordsLen) {
    const ki = keywordsLen > 0 ? jobIndex % keywordsLen : 0;
    const ai = keywordsLen > 0 ? Math.floor(jobIndex / keywordsLen) : 0;
    return { areaIndex: ai, keywordIndex: ki };
  }

  function launchRecoveredBatch(state) {
    if (!state || batchRecoveryStarting || multiKeywordBatch || searchRunning || searchPaused) return;
    if (!workspaceReady) return;
    const jobs = totalJobs(state.areas?.length || 0, state.keywords?.length || 0);
    if (state.nextJobIndex >= jobs) {
      clearBatchRecovery();
      return;
    }
    batchRecoveryStarting = true;
    pendingBatchResume = state;
    if (els.keyword) els.keyword.value = state.keywords.join(", ");
    while (areaCards.length) {
      const card = areaCards.pop();
      card.el?.remove();
    }
    for (const a of state.areas || []) {
      createAreaCard({
        provinceCode: a.provinceCode || "",
        wardCode: a.wardCode || ""
      });
    }
    if (!areaCards.length) createAreaCard();
    if (els.quickScan) els.quickScan.checked = state.baseParams.quickScan === true;
    if (els.mapsAutoFocus) els.mapsAutoFocus.checked = state.baseParams.mapsAutoFocus === true;
    if (els.mapsAutoReopen) els.mapsAutoReopen.checked = state.baseParams.mapsAutoReopen === true;
    updateSearchOptionsHint();
    queueMicrotask(() => {
      handleSubmit({ preventDefault() {} }).finally(() => {
        batchRecoveryStarting = false;
        updateFormControls();
      });
    });
  }

  function continueRecoveredBatchAfterTerminal(payload = {}) {
    const state = readBatchRecovery();
    if (!state) return false;
    const completedSearchId =
      payload.searchParams?.searchId || payload.searchId || payload.search?.searchId || "";
    if (!completedSearchId || state.activeSearchId !== completedSearchId) return false;
    const terminalType = payload.type || "complete";
    const end = { type: terminalType, payload };
    if (isUserCancelEnd(end)) {
      clearBatchRecovery();
      return true;
    }
    if (terminalType === "error" || terminalType === "tab_closed") {
      writeBatchRecovery({ ...state, phase: "between", activeSearchId: "" });
      return true;
    }
    const nextJobIndex = Math.max(
      state.nextJobIndex,
      Number(state.currentJobIndex || 0) + 1
    );
    const jobs = totalJobs(state.areas.length, state.keywords.length);
    const nextState = { ...state, nextJobIndex, phase: "between", activeSearchId: "" };
    writeBatchRecovery(nextState);
    if (nextJobIndex >= jobs) {
      clearBatchRecovery();
      updateSearchProgress(100, "Hoàn tất");
      showSearchStatus(
        `Hoàn tất ${state.areas.length} khu vực × ${state.keywords.length} từ khóa — xem các tab kết quả.`,
        "success"
      );
      return true;
    }
    const { areaIndex, keywordIndex } = jobCoords(nextJobIndex, state.keywords.length);
    showSearchStatus(
      `Đã khôi phục chuỗi — chuẩn bị khu vực ${areaIndex + 1}/${state.areas.length}, từ khóa ${keywordIndex + 1}/${state.keywords.length}…`,
      "info"
    );
    launchRecoveredBatch(nextState);
    return true;
  }

  function reconcileBatchRecovery(status = {}) {
    const state = readBatchRecovery();
    if (!state || !workspaceReady) return;
    const active = !!(status.running || status.stalled || status.paused);
    const sameSearch = !!status.searchId && status.searchId === state.activeSearchId;
    if (sameSearch && active) {
      const phase = status.paused ? "paused" : "running";
      if (state.phase !== phase) writeBatchRecovery({ ...state, phase });
      return;
    }
    if (active) return;
    if (state.phase === "between" || state.phase === "starting") {
      launchRecoveredBatch(state);
    }
  }

  function resetSearchRecovery({ abandon = false } = {}) {
    multiKeywordAbort = true;
    pendingBatchResume = null;
    batchRecoveryStarting = false;
    clearBatchRecovery();
    activeSearchEndWaiter?.cancel?.({ type: "cancelled", payload: { partialCode: "ABANDON" } });
    activeSearchEndWaiter = null;
    clearSearchWatchdog();
    setSearchPaused(false);
    setSearchRunning(false);
    if (abandon) abandonExtensionSearch();
    resetFormLock();
  }

  // ——— Search submission ———

  function parseSearchKeywords(raw) {
    if (!raw) return [];
    return raw.split(",").map((k) => k.trim()).filter(Boolean);
  }

  async function handleSubmit(e) {
    e.preventDefault();

    const recoveredBatch = pendingBatchResume;
    pendingBatchResume = null;
    if (isFormLocked() && !recoveredBatch) {
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

    const keywords = recoveredBatch?.keywords || parseSearchKeywords(els.keyword.value);
    if (!keywords.length) {
      showSearchStatus("Nhập từ khóa tìm kiếm (có thể nhiều từ khóa, cách nhau bằng dấu phẩy).", "error");
      return;
    }

    submitting = true;
    setFormBusy(true, "search");

    try {
      let areas;
      if (recoveredBatch?.areas?.length) {
        areas = [];
        for (let i = 0; i < recoveredBatch.areas.length; i++) {
          const hydrated = await hydrateAreaBoundary(recoveredBatch.areas[i]);
          if (!hydrated) {
            showSearchStatus(`Không tải được ranh giới khu vực ${i + 1}. Hãy chọn lại.`, "error");
            return;
          }
          areas.push({ ...hydrated, areaIndex: i });
        }
      } else {
        const validated = validateAreasOrError();
        if (validated.error) {
          showSearchStatus(validated.error, "error");
          return;
        }
        areas = validated.areas;
      }

      const plannedContexts = buildPlannedContexts(areas, keywords);
      lastBatchAreasForMap = areas;
      saveLastSearch({
        keyword: keywords.join(", "),
        areas: areas.map(slimAreaForRecovery)
      });

      multiKeywordBatch = true;
      multiKeywordAbort = false;
      setSearchRunning(true);
      armSearchWatchdog();
      lastKnownMergedCount = 0;
      updateFormControls();

      const sharedParams = recoveredBatch
        ? {
            ...recoveredBatch.baseParams,
            webUrl: window.location.origin,
            authToken: token,
            keywords,
            keywordTotal: keywords.length,
            areaTotal: areas.length,
            plannedContexts
          }
        : {
            webUrl: window.location.origin,
            authToken: token,
            quickScan: !!els.quickScan?.checked,
            mapsAutoFocus: isMapsAutoFocusChecked(),
            mapsAutoReopen: isMapsAutoReopenChecked(),
            keywords,
            keywordTotal: keywords.length,
            areaTotal: areas.length,
            plannedContexts
          };

      const batchId = recoveredBatch?.batchId || Date.now();
      const jobs = totalJobs(areas.length, keywords.length);
      const startJob = recoveredBatch?.nextJobIndex || 0;
      let stoppedEarly = false;
      let keepRecoveryOnError = false;

      writeBatchRecovery({
        batchId,
        keywords,
        areas,
        baseParams: sharedParams,
        currentJobIndex: Math.max(0, startJob),
        nextJobIndex: Math.max(0, startJob),
        activeSearchId: "",
        phase: "between"
      });

      showSearchStatus(
        jobs > 1
          ? `Sẽ chạy ${areas.length} khu vực × ${keywords.length} từ khóa (${jobs} lượt) tuần tự`
          : "Đang kiểm tra tiện ích sẵn sàng…",
        "info"
      );

      const ready0 = await waitForExtensionIdle(45000);
      if (!ready0) {
        throw new Error("Tiện ích hoặc tab Google Maps vẫn đang bận. Đóng tab Maps thừa rồi thử lại.");
      }

      for (let job = startJob; job < jobs; job++) {
        if (multiKeywordAbort) {
          stoppedEarly = true;
          break;
        }

        const { areaIndex, keywordIndex } = jobCoords(job, keywords.length);
        const area = areas[areaIndex];
        const keyword = keywords[keywordIndex];
        const contextKey = `${area.wardCode}::${keyword}`;
        const searchParams = {
          ...sharedParams,
          ...area,
          areaIndex,
          areaTotal: areas.length,
          areaLabel: area.areaLabel || area.wardFullName || area.wardName,
          keyword,
          keywordIndex,
          keywordTotal: keywords.length,
          searchAreaKey: contextKey,
          plannedContexts,
          searchId: `search_${batchId}_a${areaIndex}_k${keywordIndex}`
        };

        writeBatchRecovery({
          batchId,
          keywords,
          areas,
          baseParams: sharedParams,
          currentJobIndex: job,
          nextJobIndex: job,
          activeSearchId: searchParams.searchId,
          phase: "starting"
        });

        if (job > 0) {
          showSearchStatus(
            `Sang lượt ${job + 1}/${jobs}: ${searchParams.areaLabel} · "${keyword}"…`,
            "info"
          );
          const idle = await waitForExtensionIdle(90000);
          if (!idle) {
            showSearchStatus(
              "Tab Google Maps / tiện ích chưa rảnh để chạy lượt tiếp. Recovery đã giữ — thử lại sau.",
              "error"
            );
            stoppedEarly = true;
            keepRecoveryOnError = true;
            break;
          }
          try {
            await window.TimDiemBanSearch?.requestSearchSync?.(
              "Đồng bộ kết quả trước khi sang lượt tiếp theo"
            );
          } catch {}
          await new Promise((r) => setTimeout(r, 900));
        }

        if (multiKeywordAbort) {
          stoppedEarly = true;
          break;
        }

        window.dispatchEvent(new CustomEvent("timdiemban:search-starting", { detail: searchParams }));
        // Giữ đủ mọi khu vực trên map; nổi khu vực đang chạy
        redrawAllAreaMaps({
          areas,
          activeAreaIndex: areaIndex,
          fit: true,
          force: true
        });

        const stepLabel =
          jobs > 1
            ? `KV ${areaIndex + 1}/${areas.length} · TK ${keywordIndex + 1}/${keywords.length}: "${keyword}"`
            : `Đang tìm "${keyword}"`;
        showSearchStatus(`${stepLabel} — ${searchParams.areaLabel}`, "info");
        updateSearchProgress(Math.round((job / jobs) * 100), stepLabel);
        setSearchRunning(true);
        armSearchWatchdog();

        try {
          const endWaiter = waitForSearchEnd(searchParams.searchId);
          activeSearchEndWaiter = endWaiter;
          try {
            await startSearchExclusive(searchParams);
            writeBatchRecovery({
              batchId,
              keywords,
              areas,
              baseParams: sharedParams,
              currentJobIndex: job,
              nextJobIndex: job,
              activeSearchId: searchParams.searchId,
              phase: "running"
            });
            endWaiter.markStarted();
          } catch (err) {
            endWaiter.cancel();
            throw err;
          }

          const end = await endWaiter.promise;
          if (activeSearchEndWaiter === endWaiter) activeSearchEndWaiter = null;
          clearSearchWatchdog();
          setSearchRunning(false);

          if (isUserCancelEnd(end)) {
            stoppedEarly = true;
            showSearchStatus(end.payload?.partialReason || "Đã dừng — kết quả đã lưu.", "info");
            await waitForExtensionIdle(20000).catch(() => false);
            break;
          }

          if (end.type === "error" || end.type === "tab_closed" || end.type === "timeout") {
            stoppedEarly = true;
            keepRecoveryOnError = true;
            showSearchStatus(
              end.payload?.error || `Dừng tại ${searchParams.areaLabel} / "${keyword}"`,
              "error"
            );
            await waitForExtensionIdle(20000).catch(() => false);
            break;
          }

          if (jobs > 1 && job < jobs - 1) {
            showSearchStatus(
              `Xong ${searchParams.areaLabel} · "${keyword}" (${job + 1}/${jobs}) — chuẩn bị lượt tiếp…`,
              "info"
            );
          }

          try {
            await window.TimDiemBanSearch?.requestSearchSync?.(
              `Đồng bộ kết quả "${keyword}" @ ${searchParams.areaLabel}`
            );
          } catch {}
          await waitForExtensionIdle(30000).catch(() => false);
          await new Promise((r) => setTimeout(r, 500));

          writeBatchRecovery({
            batchId,
            keywords,
            areas,
            baseParams: sharedParams,
            currentJobIndex: job,
            nextJobIndex: job + 1,
            activeSearchId: "",
            phase: "between"
          });
        } catch (err) {
          activeSearchEndWaiter = null;
          showSearchStatus(err.message, "error");
          stoppedEarly = true;
          keepRecoveryOnError = true;
          await waitForExtensionIdle(20000).catch(() => false);
          break;
        }
      }

      if (!stoppedEarly) {
        clearBatchRecovery();
        updateSearchProgress(100, "Hoàn tất");
        showSearchStatus(
          jobs > 1
            ? `Hoàn tất ${areas.length} khu vực × ${keywords.length} từ khóa — xem các tab kết quả.`
            : "Hoàn tất tìm kiếm.",
          "success"
        );
      } else if (multiKeywordAbort && !keepRecoveryOnError) {
        clearBatchRecovery();
      }
    } catch (err) {
      showSearchStatus(err.message || "Lỗi khi bắt đầu tìm kiếm.", "error");
    } finally {
      multiKeywordBatch = false;
      multiKeywordAbort = false;
      // Giữ lastBatchAreasForMap để map vẫn hiện đủ KV sau batch
      submitting = false;
      setFormBusy(false);
      setSearchPaused(false);
      setSearchRunning(false);
      clearSearchWatchdog();
      updateFormControls();
      activeSearchEndWaiter = null;
    }
  }

  function pingExtensionBridge() {
    postToExt("PING_EXT");
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== "timdiemban-ext") return;

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

    if (event.data.type === "start") {
      const startedParams = event.data.payload?.searchParams || {};
      const cells = startedParams.gridCells;
      const openingText = startedParams.quickScan
        ? "Đang mở 2 tab Google Maps — tab 1 lấy URL, tab 2 đọc chi tiết..."
        : "Đang mở Google Maps — lấy danh sách rồi đọc chi tiết trên cùng 1 tab...";
      updateSearchProgress(2, cells ? `Lưới ${cells} ô — ${openingText}` : openingText);
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
      if (maybeStatus.mapsTabHiddenDuringList === false) hideMapsListInterruptionModal();
      else if (shouldShowMapsIssueModal(maybeStatus)) showMapsFocusModal(maybeStatus);
      return;
    }

    if (event.data.type === "search_status") {
      const status = event.data.payload || {};
      latestSearchStatus = status;
      applySearchStatus(status);
      reconcileBatchRecovery(status);
      return;
    }

    if (event.data.type === "cancel_ack") {
      return;
    }

    if (event.data.type === "error") {
      // Trong batch: giữ recovery để có thể tiếp / thử lại; chỉ clear khi không batch
      if (!multiKeywordBatch) clearBatchRecovery();
      clearSearchWatchdog();
      setSearchPaused(false);
      setSearchRunning(false);
      showSearchStatus(event.data.payload?.error || "Lỗi tìm kiếm", "error");
      return;
    }

    if (event.data.type === "complete" || event.data.type === "tab_closed") {
      clearSearchWatchdog();
      setSearchPaused(false);
      setSearchRunning(false);
      if (multiKeywordBatch) return;
      if (event.data.type === "complete") {
        if (
          continueRecoveredBatchAfterTerminal({
            ...(event.data.payload || {}),
            type: "complete"
          })
        ) return;
        const partial = event.data.payload?.partial;
        updateSearchProgress(100, partial ? "Dừng sớm" : "Hoàn tất");
        showSearchStatus(
          partial
            ? event.data.payload?.partialReason || "Đã dừng — kết quả đã lưu. Xem bảng kết quả."
            : "Hoàn tất — xem bảng kết quả bên dưới.",
          partial ? "info" : "success"
        );
      } else {
        clearBatchRecovery();
        showSearchStatus(
          event.data.payload?.error || "Tìm kiếm bị gián đoạn — mở lại trang và thử lại.",
          "error"
        );
      }
    }
  });

  window.addEventListener("timdiemban:search-finished", (event) => {
    setSearchPaused(false);
    setSearchRunning(false);
    if (!multiKeywordBatch) continueRecoveredBatchAfterTerminal(event.detail || {});
  });

  window.addEventListener("timdiemban:workspace-ready", () => {
    workspaceReady = true;
    requestSearchStatus();
    if (latestSearchStatus) reconcileBatchRecovery(latestSearchStatus);
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

  if (els.quickScan) {
    els.quickScan.addEventListener("change", onSearchOptionChange);
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

  // ——— Form event listeners ———

  els.addSearchAreaBtn?.addEventListener("click", () => {
    createAreaCard();
  });

  els.form?.addEventListener("submit", handleSubmit);

  els.pauseSearchBtn?.addEventListener("click", async () => {
    if (!searchRunning || searchPaused) return;
    els.pauseSearchBtn.disabled = true;
    showSearchStatus("Đang lưu tiến độ để tạm dừng an toàn...", "info");
    try {
      const result = await requestPauseSearch("Người dùng tạm dừng quét");
      const status = result.status || {};
      if (result.status) applySearchStatus(result.status);
      else setSearchPaused(true);
      showSearchStatus(
        status.pauseReason || "Đã tạm dừng. Toàn bộ ô, URL và kết quả hiện tại đã được lưu.",
        "info"
      );
    } catch (err) {
      showSearchStatus(err.message, "error");
      requestSearchStatus();
    } finally {
      updateFormControls();
    }
  });

  els.resumeSearchBtn?.addEventListener("click", async () => {
    if (!searchPaused) return;
    els.resumeSearchBtn.disabled = true;
    showSearchStatus("Đang mở lại Google Maps và khôi phục đúng tiến độ...", "info");
    try {
      const result = await requestResumeSearch();
      const status = result.status || (await requestSearchStatusAsync(8000).catch(() => null));
      if (status) applySearchStatus(status);
      else {
        setSearchPaused(false);
        setSearchRunning(true);
      }
      touchSearchProgress();
      armSearchWatchdog();
      showSearchStatus("Đã tiếp tục quét từ khu vực và URL đang dở.", "success");
      requestSearchSync("Đồng bộ sau khi tiếp tục quét");
    } catch (err) {
      setSearchPaused(true);
      showSearchStatus(err.message, "error");
    } finally {
      updateFormControls();
    }
  });

  els.cancelSearchBtn?.addEventListener("click", async () => {
    if (!searchRunning && !searchPaused && !multiKeywordBatch) return;
    multiKeywordAbort = true;
    els.cancelSearchBtn.disabled = true;
    showSearchStatus("Đang dừng quét...", "info");
    try {
      if (searchRunning || searchPaused) {
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

  loadMapsAutoFocusPref();
  loadMapsAutoReopenPref();
  loadSearchOptionsOpen();
  updateSearchOptionsHint();
  resetFormLock();

  // Load province list, ensure ≥1 area card, then restore last search
  loadProvinces().then(() => {
    if (!areaCards.length) createAreaCard();
    loadLastSearch();
    if (!areaCards.length) createAreaCard();
  });

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
    requestSearchSync,
    clearBatchRecovery,
    resetSearchRecovery,
    redrawAllAreaMaps
  };
})();
