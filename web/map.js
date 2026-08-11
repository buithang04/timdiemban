/**
 * Bản đồ OpenStreetMap (Leaflet) — nhiều khu vực (ward polygon) + lưới ô quét + marker.
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
  /** @type {Array<{wardCode:string, rings:any[]}>} */
  let areaRingSets = [];
  let markerByKey = new Map();
  let lastAreasSig = "";
  let resizeTimer = null;

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
      markerZoomAnimation: false
    }).setView([21.0285, 105.8542], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

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

  function areasSignature(areas) {
    if (!Array.isArray(areas) || !areas.length) return "";
    return areas
      .map((a) => {
        const code = a.wardCode || a.boundary?.features?.[0]?.id || "";
        const n = a.gridPoints?.length || 0;
        const side = Number(a.cellSizeKm || 0).toFixed(4);
        return `${code}:${n}:${side}`;
      })
      .join("|");
  }

  function clearAreaLayers() {
    layerAreas?.clearLayers();
    layerGrids?.clearLayers();
    areaRingSets = [];
    lastAreasSig = "";
  }

  /**
   * Vẽ nhiều khu vực + lưới ô quét.
   * areas: [{ wardCode, wardName, boundary, gridPoints, cellSizeKm, colorIndex }]
   */
  function drawSearchAreas(areas, opts = {}) {
    if (!map) init();
    if (!map) return;

    const list = Array.isArray(areas) ? areas.filter((a) => a?.boundary?.features?.length) : [];
    const sig = areasSignature(list);
    const force = opts.force === true;
    if (!force && sig && sig === lastAreasSig) {
      if (opts.fit !== false) fitToDrawnLayers();
      return;
    }
    lastAreasSig = sig;

    clearAreaLayers();
    if (!list.length) return;

    list.forEach((area, idx) => {
      const colors = paletteFor(area.colorIndex != null ? area.colorIndex : idx);
      const wardName = area.wardName || area.wardFullName || area.wardCode || `Khu vực ${idx + 1}`;
      const activeIdx =
        opts.activeAreaIndex != null && Number.isFinite(Number(opts.activeAreaIndex))
          ? Number(opts.activeAreaIndex)
          : null;
      const isActive =
        area.active === true || (activeIdx != null && activeIdx === idx);
      const dimOthers = activeIdx != null;

      const poly = L.geoJSON(area.boundary, {
        style: {
          color: colors.stroke,
          weight: isActive ? 3.2 : dimOthers ? 1.6 : 2.5,
          fillColor: colors.fill,
          fillOpacity: isActive ? 0.22 : dimOthers ? 0.08 : 0.14,
          dashArray: isActive ? "" : "6, 4",
          opacity: isActive || !dimOthers ? 1 : 0.75
        }
      });
      poly.bindTooltip(
        dimOthers ? `${wardName}${isActive ? " · đang quét" : ""}` : wardName,
        { sticky: true }
      );
      poly.addTo(layerAreas);

      if (typeof extractPolygonRings === "function") {
        const rings = extractPolygonRings(area.boundary);
        if (rings?.length) {
          areaRingSets.push({
            wardCode: String(area.wardCode || ""),
            rings
          });
        }
      }

      const points = Array.isArray(area.gridPoints) ? area.gridPoints : [];
      const sideKm = Number(area.cellSizeKm) || 0.4;
      // Hiện lưới mọi khu vực; khu vực đang chạy đậm hơn
      drawGridCells(points, sideKm, colors, wardName, idx, {
        emphasize: isActive || !dimOthers
      });
    });

    if (opts.fit !== false) fitToDrawnLayers();
  }

  function drawGridCells(gridPoints, sideKm, colors, wardName, areaIdx, styleOpts = {}) {
    if (!layerGrids || !gridPoints?.length || !sideKm) return;
    if (typeof squareBounds !== "function") return;
    const emphasize = styleOpts.emphasize !== false;

    gridPoints.forEach((p, i) => {
      const bounds = squareBounds(p.lat, p.lng, sideKm);
      const isCenter = p.cellId === "center";
      const label = p.cellLabel || `Ô ${p.searchOrder || i + 1}`;
      const tip = `${wardName} · ${label}`;

      L.rectangle(bounds, {
        color: isCenter ? colors.stroke : colors.grid,
        weight: emphasize ? (isCenter ? 2.5 : 1.5) : 1,
        fillColor: isCenter ? colors.fill : colors.gridFill,
        fillOpacity: emphasize ? (isCenter ? 0.18 : 0.12) : 0.05,
        dashArray: emphasize ? "" : "4, 4",
        opacity: emphasize ? 1 : 0.55
      })
        .bindTooltip(tip, { sticky: true, direction: "center" })
        .addTo(layerGrids);

      if (!emphasize) return;

      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "tdb-grid-label",
          html: `<span style="background:${isCenter ? colors.stroke : colors.grid}">${p.searchOrder || i + 1}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        }),
        interactive: false
      }).addTo(layerGrids);
    });
  }

  function fitToDrawnLayers() {
    if (!map) return;
    try {
      const parts = [];
      if (layerAreas?.getLayers()?.length) parts.push(layerAreas.getBounds());
      if (layerGrids?.getLayers()?.length) parts.push(layerGrids.getBounds());
      if (!parts.length) return;
      let bounds = parts[0];
      for (let i = 1; i < parts.length; i++) bounds = bounds.extend(parts[i]);
      if (bounds?.isValid?.()) {
        map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15, animate: false });
      }
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
          Number(opts.viewportM) > 0 ? Number(opts.viewportM) : null
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
          boundary: geojson,
          gridPoints: gridPoints || [],
          cellSizeKm: cellSizeKm || 0.4,
          colorIndex: Number(opts.colorIndex) || Number(opts.areaIndex) || 0
        }
      ],
      { fit: opts.fit !== false, force: opts.force === true }
    );
  }

  function clearWardBoundary() {
    clearAreaLayers();
  }

  function drawGrid(gridPoints, sideKm) {
    // Legacy single-grid API — append onto current palette[0]
    if (!map) init();
    if (!layerGrids) return;
    layerGrids.clearLayers();
    drawGridCells(gridPoints, sideKm, paletteFor(0), "Lưới", 0);
    if (gridPoints?.length) fitToDrawnLayers();
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
    for (const [k, m] of markerByKey) {
      if (!keys.has(k)) {
        layerMarkers.removeLayer(m);
        markerByKey.delete(k);
      }
    }
  }

  function clearMarkers() {
    layerMarkers?.clearLayers();
    markerByKey.clear();
  }

  function clearAll() {
    if (!map) return;
    clearWardBoundary();
    clearMarkers();
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
  }

  function updateStats(inCount, outCount) {
    const elIn = document.getElementById("mapStatIn");
    const elOut = document.getElementById("mapStatOut");
    if (elIn) elIn.textContent = String(inCount);
    if (elOut) elOut.textContent = String(outCount);
  }

  function countInOut(rows) {
    let inC = 0;
    let outC = 0;
    for (const row of rows || []) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (isInsideWard(lat, lng)) inC++;
      else outC++;
    }
    updateStats(inC, outC);
    return { inC, outC };
  }

  function focusPoint(lat, lng) {
    if (!map) init();
    if (!map || lat == null || lng == null) return;
    const la = Number(lat);
    const lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    const cur = map.getCenter();
    if (Math.abs(cur.lat - la) < 1e-5 && Math.abs(cur.lng - lo) < 1e-5) return;
    map.setView([la, lo], Math.max(map.getZoom(), 14), { animate: false });
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
