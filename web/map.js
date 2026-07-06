/**
 * Bản đồ OpenStreetMap (Leaflet) — vòng tròn bán kính, lưới ô, marker trong/ngoài vùng.
 */
(function () {
  const MARKER_IN = "#1e3a8a";
  const MARKER_OUT = "#dc2626";
  const GRID_COLOR = "#f59e0b";

  let map = null;
  let layerCircle = null;
  let layerCenter = null;
  let layerGrids = null;
  let layerMarkers = null;
  let searchCenter = null;
  let searchRadiusKm = 0;
  let markerByKey = new Map();

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
  const iconCenter = L.divIcon({
    className: "tdb-map-marker-center",
    html: `<span style="background:#2563eb;width:14px;height:14px;border:3px solid #fff;border-radius:50%;display:block;box-shadow:0 2px 6px rgba(0,0,0,.4)"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  function init() {
    const el = document.getElementById("map");
    if (!el || map) return;

    map = L.map(el, { zoomControl: false, scrollWheelZoom: true }).setView([21.0285, 105.8542], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    layerGrids = L.featureGroup().addTo(map);
    layerMarkers = L.layerGroup().addTo(map);

    // Click trên bản đồ → chọn tâm tìm kiếm
    map.on("click", (e) => {
      window.dispatchEvent(
        new CustomEvent("timdiemban:map-pick-center", {
          detail: { lat: e.latlng.lat, lng: e.latlng.lng }
        })
      );
    });

    setTimeout(() => map.invalidateSize(), 200);
    window.addEventListener("resize", () => map?.invalidateSize());
  }

  function isInsideRadius(lat, lng) {
    if (!searchCenter || !searchRadiusKm) return true;
    return haversineKm(searchCenter.lat, searchCenter.lng, lat, lng) <= searchRadiusKm + 0.05;
  }

  function drawGrid(gridPoints, sideKm) {
    if (!layerGrids) return;
    layerGrids.clearLayers();
    if (!gridPoints?.length || !sideKm) return;

    gridPoints.forEach((p, idx) => {
      const bounds = squareBounds(p.lat, p.lng, sideKm);
      const isCenter = p.cellId === "center";
      L.rectangle(bounds, {
        color: isCenter ? "#2563eb" : "#f59e0b",
        weight: isCenter ? 3 : 2,
        fillColor: isCenter ? "#3b82f6" : "#fbbf24",
        fillOpacity: isCenter ? 0.16 : 0.12,
        dashArray: ""
      })
        .bindTooltip(p.cellLabel || `Ô ${p.searchOrder || idx + 1}`, { sticky: true, direction: "center" })
        .addTo(layerGrids);

      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "tdb-grid-label",
          html: `<span>${p.searchOrder || idx + 1}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        })
      }).addTo(layerGrids);
    });
  }

  function setSearchArea(center, radiusKm, options = {}) {
    if (!map) init();
    if (!map || !center?.lat || !center?.lng) return;

    searchCenter = { lat: Number(center.lat), lng: Number(center.lng) };
    searchRadiusKm = Number(radiusKm) || 0;

    if (layerCircle) {
      map.removeLayer(layerCircle);
      layerCircle = null;
    }
    if (layerCenter) {
      map.removeLayer(layerCenter);
      layerCenter = null;
    }

    layerCircle = L.circle([searchCenter.lat, searchCenter.lng], {
      radius: searchRadiusKm * 1000,
      color: "#2563eb",
      weight: 2,
      fillColor: "#3b82f6",
      fillOpacity: 0.12
    }).addTo(map);

    layerCenter = L.marker([searchCenter.lat, searchCenter.lng], { icon: iconCenter })
      .bindTooltip("Tâm tìm kiếm", { permanent: false })
      .addTo(map);

    let gridPoints = options.gridPoints;
    let sideKm = options.cellSizeKm;

    if (!gridPoints?.length && searchRadiusKm > 0) {
      const grid = generateSearchGrid(searchCenter.lat, searchCenter.lng, searchRadiusKm);
      gridPoints = grid.points;
      sideKm = grid.cellSizeKm;
    }

    drawGrid(gridPoints, sideKm);

    const bounds = layerCircle.getBounds();
    if (layerGrids?.getLayers().length) {
      const gridBounds = layerGrids.getBounds();
      map.fitBounds(bounds.extend(gridBounds), { padding: [24, 24], maxZoom: 15 });
    } else {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
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
    const inside = isInsideRadius(lat, lng);
    const icon = inside ? iconIn : iconOut;
    const label = inside ? "Trong vùng" : "Ngoài vùng";

    const popup = `<strong>${escapeHtml(row.name || "")}</strong><br>${escapeHtml(row.address || "")}<br>${escapeHtml(row.phone || "")}<br><em>${label}</em>`;

    let marker = markerByKey.get(key);
    if (marker) {
      marker.setLatLng([lat, lng]);
      marker.setIcon(icon);
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
    layerGrids?.clearLayers();
    clearMarkers();
    if (layerCircle) {
      map.removeLayer(layerCircle);
      layerCircle = null;
    }
    if (layerCenter) {
      map.removeLayer(layerCenter);
      layerCenter = null;
    }
    searchCenter = null;
    searchRadiusKm = 0;
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
      if (isInsideRadius(lat, lng)) inC++;
      else outC++;
    }
    updateStats(inC, outC);
    return { inC, outC };
  }

  function focusPoint(lat, lng) {
    if (!map) init();
    if (!map || lat == null || lng == null) return;
    map.setView([Number(lat), Number(lng)], Math.max(map.getZoom(), 16));
  }

  function zoomIn() {
    if (!map) init();
    map?.zoomIn();
  }

  function zoomOut() {
    if (!map) init();
    map?.zoomOut();
  }

  function locateUser() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        if (!map) init();
        map?.setView([lat, lng], 15);
        window.dispatchEvent(
          new CustomEvent("timdiemban:map-pick-center", { detail: { lat, lng } })
        );
      },
      () => {}
    );
  }

  window.TimDiemBanMap = {
    init,
    setSearchArea,
    upsertMarker,
    refreshMarkers,
    clearMarkers,
    clearAll,
    countInOut,
    isInsideRadius,
    focusPoint,
    zoomIn,
    zoomOut,
    locateUser,
    invalidateSize() {
      if (map) map.invalidateSize();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    init();
  });
})();
