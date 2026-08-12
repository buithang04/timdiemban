/**
 * Bản đồ OpenStreetMap (Leaflet) — nhiều khu vực (ward/province polygon) + lưới ô quét + marker.
 */
(function () {
  const MARKER_IN = "#1e3a8a";
  const MARKER_OUT = "#dc2626";

  const AREA_PALETTE = [
    { stroke: "#2563eb", fill: "#3b82f6", grid: "#f59e0b", gridFill: "#fbbf24" },
    { stroke: "#059669", fill: "#10b981", grid: "#d97706", gridFill: "#f59e0b" },
    { stroke: "#7c3aed", fill: "#8b5cf6", grid: "#ea580c", gridFill: "#fb923c" },
    { stroke: "#db2777", fill: "#ec4899", grid: "#ca8a04", gridFill: "#eab308" },
    { stroke: "#0891b2", fill: "#06b6d4", grid: "#c2410c", gridFill: "#f97316" }
  ];

  let map = null;
  let layerAreas = null;
  let layerGrids = null;
  let layerMarkers = null;
  let gridRenderer = null;
  /** @type {Array<{wardCode:string, rings:any[]}>} */
  let areaRingSets = [];
  let markerByKey = new Map();
  let lastAreasSig = "";
  let resizeTimer = null;
  let fitToken = 0;
  let pendingGridDraw = null;

  function makeIcon(color) {
    return L.divIcon({
      className: "tdb-map-marker",
      html: `<span style="background:${color};width:12px;height:12px;border:2px solid #fff;border-radius:50%;display:block;box-shadow:0 1px 4px rgba(0,0,0,.35)"></span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
  }

  const iconIn = makeIcon(MARKER_IN);
  const iconOut = makeIcon(MARKER_OUT);

  function init() {
    const el = document.getElementById("map");
    if (!el || map) return;

    map = L.map(el, {
      zoomControl: false,
      scrollWheelZoom: true,
      fadeAnimation: false,
      zoomAnimation: true,
      markerZoomAnimation: false,
      preferCanvas: true
    }).setView([21.0285, 105.8542], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      updateWhenIdle: true,
      keepBuffer: 2
    }).addTo(map);

    gridRenderer = L.canvas({ padding: 0.4 });
    layerAreas = L.featureGroup().addTo(map);
    layerGrids = L.featureGroup().addTo(map);
    layerMarkers = L.layerGroup().addTo(map);

    setTimeout(() => map.invalidateSize({ animate: false }), 200);
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => map?.invalidateSize({ animate: false }), 200);
    });
  }

  function paletteFor(index) {
    return AREA_PALETTE[Math.abs(Number(index) || 0) % AREA_PALETTE.length];
  }

  function areasSignature(areas, opts = {}) {
    if (!Array.isArray(areas) || !areas.length) return "";
    const nums = opts.showCellNumbers === true ? "1" : "0";
    return (
      areas
        .map((a) => {
          const code = a.wardCode || a.provinceCode || a.boundary?.features?.[0]?.id || "";
          const level = a.level || "ward";
          const n = a.gridPoints?.length || 0;
          const side = Number(a.cellSizeKm || 0).toFixed(4);
          const labels = a.showLabels === true ? "1" : "0";
          return `${level}:${code}:${n}:${side}:L${labels}`;
        })
        .join("|") + `|N${nums}`
    );
  }

  function clearAreaLayers() {
    if (pendingGridDraw) {
      clearTimeout(pendingGridDraw);
      pendingGridDraw = null;
    }
    layerAreas?.clearLayers();
    layerGrids?.clearLayers();
    areaRingSets = [];
    lastAreasSig = "";
  }

  function boundsFromAreas(list) {
    try {
      const tmp = L.featureGroup();
      list.forEach((area) => {
        if (area?.boundary) L.geoJSON(area.boundary).addTo(tmp);
      });
      const b = tmp.getBounds();
      return b?.isValid?.() ? b : null;
    } catch {
      return null;
    }
  }

  /**
   * Vẽ nhiều khu vực + lưới ô quét.
   * opts.showCellNumbers: hiện số ô (chỉ khi đang tìm / province search)
   */
  function drawSearchAreas(areas, opts = {}) {
    if (!map) init();
    if (!map) return;

    const list = Array.isArray(areas) ? areas.filter((a) => a?.boundary?.features?.length) : [];
    const sig = areasSignature(list, opts);
    const force = opts.force === true;
    if (!force && sig && sig === lastAreasSig) {
      if (opts.fit !== false) fitToDrawnLayers(opts);
      return;
    }
    lastAreasSig = sig;

    // Hủy animation cũ — tránh dật khi chọn liên tục
    try {
      map.stop();
    } catch {}
    fitToken += 1;
    const token = fitToken;

    clearAreaLayers();
    lastAreasSig = sig;
    if (!list.length) return;

    const activeIdx =
      opts.activeAreaIndex != null && Number.isFinite(Number(opts.activeAreaIndex))
        ? Number(opts.activeAreaIndex)
        : null;
    const showCellNumbers = opts.showCellNumbers === true;

    // 1) Vẽ đường bao trước (nhẹ) — grid vẽ sau khi zoom xong
    list.forEach((area, idx) => {
      const colors = paletteFor(area.colorIndex != null ? area.colorIndex : idx);
      const wardName =
        area.wardName ||
        area.wardFullName ||
        area.provinceName ||
        area.wardCode ||
        area.provinceCode ||
        `Khu vực ${idx + 1}`;
      const isActive = area.active === true || (activeIdx != null && activeIdx === idx);
      const dimOthers = activeIdx != null;
      const isProvince = area.level === "province";

      const poly = L.geoJSON(area.boundary, {
        style: {
          color: colors.stroke,
          weight: isActive ? 3 : dimOthers ? 1.5 : isProvince ? 2.4 : 2.2,
          fillColor: colors.fill,
          fillOpacity: isProvince ? (isActive ? 0.1 : 0.07) : isActive ? 0.18 : dimOthers ? 0.07 : 0.12,
          dashArray: isProvince ? "7, 5" : isActive ? "" : "5, 4",
          opacity: isActive || !dimOthers ? 1 : 0.7,
          className: "tdb-area-poly",
          interactive: true
        },
        renderer: gridRenderer || undefined
      });
      poly.bindTooltip(
        dimOthers
          ? `${wardName}${isActive ? " · đang quét" : ""}`
          : isProvince
            ? `${wardName} · cả tỉnh/thành`
            : wardName,
        { sticky: true }
      );
      poly.addTo(layerAreas);

      if (typeof extractPolygonRings === "function") {
        const rings = extractPolygonRings(area.boundary);
        if (rings?.length) {
          areaRingSets.push({
            wardCode: String(area.wardCode || area.provinceCode || ""),
            rings
          });
        }
      }
    });

    const drawGridsNow = () => {
      if (token !== fitToken) return;
      layerGrids?.clearLayers();
      list.forEach((area, idx) => {
        if (area.showGrid === false) return;
        const colors = paletteFor(area.colorIndex != null ? area.colorIndex : idx);
        const wardName =
          area.wardName ||
          area.wardFullName ||
          area.provinceName ||
          area.wardCode ||
          area.provinceCode ||
          `Khu vực ${idx + 1}`;
        const isActive = area.active === true || (activeIdx != null && activeIdx === idx);
        const dimOthers = activeIdx != null;
        const isProvince = area.level === "province";
        const points = Array.isArray(area.gridPoints) ? area.gridPoints : [];
        const sideKm = Number(area.cellSizeKm) || 0.4;
        // Chỉ hiện số khi đang quét tỉnh (không xã) — preview tỉnh chỉ lưới không số
        const wantLabels = showCellNumbers && area.showLabels === true;
        drawGridCells(points, sideKm, colors, wardName, idx, {
          emphasize: isActive || !dimOthers,
          showLabels: wantLabels
        });
      });
    };

    if (opts.fit === false) {
      drawGridsNow();
      return;
    }

    const preBounds = boundsFromAreas(list) || (layerAreas.getLayers().length ? layerAreas.getBounds() : null);
    if (!preBounds?.isValid?.()) {
      drawGridsNow();
      return;
    }

    const padding = opts.padding || [40, 40];
    const maxZoom = Number(opts.maxZoom) > 0 ? Number(opts.maxZoom) : 14;
    const animate = opts.animate !== false;
    // fitBounds animate nhẹ hơn flyToBounds — ít dật khi nhiều ô
    const duration = Math.max(0.3, Math.min(Number(opts.duration) || 0.5, 0.75));

    let gridsDrawn = false;
    const finish = () => {
      if (gridsDrawn || token !== fitToken) return;
      gridsDrawn = true;
      map.off("moveend", onMoveEnd);
      // Vẽ lưới sau 1 frame để zoom kịp settle
      requestAnimationFrame(() => {
        if (token !== fitToken) return;
        drawGridsNow();
      });
    };
    const onMoveEnd = () => finish();

    if (animate) {
      map.once("moveend", onMoveEnd);
      try {
        map.fitBounds(preBounds, {
          padding,
          maxZoom,
          animate: true,
          duration,
          easeLinearity: 0.35
        });
      } catch {
        map.off("moveend", onMoveEnd);
        map.fitBounds(preBounds, { padding, maxZoom, animate: false });
        finish();
        return;
      }
      // Fallback nếu không có moveend (đã gần đúng bounds)
      pendingGridDraw = setTimeout(() => {
        pendingGridDraw = null;
        finish();
      }, Math.round(duration * 1000) + 180);
    } else {
      map.fitBounds(preBounds, { padding, maxZoom, animate: false });
      finish();
    }
  }

  function drawGridCells(gridPoints, sideKm, colors, wardName, areaIdx, styleOpts = {}) {
    if (!layerGrids || !gridPoints?.length || !sideKm) return;
    if (typeof squareBounds !== "function") return;
    const emphasize = styleOpts.emphasize !== false;
    const showLabels = styleOpts.showLabels === true;
    const renderer = gridRenderer || undefined;

    // Chunk nhẹ nếu quá nhiều ô — tránh block UI
    const chunk = 40;
    let i = 0;

    const addOne = (p, idx) => {
      const bounds = squareBounds(p.lat, p.lng, sideKm);
      const isCenter = p.cellId === "center";
      const label = p.cellLabel || `Ô ${p.searchOrder || idx + 1}`;
      const tip = `${wardName} · ${label}`;

      L.rectangle(bounds, {
        color: isCenter ? colors.stroke : colors.grid,
        weight: emphasize ? (isCenter ? 2.2 : 1.2) : 1,
        fillColor: isCenter ? colors.fill : colors.gridFill,
        fillOpacity: emphasize ? (isCenter ? 0.16 : 0.1) : 0.05,
        dashArray: emphasize ? "" : "4, 4",
        opacity: emphasize ? 0.95 : 0.5,
        renderer,
        interactive: !showLabels
      })
        .bindTooltip(tip, { sticky: true, direction: "center" })
        .addTo(layerGrids);

      if (!showLabels) return;

      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "tdb-grid-label",
          html: `<span style="background:${isCenter ? colors.stroke : colors.grid}">${p.searchOrder || idx + 1}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        }),
        interactive: false
      }).addTo(layerGrids);
    };

    const pump = () => {
      const end = Math.min(i + chunk, gridPoints.length);
      for (; i < end; i++) addOne(gridPoints[i], i);
      if (i < gridPoints.length) {
        requestAnimationFrame(pump);
      }
    };
    pump();
  }

  function fitToDrawnLayers(opts = {}) {
    if (!map) return;
    try {
      const parts = [];
      if (layerAreas?.getLayers()?.length) parts.push(layerAreas.getBounds());
      if (layerGrids?.getLayers()?.length) parts.push(layerGrids.getBounds());
      if (!parts.length) return;
      let bounds = parts[0];
      for (let i = 1; i < parts.length; i++) bounds = bounds.extend(parts[i]);
      if (!bounds?.isValid?.()) return;

      try {
        map.stop();
      } catch {}
      const padding = opts.padding || [40, 40];
      const maxZoom = Number(opts.maxZoom) > 0 ? Number(opts.maxZoom) : 14;
      const animate = opts.animate !== false;
      const duration = Math.max(0.3, Math.min(Number(opts.duration) || 0.5, 0.75));
      map.fitBounds(bounds, { padding, maxZoom, animate, duration, easeLinearity: 0.35 });
    } catch {}
  }

  /** Tương thích cũ: 1 ward. Tự sinh lưới nếu có generateGridFromPolygon. */
  function drawWardBoundary(geojson, opts = {}) {
    if (!geojson?.features?.length) return;
    let gridPoints = Array.isArray(opts.gridPoints) ? opts.gridPoints : null;
    let cellSizeKm = Number(opts.cellSizeKm) || 0;
    if ((!gridPoints || !gridPoints.length) && typeof generateGridFromPolygon === "function") {
      try {
        const grid = generateGridFromPolygon(
          geojson,
          Number(opts.viewportM) > 0 ? Number(opts.viewportM) : null,
          { level: opts.level, coverFull: opts.coverFull === true }
        );
        gridPoints = grid.points || [];
        cellSizeKm = grid.cellSizeKm || 0.4;
      } catch {
        gridPoints = [];
      }
    }
    drawSearchAreas(
      [
        {
          wardCode: opts.wardCode || geojson.features[0]?.id || "",
          wardName: opts.wardName || opts.provinceName || "",
          wardFullName: opts.wardFullName || "",
          provinceCode: opts.provinceCode || "",
          provinceName: opts.provinceName || "",
          boundary: geojson,
          gridPoints: gridPoints || [],
          cellSizeKm: cellSizeKm || 0.4,
          colorIndex: Number(opts.colorIndex) || Number(opts.areaIndex) || 0,
          level: opts.level || "ward",
          showGrid: opts.showGrid !== false,
          showLabels: opts.showLabels === true
        }
      ],
      {
        fit: opts.fit !== false,
        force: opts.force === true,
        animate: opts.animate !== false,
        duration: opts.duration,
        maxZoom: opts.maxZoom,
        showCellNumbers: opts.showCellNumbers === true || opts.showLabels === true
      }
    );
  }

  function clearWardBoundary() {
    clearAreaLayers();
  }

  function drawGrid(gridPoints, sideKm) {
    if (!map) init();
    if (!layerGrids) return;
    layerGrids.clearLayers();
    drawGridCells(gridPoints, sideKm, paletteFor(0), "Lưới", 0, { emphasize: true, showLabels: false });
    if (gridPoints?.length) fitToDrawnLayers({ animate: false });
  }

  function isInsideWard(lat, lng) {
    if (areaRingSets.length && typeof pointInPolygon === "function") {
      return areaRingSets.some((set) => pointInPolygon(lat, lng, set.rings));
    }
    if (!layerAreas?.getLayers()?.length) return true;
    try {
      return layerAreas.getBounds().contains(L.latLng(lat, lng));
    } catch {
      return true;
    }
  }

  function rowKey(row) {
    return (
      row.googlePlaceId ||
      `${row.name || ""}|${row.lat || ""}|${row.lng || ""}|${row.phone || ""}`
    ).toLowerCase();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function upsertMarker(row) {
    if (!map || !layerMarkers) return;
    const lat = row.lat != null ? Number(row.lat) : NaN;
    const lng = row.lng != null ? Number(row.lng) : NaN;
    if (isNaN(lat) || isNaN(lng)) return;

    const key = rowKey(row);
    const inside = isInsideWard(lat, lng);
    const icon = inside ? iconIn : iconOut;
    const label = inside ? "Trong vùng" : "Ngoài vùng";
    const popup = `<strong>${escapeHtml(row.name || "")}</strong><br>${escapeHtml(row.address || "")}<br>${escapeHtml(row.phone || "")}<br><em>${label}</em>`;

    let marker = markerByKey.get(key);
    if (marker) {
      const cur = marker.getLatLng();
      if (Math.abs(cur.lat - lat) > 1e-7 || Math.abs(cur.lng - lng) > 1e-7) {
        marker.setLatLng([lat, lng]);
      }
      if (marker.options.icon !== icon) marker.setIcon(icon);
      marker.setPopupContent(popup);
    } else {
      marker = L.marker([lat, lng], { icon }).bindPopup(popup);
      marker.addTo(layerMarkers);
      markerByKey.set(key, marker);
    }
  }

  function refreshMarkers(rows) {
    if (!map) return;
    const keys = new Set();
    for (const row of rows || []) {
      upsertMarker(row);
      keys.add(rowKey(row));
    }
    for (const [key, marker] of markerByKey) {
      if (!keys.has(key)) {
        layerMarkers.removeLayer(marker);
        markerByKey.delete(key);
      }
    }
  }

  function clearMarkers() {
    layerMarkers?.clearLayers();
    markerByKey.clear();
  }

  function clearAll() {
    clearAreaLayers();
    clearMarkers();
  }

  function countInOut(rows) {
    let inside = 0;
    let outside = 0;
    for (const row of rows || []) {
      const lat = row.lat != null ? Number(row.lat) : NaN;
      const lng = row.lng != null ? Number(row.lng) : NaN;
      if (isNaN(lat) || isNaN(lng)) continue;
      if (isInsideWard(lat, lng)) inside++;
      else outside++;
    }
    return { inside, outside };
  }

  function focusPoint(lat, lng) {
    if (!map) init();
    const la = Number(lat);
    const lo = Number(lng);
    if (isNaN(la) || isNaN(lo)) return;
    map.setView([la, lo], Math.max(map.getZoom(), 14), { animate: true });
  }

  function locateUser() {
    if (!map) init();
    map?.locate({ setView: true, maxZoom: 15 });
  }

  function zoomIn() {
    if (!map) init();
    map?.zoomIn();
  }

  function zoomOut() {
    if (!map) init();
    map?.zoomOut();
  }

  window.TimDiemBanMap = {
    init,
    drawSearchAreas,
    drawWardBoundary,
    clearWardBoundary,
    drawGrid,
    upsertMarker,
    refreshMarkers,
    clearMarkers,
    clearAll,
    countInOut,
    focusPoint,
    locateUser,
    zoomIn,
    zoomOut,
    fitToDrawnLayers,
    invalidateSize() {
      if (map) map.invalidateSize({ animate: false });
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    init();
  });
})();
