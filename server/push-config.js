/**
 * Cấu hình map trường khi gửi điểm sang site nhận (theo từng user).
 */

const SOURCE_FIELDS = [
  "name",
  "address",
  "phone",
  "lat",
  "lng",
  "rating",
  "reviews",
  "mapsUrl",
  "googlePlaceId",
  "category",
  "website",
  "distanceKm"
];

const DEFAULT_PUSH_CONFIG = {
  method: "POST",
  sourceTag: "timdiemban",
  pointsKey: "points",
  mappings: [
    { source: "name", target: "name" },
    { source: "address", target: "address" },
    { source: "phone", target: "phone" },
    { source: "lat", target: "lat" },
    { source: "lng", target: "lng" },
    { source: "rating", target: "rating" },
    { source: "reviews", target: "reviews" },
    { source: "mapsUrl", target: "mapsUrl" },
    { source: "googlePlaceId", target: "googlePlaceId" },
    { source: "category", target: "category" },
    { source: "website", target: "website" },
    { source: "distanceKm", target: "distanceKm" }
  ]
};

function parsePushConfig(raw) {
  if (!raw) return { ...DEFAULT_PUSH_CONFIG, mappings: DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m })) };
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_PUSH_CONFIG, mappings: DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m })) };
    }
  }
  if (!data || typeof data !== "object") {
    return { ...DEFAULT_PUSH_CONFIG, mappings: DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m })) };
  }
  const mappings = Array.isArray(data.mappings)
    ? data.mappings
        .filter((m) => m && m.source && m.target)
        .map((m) => ({ source: String(m.source), target: String(m.target).trim() }))
        .filter((m) => m.target)
    : DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m }));

  return {
    method: data.method === "PUT" ? "PUT" : "POST",
    sourceTag: String(data.sourceTag || DEFAULT_PUSH_CONFIG.sourceTag),
    pointsKey: String(data.pointsKey || DEFAULT_PUSH_CONFIG.pointsKey).trim() || "points",
    mappings: mappings.length ? mappings : DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m }))
  };
}

function applyMappings(point, config) {
  const cfg = parsePushConfig(config);
  const out = {};
  for (const { source, target } of cfg.mappings) {
    const val = point[source];
    out[target] = val === undefined || val === null ? "" : val;
  }
  return out;
}

function buildPushBody(points, config) {
  const cfg = parsePushConfig(config);
  const mapped = (points || []).map((p) => applyMappings(p, cfg));
  const body = {
    [cfg.pointsKey]: mapped
  };
  if (cfg.sourceTag) body.source = cfg.sourceTag;
  return body;
}

module.exports = {
  SOURCE_FIELDS,
  DEFAULT_PUSH_CONFIG,
  parsePushConfig,
  applyMappings,
  buildPushBody
};
