/**
 * Bản đồ OpenStreetMap (Leaflet) — vòng tròn bán kính, lưới ô, marker trong/ngoài vùng.
 * Ổn định tầm nhìn: không fitBounds / không vẽ lại tâm+lưới khi không đổi.
 */
(function () {
  const MARKER_IN = "#1e3a8a";
  const MARKER_OUT = "#dc2626";

  let map = null;
  let layerCircle = null;
  let layerCenter = null;
  let layerGrids = null;
  let layerMarkers = null;
  let searchCenter = null;
  const MAX_RADIUS_KM = 30;
  let searchRadiusKm = 0;
  let markerByKey = new Map();
  let lastGridSig = "";
  let lastFitSig = "";
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
  const iconCenter = L.divIcon({
    className: "tdb-map-marker-center",
    html: `<span style="background:#2563eb;width:14px;height:14px;border:3px solid #fff;border-radius:50%;display:block;box-shadow:0 2px 6px rgba(0,0,0,.4)"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  function init() {
    const el = document.getElementById("map");
    if (!el || map) return;

    map = L.map(el, {
      zoomControl: false,
      scrollWheelZoom: true,
      // Giảm nháy khi setView/fitBounds
      fadeAnimation: false,
      zoomAnimation: true,
      markerZoomAnimation: false
    }).setView([21.0285, 105.8542], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    layerGrids = L.featureGroup().addTo(map);
    layerMarkers = L.layerGroup().addTo(map);

    map.on("click", (e) => {
      window.dispatchEvent(
        new CustomEvent("timdiemban:map-pick-center", {
          detail: { lat: e.latlng.lat, lng: e.latlng.lng }
        })
      );
    });

    setTimeout(() => map.invalidateSize({ animate: false }), 200);
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => map?.invalidateSize({ animate: false }), 200);
    });
  }

  function isInsideRadius(lat, lng) {
    if (!searchCenter || !searchRadiusKm) return true;
    return haversineKm(searchCenter.lat, searchCenter.lng, lat, lng) <= searchRadiusKm + 0.05;
  }

  function gridSignature(gridPoints, sideKm) {
    if (!gridPoints?.length || !sideKm) return "";
    const head = gridPoints
      .slice(0, 3)
      .map((p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`)
      .join("|");
    const tail = gridPoints[gridPoints.length - 1];
    return `${gridPoints.length}:${Number(sideKm).toFixed(4)}:${head}:${Number(tail.lat).toFixed(5)},${Number(tail.lng).toFixed(5)}`;
  }

  function drawGrid(gridPoints, sideKm) {
    if (!layerGrids) return;
    const sig = gridSignature(gridPoints, sideKm);
    if (sig && sig === lastGridSig) return;
    lastGridSig = sig;

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
        }),
        interactive: false
      }).addTo(layerGrids);
    });
  }

  function sameSearchArea(center, radiusKm) {
    if (!searchCenter) return false;
    const lat = Number(center?.lat);
    const lng = Number(center?.lng);
    const r = Number(radiusKm) || 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return (
      Math.abs(searchCenter.lat - lat) < 1e-7 &&
      Math.abs(searchCenter.lng - lng) < 1e-7 &&
      Math.abs(searchRadiusKm - r) < 1e-9
    );
  }

  function areaSignature(lat, lng, radiusKm) {
    return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)},${Number(radiusKm || 0).toFixed(3)}`;
  }

  /**
   * options.fit — chỉ zoom khung khi tâm/bán kính đổi (mặc định: fit nếu đổi)
   * options.gridPoints / cellSizeKm — lưới (tuỳ chọn)
   * options.forceGrid — buộc vẽ lại lưới
   */
  function setSearchArea(center, radiusKm, options = {}) {
    if (!map) init();
    if (!map || !center?.lat || !center?.lng) return;

    const nextLat = Number(center.lat);
    const nextLng = Number(center.lng);
    const nextR = Math.min(MAX_RADIUS_KM, Math.max(0, Number(radiusKm) || 0));
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) return;

    const unchanged = sameSearchArea({ lat: nextLat, lng: nextLng }, nextR);
    const sig = areaSignature(nextLat, nextLng, nextR);
    const wantFit =
      options.fit === true || (options.fit !== false && !unchanged && sig !== lastFitSig);

    searchCenter = { lat: nextLat, lng: nextLng };
    searchRadiusKm = nextR;

    // Cập nhật / tạo vòng + tâm (không remove/add → không nháy)
    if (layerCircle) {
      const cur = layerCircle.getLatLng();
      if (Math.abs(cur.lat - nextLat) > 1e-8 || Math.abs(cur.lng - nextLng) > 1e-8) {
        layerCircle.setLatLng([nextLat, nextLng]);
      }
      if (Math.abs(layerCircle.getRadius() - nextR * 1000) > 0.5) {
        layerCircle.setRadius(nextR * 1000);
      }
    } else {
      layerCircle = L.circle([nextLat, nextLng], {
        radius: nextR * 1000,
        color: "#2563eb",
        weight: 2,
        fillColor: "#3b82f6",
        fillOpacity: 0.12
      }).addTo(map);
    }

    if (layerCenter) {
      const cur = layerCenter.getLatLng();
      if (Math.abs(cur.lat - nextLat) > 1e-8 || Math.abs(cur.lng - nextLng) > 1e-8) {
        layerCenter.setLatLng([nextLat, nextLng]);
      }
    } else {
      layerCenter = L.marker([nextLat, nextLng], {
        icon: iconCenter,
        interactive: false,
        keyboard: false
      })
        .bindTooltip("Tâm tìm kiếm", { permanent: false })
        .addTo(map);
    }

    let gridPoints = options.gridPoints;
    let sideKm = options.cellSizeKm;
    if ((!gridPoints?.length || options.forceGrid) && nextR > 0 && (!unchanged || options.forceGrid || !lastGridSig)) {
      const grid = generateSearchGrid(nextLat, nextLng, nextR);
      gridPoints = grid.points;
      sideKm = grid.cellSizeKm;
    }

    if (gridPoints?.length) {
      drawGrid(gridPoints, sideKm);
    } else if (!unchanged) {
      // Tâm đổi mà không có grid → xóa lưới cũ
      lastGridSig = "";
      layerGrids?.clearLayers();
    }

    if (!wantFit || !layerCircle) return;

    lastFitSig = sig;
    const bounds = layerCircle.getBounds();
    try {
      if (layerGrids?.getLayers().length) {
        map.fitBounds(bounds.extend(layerGrids.getBounds()), {
          padding: [24, 24],
          maxZoom: 15,
          animate: false
        });
      } else {
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15, animate: false });
      }
    } catch {}
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

  function clearSearchAreaOverlays() {
    if (!map) return;
    layerGrids?.clearLayers();
    lastGridSig = "";
    lastFitSig = "";
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

  function clearAll() {
    if (!map) return;
    clearSearchAreaOverlays();
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
      if (isInsideRadius(lat, lng)) inC++;
      else outC++;
    }
    updateStats(inC, outC);
    return { inC, outC };
  }

  /** Pan nhẹ — không zoom nhảy nếu đã gần đúng chỗ */
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

  function locateUser() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        if (!map) init();
        map?.setView([lat, lng], 15, { animate: false });
        window.dispatchEvent(
          new CustomEvent("timdiemban:gps-center", {
            detail: { lat, lng, accuracy: pos.coords.accuracy }
          })
        );
      },
      (err) => {
        window.dispatchEvent(
          new CustomEvent("timdiemban:gps-denied", {
            detail: { code: err?.code, message: err?.message }
          })
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }

  window.TimDiemBanMap = {
    init,
    setSearchArea,
    hasSearchArea(lat, lng, radiusKm) {
      return sameSearchArea({ lat, lng }, radiusKm);
    },
    upsertMarker,
    refreshMarkers,
    clearMarkers,
    clearSearchAreaOverlays,
    clearAll,
    countInOut,
    isInsideRadius,
    focusPoint,
    zoomIn,
    zoomOut,
    locateUser,
    invalidateSize() {
      if (map) map.invalidateSize({ animate: false });
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    init();
  });
})();
