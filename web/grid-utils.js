/** Lưới ô tìm kiếm — đồng bộ logic extension/grid.js */
const MAX_SEARCH_RADIUS_KM = 20;

function clampSearchRadiusKm(radiusKm) {
  const r = Number(radiusKm);
  if (!Number.isFinite(r) || r <= 0) return r;
  return Math.min(MAX_SEARCH_RADIUS_KM, r);
}
function kmPerDegLng(lat) {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getViewportSizeM(radiusKm) {
  const r = Number(radiusKm);
  if (!r || r <= 0) return 1100;
  const rM = r * 1000;
  let sideM = Math.round(rM * 0.24);
  sideM = Math.max(700, Math.min(sideM, 1500));
  return Math.round(sideM / 10) * 10;
}

/**
 * Lưới vuông xếp sát (cạnh kề cạnh) — phủ kín mặt phẳng, không hở giữa các ô.
 * Thứ tự duyệt: xoắn ốc từ tâm (Ô 1, 2, 3…).
 */
function generateSpiralGridCoords(halfSteps) {
  const coords = [];
  const seen = new Set();
  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;
  const maxCells = (2 * halfSteps + 1) ** 2;

  for (let i = 0; i < maxCells; i++) {
    if (Math.abs(x) <= halfSteps && Math.abs(y) <= halfSteps) {
      const key = `${y},${x}`;
      if (!seen.has(key)) {
        seen.add(key);
        coords.push({ row: y, col: x });
      }
    }
    if (x === y || (x < 0 && x === -y) || (x > 0 && x === 1 - y)) {
      [dx, dy] = [-dy, dx];
    }
    x += dx;
    y += dy;
  }
  return coords;
}

function cellIntersectsCircle(cellLat, cellLng, centerLat, centerLng, radiusKm, halfSideKm) {
  const d = haversineKm(centerLat, centerLng, cellLat, cellLng);
  const halfDiag = halfSideKm * Math.SQRT2;
  return d - halfDiag <= radiusKm + 0.05;
}

function generateSearchGrid(centerLat, centerLng, radiusKm) {
  radiusKm = clampSearchRadiusKm(radiusKm);
  const viewportM = getViewportSizeM(radiusKm);
  const sideKm = viewportM / 1000;
  const halfSide = sideKm / 2;
  // Bước nhảy = cạnh ô → các vuông ghép kín, bao phủ 100% vùng
  const stepKm = sideKm;

  const halfSteps = Math.max(0, Math.ceil((radiusKm + halfSide) / stepKm));

  const latDegPerKm = 1 / 111.32;
  const lngDegPerKm = 1 / kmPerDegLng(centerLat);
  const stepLat = stepKm * latDegPerKm;
  const stepLng = stepKm * lngDegPerKm;

  const spiral = generateSpiralGridCoords(halfSteps);
  const points = [];
  let searchOrder = 0;

  for (const { row, col } of spiral) {
    const lat = centerLat + row * stepLat;
    const lng = centerLng + col * stepLng;
    if (!cellIntersectsCircle(lat, lng, centerLat, centerLng, radiusKm, halfSide)) continue;

    searchOrder++;
    const dist = haversineKm(centerLat, centerLng, lat, lng);
    const isCenter = row === 0 && col === 0;
    points.push({
      lat,
      lng,
      distFromCenter: Math.round(dist * 100) / 100,
      searchOrder,
      cellId: isCenter ? "center" : `g${row}_${col}`,
      cellLabel: isCenter ? "Tâm" : `Ô ${searchOrder}`,
      gridRow: row,
      gridCol: col
    });
  }

  if (!points.length) {
    points.push({
      lat: centerLat,
      lng: centerLng,
      distFromCenter: 0,
      searchOrder: 1,
      cellId: "center",
      cellLabel: "Tâm",
      gridRow: 0,
      gridCol: 0
    });
  }

  return {
    points,
    cellSizeKm: sideKm,
    viewportM,
    totalCells: points.length,
    stepKm
  };
}

function squareBounds(lat, lng, sideKm) {
  const halfLat = sideKm / 2 / 111.32;
  const halfLng = sideKm / 2 / kmPerDegLng(lat);
  return [
    [lat - halfLat, lng - halfLng],
    [lat + halfLat, lng + halfLng]
  ];
}

/* — Ward polygon helpers (mirrors extension/grid.js) — */

function extractPolygonRings(geojson) {
  if (!geojson) return [];
  const features = geojson.features || (geojson.type === "Feature" ? [geojson] : []);
  const rings = [];
  for (const feat of features) {
    const geom = feat?.geometry;
    if (!geom) continue;
    if (geom.type === "Polygon") rings.push(...(geom.coordinates || []));
    else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates || []) rings.push(...poly);
    }
  }
  return rings;
}

