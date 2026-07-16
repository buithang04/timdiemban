/** Lưới ô tìm kiếm — đồng bộ logic extension/grid.js */
const MAX_SEARCH_RADIUS_KM = 30;

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
