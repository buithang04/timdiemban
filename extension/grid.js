/**
 * grid.js — lưới tìm kiếm + dedupe.
 * Cần load place-fields.js trước (sanitize / phone / enrich).
 */
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

/** Tâm bản đồ từ @lat,lng trên thanh URL Google Maps */
function extractMapCenterFromUrl(url) {
  if (!url) return null;
  try {
    const decoded = decodeURIComponent(url);
    const at = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\?|\/|$|&)/);
    if (at) {
      const lat = parseFloat(at[1]);
      const lng = parseFloat(at[2]);
      if (!isNaN(lat) && !isNaN(lng)) return normalizeCenterCoords(lat, lng);
    }
    const ll = decoded.match(/[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (ll) {
      const lat = parseFloat(ll[1]);
      const lng = parseFloat(ll[2]);
      if (!isNaN(lat) && !isNaN(lng)) return normalizeCenterCoords(lat, lng);
    }
  } catch {}
  return null;
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

const CELL_LABELS = {
  center: "Tâm",
  north: "Bắc",
  east: "Đông",
  south: "Nam",
  west: "Tây",
  ne: "Đông Bắc",
  nw: "Tây Bắc",
  se: "Đông Nam",
  sw: "Tây Nam"
};

function getCellDisplayName(cellId) {
  if (!cellId) return "Tâm";
  if (cellId === "center") return CELL_LABELS.center;
  return CELL_LABELS[cellId] || cellId;
}

function kmPerDegLng(lat) {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Cạnh ô vuông trên Maps (@lat,lng,Xm).
 * ~24% bán kính — cân bằng độ phủ và tốc độ.
 */
function getViewportSizeM(radiusKm) {
  const r = Number(radiusKm);
  if (!r || r <= 0) return 1100;
  const rM = r * 1000;
  let sideM = Math.round(rM * 0.24);
  sideM = Math.max(700, Math.min(sideM, 1500));
  return Math.round(sideM / 10) * 10;
}

/** @deprecated dùng getViewportSizeM — giữ tương thích */
function getCellSizeKm(radiusKm) {
  return getViewportSizeM(radiusKm) / 1000;
}

/**
 * Lưới vuông xếp sát — phủ kín vòng tròn, cắt góc ô ngoài vòng.
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

const MAX_SEARCH_RADIUS_KM = 20;

function clampSearchRadiusKm(radiusKm) {
  const r = Number(radiusKm);
  if (!Number.isFinite(r) || r <= 0) return r;
  return Math.min(MAX_SEARCH_RADIUS_KM, r);
}

function generateSearchGrid(centerLat, centerLng, radiusKm) {
  radiusKm = clampSearchRadiusKm(radiusKm);
  const viewportM = getViewportSizeM(radiusKm);
  const sideKm = viewportM / 1000;
  const halfSide = sideKm / 2;
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
      cellLabel: isCenter ? CELL_LABELS.center : `Ô ${searchOrder}`,
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
      cellLabel: CELL_LABELS.center,
      gridRow: 0,
      gridCol: 0
    });
  }

  const gridSteps = halfSteps * 2 + 1;
  return {
    points,
    cellSizeKm: sideKm,
    viewportM,
    totalCells: points.length,
    gridSteps,
    gridMode: "spiral_tile",
    stepKm
  };
}

function buildGlobalSeenKeys(places) {
  const keys = new Set();
  for (const p of places) {
    keys.add(getDedupeKey(p));
    // Không seed place:slug trần — cùng tên chuỗi cửa hàng sẽ bị skip xuyên các ô
    const cid = p.googlePlaceId || getCanonicalPlaceId(p.mapsUrl || p.href || "");
    if (cid) keys.add(`cid:${String(cid).toLowerCase()}`);
    const name = normalizeName(p.name);
    const phone = normalizePhone(p.phone);
    if (name && phone.length >= 9) keys.add(`np:${name}|${phone}`);
    const coords = resolvePlaceCoords(p);
    if (name && coords) {
      keys.add(`coord:${name}|${Number(coords.lat).toFixed(4)}|${Number(coords.lng).toFixed(4)}`);
    }
  }
  return [...keys];
}

function getPlaceSlugFromRecord(p) {
  for (const url of [p.href, p.mapsUrl]) {
    if (!url) continue;
    try {
      const m = decodeURIComponent(url).match(/\/maps\/place\/([^/@?]+)/);
      if (m) return decodeURIComponent(m[1]).toLowerCase().replace(/\+/g, " ").trim();
    } catch {}
  }
  return "";
}

/** ID chuẩn — ưu tiên ChIJ; slug kèm tọa độ để tránh gộp mọi quán cùng tên */
function getCanonicalPlaceId(url) {
  if (!url) return "";
  try {
    const decoded = decodeURIComponent(url);
    const chij = decoded.match(/!(?:1s|19s)(ChIJ[a-zA-Z0-9_-]+)/);
    if (chij) return chij[1];
    const chijQ = decoded.match(/[?&]query_place_id=(ChIJ[a-zA-Z0-9_-]+)/);
    if (chijQ) return chijQ[1];
    const slugM = decoded.match(/\/maps\/place\/([^/@?]+)/);
    if (slugM && slugM[1].length > 1) {
      const slug = slugM[1].toLowerCase().replace(/\+/g, " ").slice(0, 120);
      const coords = extractCoordsFromUrl(url);
      if (coords && !isNaN(coords.lat) && !isNaN(coords.lng)) {
        return `slug:${slug}@${Number(coords.lat).toFixed(4)},${Number(coords.lng).toFixed(4)}`;
      }
      // Slug trần yếu — không dùng làm id duy nhất (chuỗi cửa hàng cùng tên)
      return "";
    }
  } catch {}
  return "";
}

function getGooglePlaceId(url) {
  return getCanonicalPlaceId(url);
}

function extractCoordsFromUrl(url) {
  if (!url) return null;
  const decoded = decodeURIComponent(url);
  const matches = [...decoded.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    return { lat: parseFloat(last[1]), lng: parseFloat(last[2]) };
  }
  const alt = decoded.match(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
  if (alt) return { lat: parseFloat(alt[2]), lng: parseFloat(alt[1]) };
  return null;
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d") // "đ" không có decomposition NFD — phải thay tay
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAddress(address) {
  return normalizeName(address).replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}

function resolvePlaceCoords(place) {
  const urls = [place.mapsUrl, place.href].filter(Boolean);
  for (const url of urls) {
    const c = extractCoordsFromUrl(url);
    if (c && !isNaN(c.lat) && !isNaN(c.lng)) return c;
  }
  if (place.lat != null && place.lng != null && !isNaN(place.lat)) {
    return { lat: place.lat, lng: place.lng };
  }
  return null;
}

function parseListDistanceKm(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(String(value).replace(",", "."));
  return isNaN(n) ? null : n;
}

/** So sánh km trên list Maps với km tính từ tọa độ pin */
function coordsConsistentWithList(lat, lng, centerLat, centerLng, listDistanceKm) {
  const list = parseListDistanceKm(listDistanceKm);
  if (list == null || centerLat == null || centerLng == null) return true;
  const calc = haversineKm(centerLat, centerLng, lat, lng);
  const diff = Math.abs(calc - list);
  return diff <= Math.max(0.35, list * 0.5 + 0.15);
}

function isValidPlaceName(name) {
  const n = (name || "")
    .replace(/[\uFFFD\u200B-\u200D\uFEFF]/g, "")
    .replace(/^được tài trợ\s*/gi, "")
    .replace(/^sponsored\s*/gi, "")
    .trim();
  if (n.length < 2) return false;
  const lower = n.toLowerCase();
  if (lower === "được tài trợ" || lower === "sponsored" || lower === "quảng cáo") return false;
  if (!/[\p{L}\p{N}]/u.test(n)) return false;
  return true;
}

function getDedupeKey(place) {
  const cid =
    place.googlePlaceId ||
    getCanonicalPlaceId(place.mapsUrl || place.href || "");
  if (cid) return `cid:${cid}`;

  const phone = normalizePhone(place.phone);
  const name = normalizeName(place.name);
  if (name && phone.length >= 9) return `np:${name}|${phone}`;

  const addr = normalizeAddress(place.address);
  if (name && addr.length > 8) return `na:${name}|${addr.slice(0, 60)}`;

  const coords = resolvePlaceCoords(place);
  if (name && coords) {
    return `coord:${name}|${Number(coords.lat).toFixed(4)}|${Number(coords.lng).toFixed(4)}`;
  }
  return `fb:${name}|${(place.address || "").slice(0, 50)}`;
}

function getPlaceKey(place) {
  return getDedupeKey(place);
}

function isNearDuplicate(a, b) {
  if (!a || !b) return false;

  const idA = (a.googlePlaceId || getCanonicalPlaceId(a.mapsUrl || a.href || "")).toLowerCase();
  const idB = (b.googlePlaceId || getCanonicalPlaceId(b.mapsUrl || b.href || "")).toLowerCase();
  if (idA && idB && idA === idB) return true;

  if (getDedupeKey(a) === getDedupeKey(b)) return true;

  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);
  const phoneA = normalizePhone(a.phone);
  const phoneB = normalizePhone(b.phone);

  // Cùng SĐT KHÔNG đủ để gộp — nhiều cửa hàng dùng 1 tổng đài
  // Chỉ gộp khi thêm cùng tên, hoặc hai pin gần nhau
  if (phoneA.length >= 9 && phoneA === phoneB) {
    if (nameA && nameB && nameA === nameB) return true;
    const ca = resolvePlaceCoords(a);
    const cb = resolvePlaceCoords(b);
    if (ca && cb && haversineKm(ca.lat, ca.lng, cb.lat, cb.lng) < 0.12) return true;
  }

  if (!nameA || nameA !== nameB) return false;

  const addrA = normalizeAddress(a.address);
  const addrB = normalizeAddress(b.address);
  if (addrA.length > 10 && addrA === addrB) return true;

  const ca = resolvePlaceCoords(a);
  const cb = resolvePlaceCoords(b);
  if (ca && cb && haversineKm(ca.lat, ca.lng, cb.lat, cb.lng) < 0.25) return true;

  return false;
}

function pickBetterRating(a, b) {
  const ra = a && /\d/.test(String(a));
  const rb = b && /\d/.test(String(b));
  if (rb) return String(b).trim();
  if (ra) return String(a).trim();
  return (b || a || "").trim();
}

function pickBetterReviews(a, b) {
  const na = parseInt(String(a || "").replace(/\D/g, ""), 10) || 0;
  const nb = parseInt(String(b || "").replace(/\D/g, ""), 10) || 0;
  if (nb > na) return String(b).trim();
  if (na > nb) return String(a).trim();
  return (b || a || "").trim();
}

function mergePlaceRecord(target, source) {
  const cid =
    getCanonicalPlaceId(source.mapsUrl || source.href || "") ||
    getCanonicalPlaceId(target.mapsUrl || target.href || "") ||
    source.googlePlaceId ||
    target.googlePlaceId;

  const srcCoords = resolvePlaceCoords(source);
  const tgtCoords = resolvePlaceCoords(target);
  let lat = srcCoords?.lat ?? target.lat;
  let lng = srcCoords?.lng ?? target.lng;
  if (srcCoords && tgtCoords) {
    const srcUrl = source.mapsUrl || source.href || "";
    if (srcUrl.includes("!3d") && extractCoordsFromUrl(srcUrl)) {
      lat = srcCoords.lat;
      lng = srcCoords.lng;
    }
  }

  const listDistanceKm = source.listDistanceKm ?? target.listDistanceKm;

  // Tách SĐT từ địa chỉ thô TRƯỚC khi sanitize xóa chuỗi rác
  const fromTarget = recoverContactFieldsFromAddress({
    address: target.address,
    phone: target.phone
  });
  const fromSource = recoverContactFieldsFromAddress({
    address: source.address,
    phone: source.phone
  });

  Object.assign(target, {
    ...target,
    ...source,
    googlePlaceId: cid || target.googlePlaceId,
    placeId: cid || target.placeId,
    phone: pickBetterPhone(fromTarget.phone, fromSource.phone),
    address: pickBetterAddress(fromTarget.address, fromSource.address),
    website: source.website || target.website,
    category: source.category || target.category,
    hours: source.hours || target.hours,
    rating: pickBetterRating(target.rating, source.rating),
    reviews: pickBetterReviews(target.reviews, source.reviews || ""),
    lat,
    lng,
    mapsUrl: source.mapsUrl || target.mapsUrl,
    href: source.href || target.href,
    listDistanceKm,
    distanceKm: source.distanceKm ?? target.distanceKm,
    _enrichCellIndex: source._enrichCellIndex ?? target._enrichCellIndex,
    _enrichCellLat: source._enrichCellLat ?? target._enrichCellLat,
    _enrichCellLng: source._enrichCellLng ?? target._enrichCellLng,
    _enrichSearchUrl: source._enrichSearchUrl || target._enrichSearchUrl
  });
  return recoverContactFieldsFromAddress(target);
}

function dedupePlaces(places) {
  const out = [];
  for (const p of places) {
    const dup = out.find((e) => isNearDuplicate(e, p));
    if (dup) mergePlaceRecord(dup, p);
    else out.push({ ...p });
  }
  return out;
}

function placesToMap(places) {
  const m = new Map();
  for (const p of places) {
    const key = getDedupeKey(p);
    const existing = m.get(key);
    if (existing) mergePlaceRecord(existing, p);
    else m.set(key, { ...p });
  }
  return m;
}

function getPlaceDistanceKm(p, centerLat, centerLng) {
  const coords = resolvePlaceCoords(p);
  if (coords) {
    return Math.round(haversineKm(centerLat, centerLng, coords.lat, coords.lng) * 100) / 100;
  }
  if (p.distanceKm != null && !isNaN(p.distanceKm)) return p.distanceKm;
  return null;
}

function isWithinRadius(place, centerLat, centerLng, radiusKm, toleranceKm = 0.35) {
  const coords = resolvePlaceCoords(place);
  if (coords) {
    return haversineKm(centerLat, centerLng, coords.lat, coords.lng) <= radiusKm + toleranceKm;
  }
  if (place.distanceKm != null && !isNaN(place.distanceKm)) {
    return place.distanceKm <= radiusKm + toleranceKm;
  }
  const listKm = parseListDistanceKm(place.listDistanceKm);
  if (listKm != null) {
    const cellDist = place._cellDist ?? 0;
    if (cellDist > 0.1) {
      return cellDist + listKm <= radiusKm + toleranceKm + 0.5;
    }
    return listKm <= radiusKm + toleranceKm + 1;
  }
  // Không có tọa độ → giữ lại (không loại bỏ kết quả đã scrape được)
  return true;
}

function getPlacePageUrl(url) {
  if (!url || !url.includes("/maps/place")) return "";
  const clean = url.split("#")[0];
  if (!extractCoordsFromUrl(clean)) return "";
  return clean;
}

function buildPlaceMapsUrl(lat, lng, googlePlaceId, name) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return "";
  const q = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
  if (googlePlaceId && String(googlePlaceId).startsWith("ChIJ")) {
    const label = name ? encodeURIComponent(name) : q;
    return `https://www.google.com/maps/search/?api=1&query=${label}&query_place_id=${googlePlaceId}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function isListItemInSearchRadius(listKm, mapLat, mapLng, centerLat, centerLng, radiusKm) {
  if (listKm == null) return true;
  const cellDist = haversineKm(centerLat, centerLng, mapLat, mapLng);
  return cellDist + listKm <= radiusKm + 0.25;
}

function applyPlaceDistanceAndRadiusFlag(p, centerLat, centerLng, radiusKm) {
  const listKm = parseListDistanceKm(p.listDistanceKm);
  const coords = resolvePlaceCoords(p);
  if (coords) {
    p.lat = coords.lat;
    p.lng = coords.lng;
    p.distanceKm = Math.round(haversineKm(centerLat, centerLng, coords.lat, coords.lng) * 100) / 100;
  } else if (listKm != null && p.distanceKm == null) {
    p.distanceKm = listKm;
  }
  p.outOfRadius = !isWithinRadius(p, centerLat, centerLng, radiusKm, 0.35);
  return p;
}

/** Thu thập từ list — giữ mọi quán hợp lệ, đánh dấu outOfRadius thay vì loại */
function sanitizeFromList(place, centerLat, centerLng, radiusKm, mapLat, mapLng, collectMode = false) {
  void mapLat;
  void mapLng;
  void collectMode;
  if (!place || !isValidPlaceName(place.name)) return null;
  const p = { ...place };
  const cid = getCanonicalPlaceId(p.href || p.mapsUrl || "") || p.googlePlaceId;
  if (cid) {
    p.googlePlaceId = cid;
    p.placeId = cid;
  }
  return applyPlaceDistanceAndRadiusFlag(p, centerLat, centerLng, radiusKm);
}

function sanitizePlace(place, centerLat, centerLng, radiusKm, mapLat, mapLng) {
  void mapLat;
  void mapLng;
  if (!place) return null;
  if (!isValidPlaceName(place.name)) return null;
  const p = recoverContactFieldsFromAddress({ ...place });
  const cid = getCanonicalPlaceId(p.mapsUrl || p.href || "") || p.googlePlaceId;
  if (cid) {
    p.googlePlaceId = cid;
    p.placeId = cid;
  }
  return applyPlaceDistanceAndRadiusFlag(p, centerLat, centerLng, radiusKm);
}

function placeInRadius(p, centerLat, centerLng, radiusKm) {
  return isWithinRadius(p, centerLat, centerLng, radiusKm, 0.35);
}

/** Giữ tất cả quán — gắn khoảng cách + cờ outOfRadius */
function annotatePlacesRadius(places, centerLat, centerLng, radiusKm) {
  return addDistanceKm(
    places.map((p) => ({ ...p })),
    centerLat,
    centerLng
  ).map((p) => {
    p.outOfRadius = !placeInRadius(p, centerLat, centerLng, radiusKm);
    return p;
  });
}

function filterByRadius(places, centerLat, centerLng, radiusKm) {
  return annotatePlacesRadius(places, centerLat, centerLng, radiusKm);
}

function addDistanceKm(places, centerLat, centerLng) {
  return places.map((p) => {
    const coords = resolvePlaceCoords(p);
    if (coords) {
      p.lat = coords.lat;
      p.lng = coords.lng;
    }
    const dist = getPlaceDistanceKm(p, centerLat, centerLng);
    if (dist != null) p.distanceKm = dist;
    return p;
  });
}