function pointInPolygon(lat, lng, polygonCoords) {
  if (!polygonCoords?.length) return true;
  let inside = false;
  const x = lng, y = lat;
  for (const ring of polygonCoords) {
    const len = ring.length;
    for (let i = 0, j = len - 1; i < len; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * Estimate grid cell count from ward boundary GeoJSON.
 * Used for UI preview (ward hint) — does not run full PIP.
 */
/** Ô quét phường/xã — kích thước tự chỉnh theo diện tích (nhỏ → ô nhỏ, lớn → ô lớn). */
const MIN_POLYGON_VIEWPORT_M = 300;
const MAX_POLYGON_VIEWPORT_M = 1000;
/** Khi phủ cả tỉnh/vùng lớn: cho phép ô lớn hơn để phủ kín, không cắt phần biên. */
const MAX_POLYGON_VIEWPORT_M_COVER = 8000;
/** Mục tiêu ~số ô trên bbox trước khi lọc PIP (khu vực vừa). */
const TARGET_POLYGON_GRID_CELLS = 48;
const TARGET_POLYGON_GRID_CELLS_COVER = 160;
/** Fallback / tương thích cũ khi không tính được bbox. */
const DEFAULT_POLYGON_VIEWPORT_M = 400;
const MAX_POLYGON_GRID_CELLS = 220;
const MAX_POLYGON_GRID_CELLS_COVER = 280;

/**
 * Chọn cạnh ô (mét) theo kích thước khu vực.
 * viewportM số → dùng giá trị đó (đã clamp). null/"auto"/bỏ trống → tự động.
 * opts.coverFull: phủ kín toàn bộ bbox (tỉnh/vùng lớn) — phình ô thay vì cắt mép.
 */
function resolvePolygonViewportM(widthKm, heightKm, viewportM, opts = {}) {
  const w = Math.max(Number(widthKm) || 0, 0.05);
  const h = Math.max(Number(heightKm) || 0, 0.05);
  const coverFull = opts.coverFull === true;
  const maxCells =
    Number(opts.maxCells) > 0
      ? Math.floor(Number(opts.maxCells))
      : coverFull
        ? MAX_POLYGON_GRID_CELLS_COVER
        : MAX_POLYGON_GRID_CELLS;
  const hardMaxM = coverFull ? MAX_POLYGON_VIEWPORT_M_COVER : MAX_POLYGON_VIEWPORT_M;
  const target = coverFull ? TARGET_POLYGON_GRID_CELLS_COVER : TARGET_POLYGON_GRID_CELLS;

  const explicit = Number(viewportM);
  let sideM;
  if (Number.isFinite(explicit) && explicit > 0) {
    sideM = Math.round(explicit);
  } else {
    const area = w * h;
    let sideKm = Math.sqrt(area / target);
    if (!coverFull) {
      // Phường nhỏ: ưu tiên chia ít nhất ~3–4 ô theo cạnh ngắn
      const shortKm = Math.max(Math.min(w, h), 0.2);
      sideKm = Math.min(sideKm, shortKm / 3.5);
    }
    sideM = Math.round(sideKm * 1000);
  }
  sideM = Math.max(MIN_POLYGON_VIEWPORT_M, Math.min(sideM, hardMaxM));

  // Phình ô nếu lưới bbox vượt ngân sách
  const budget = Math.floor(maxCells * (coverFull ? 1.05 : 1.35));
  for (let i = 0; i < 24; i++) {
    const sideKm = sideM / 1000;
    const cols = Math.max(1, Math.ceil(w / sideKm));
    const rows = Math.max(1, Math.ceil(h / sideKm));
    if (cols * rows <= budget) break;
    if (sideM >= hardMaxM) break;
    sideM = Math.min(hardMaxM, Math.round(sideM * 1.12));
  }

  // coverFull: ép cạnh đủ lớn để bbox không vượt budget (phủ kín, không cắt tâm)
  if (coverFull) {
    const needM = Math.ceil(Math.sqrt((w * h) / Math.max(budget, 1)) * 1000);
    sideM = Math.max(sideM, Math.min(needM, hardMaxM));
  }
  return sideM;
}

function estimateGridCellsFromBoundary(geojson, opts = {}) {
  if (!geojson?.bbox) return 0;
  const [minLng, minLat, maxLng, maxLat] = geojson.bbox;
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((minLat * Math.PI) / 180);
  const heightKm = (maxLat - minLat) * kmPerDegLat;
  const widthKm = (maxLng - minLng) * kmPerDegLng;
  const sideKm = resolvePolygonViewportM(widthKm, heightKm, null, opts) / 1000;
  const cols = Math.ceil(widthKm / sideKm) || 1;
  const rows = Math.ceil(heightKm / sideKm) || 1;
  return cols * rows;
}

/** Ô giao polygon nếu tâm / góc / điểm giữa cạnh nằm trong biên. */
function cellIntersectsPolygon(lat, lng, halfLat, halfLng, rings) {
  const samples = [
    [lat, lng],
    [lat - halfLat, lng - halfLng],
    [lat - halfLat, lng + halfLng],
    [lat + halfLat, lng - halfLng],
    [lat + halfLat, lng + halfLng],
    [lat - halfLat, lng],
    [lat + halfLat, lng],
    [lat, lng - halfLng],
    [lat, lng + halfLng]
  ];
  for (const [a, b] of samples) {
    if (pointInPolygon(a, b, rings)) return true;
  }
  return false;
}

/**
 * Lưới ô vuông xếp sát phủ toàn bộ polygon.
 * viewportM: số mét cố định, hoặc null/"auto" để tự chỉnh theo diện tích.
 * opts: { coverFull, level, maxCells }
 */
function generateGridFromPolygon(boundaryGeoJSON, viewportM = null, opts = {}) {
  if (viewportM && typeof viewportM === "object" && !Array.isArray(viewportM)) {
    opts = viewportM;
    viewportM = opts.viewportM != null ? opts.viewportM : null;
  }
  const coverFull =
    opts.coverFull === true || opts.level === "province" || opts.areaLevel === "province";
  const maxCells =
    Number(opts.maxCells) > 0
      ? Math.floor(Number(opts.maxCells))
      : coverFull
        ? MAX_POLYGON_GRID_CELLS_COVER
        : MAX_POLYGON_GRID_CELLS;

  const rings = extractPolygonRings(boundaryGeoJSON);
  if (!rings.length) {
    return generateSearchGrid(21.0285, 105.8542, 1);
  }

  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }

  const midLat = (minLat + maxLat) / 2;
  const heightKm = Math.max((maxLat - minLat) * 111.32, 0.05);
  const widthKm = Math.max(
    (maxLng - minLng) * 111.32 * Math.cos((midLat * Math.PI) / 180),
    0.05
  );
  const resolvedVm = resolvePolygonViewportM(widthKm, heightKm, viewportM, {
    coverFull,
    maxCells
  });

  const sideKm = resolvedVm / 1000;
  const latDegPerKm = 1 / 111.32;
  const lngDegPerKm = 1 / (111.32 * Math.cos((midLat * Math.PI) / 180));
  const stepLat = sideKm * latDegPerKm;
  const stepLng = sideKm * lngDegPerKm;
  const halfLat = stepLat / 2;
  const halfLng = stepLng / 2;

  // Tâm ô lệch nửa bước → các ô ghép kín bbox, phủ hết vùng
  const latSteps = Math.max(1, Math.ceil((maxLat - minLat) / stepLat));
  const lngSteps = Math.max(1, Math.ceil((maxLng - minLng) / stepLng));
  const centerLat = midLat;
  const centerLng = (minLng + maxLng) / 2;

  let points = [];

  for (let row = 0; row < latSteps; row++) {
    for (let col = 0; col < lngSteps; col++) {
      const lat = minLat + halfLat + row * stepLat;
      const lng = minLng + halfLng + col * stepLng;
      if (!cellIntersectsPolygon(lat, lng, halfLat, halfLng, rings)) continue;
      points.push({
        lat,
        lng,
        distFromCenter: haversineKm(centerLat, centerLng, lat, lng),
        searchOrder: 0,
        cellId: `g${row}_${col}`,
        cellLabel: "",
        gridRow: row,
        gridCol: col
      });
    }
  }

  if (!points.length) {
    points.push({
      lat: centerLat,
      lng: centerLng,
      distFromCenter: 0,
      searchOrder: 1,
      cellId: "center",
      cellLabel: "Tâm",
      gridRow: 0,
      gridCol: 0
    });
  } else {
    points.sort((a, b) => a.distFromCenter - b.distFromCenter);
    // coverFull: đã phình ô để phủ bbox — chỉ cắt nếu vượt trần cứng
    if (points.length > maxCells) {
      points = points.slice(0, maxCells);
    }
    points.forEach((p, i) => {
      p.searchOrder = i + 1;
      p.cellLabel = `Ô ${i + 1}`;
    });
  }

  return {
    points,
    cellSizeKm: sideKm,
    viewportM: resolvedVm,
    totalCells: points.length,
    gridSteps: 0,
    gridMode: coverFull ? "province" : "polygon",
    stepKm: sideKm,
    capped: points.length >= maxCells,
    coverFull,
    adaptive: !(Number(viewportM) > 0)
  };
}
