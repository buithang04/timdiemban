/**
 * Cấu hình map trường + sinh CURL preview (client).
 */
(function (global) {
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

  const FIELD_LABELS = {
    name: "Tên điểm bán",
    address: "Địa chỉ",
    phone: "Số điện thoại",
    lat: "Vĩ độ (lat)",
    lng: "Kinh độ (lng)",
    rating: "Đánh giá",
    reviews: "Số review",
    mapsUrl: "Link Google Maps",
    googlePlaceId: "Google Place ID",
    category: "Ngành hàng",
    website: "Website",
    distanceKm: "Khoảng cách (km)"
  };

  const SAMPLE_POINT = {
    name: "Cửa hàng mẫu",
    address: "123 Đường ABC, Quận 1, TP.HCM",
    phone: "0901234567",
    lat: 10.7769,
    lng: 106.7009,
    rating: "4.5",
    reviews: "128",
    mapsUrl: "https://maps.google.com/?q=10.7769,106.7009",
    googlePlaceId: "ChIJxxxx",
    category: "Bán lẻ",
    website: "https://example.com",
    distanceKm: 1.2
  };

  const DEFAULT_PUSH_CONFIG = {
    method: "POST",
    sourceTag: "timdiemban",
    pointsKey: "points",
    urlMode: "winmap",
    mappings: SOURCE_FIELDS.map((f) => ({ source: f, target: f }))
  };

  function parsePushConfig(raw) {
    if (!raw) {
      return {
        ...DEFAULT_PUSH_CONFIG,
        mappings: DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m }))
      };
    }
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        return {
          ...DEFAULT_PUSH_CONFIG,
          mappings: DEFAULT_PUSH_CONFIG.mappings.map((m) => ({ ...m }))
        };
      }
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
      urlMode: data.urlMode === "custom" ? "custom" : "winmap",
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
    const body = { [cfg.pointsKey]: mapped };
    if (cfg.sourceTag) body.source = cfg.sourceTag;
    return body;
  }

  function resolveImportUrl(input, urlMode = "winmap") {
    let raw = String(input || "").trim();
    if (!raw) return "";
    if (!/^https?:\/\//i.test(raw)) {
      const host = raw.split("/")[0].split("?")[0];
      const isLocal = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(host);
      raw = (isLocal ? "http://" : "https://") + raw;
    }
    if (urlMode === "custom") return raw;
    const trimmed = raw.replace(/\/+$/, "");
    if (/\/api\/points\/import$/i.test(trimmed)) return trimmed;
    return trimmed + "/api/points/import";
  }

  function buildCurlPreview({ url, token, pushConfig, samplePoint }) {
    const cfg = parsePushConfig(pushConfig);
    const importUrl = resolveImportUrl(url, cfg.urlMode);
    if (!importUrl) return "# Nhập URL site để xem CURL mẫu";
    const body = buildPushBody([samplePoint || SAMPLE_POINT], cfg);
    const lines = [
      `curl -X ${cfg.method} '${importUrl}' \\`,
      `  -H 'Content-Type: application/json' \\`
    ];
    if (token) lines.push(`  -H 'Authorization: Bearer ${token}' \\`);
    const json = JSON.stringify(body, null, 2);
    lines.push(`  -d @- <<'JSON'\n${json}\nJSON`);
    return lines.join("\n");
  }

  global.TimDiemBanPushConfig = {
    SOURCE_FIELDS,
    FIELD_LABELS,
    SAMPLE_POINT,
    DEFAULT_PUSH_CONFIG,
    parsePushConfig,
    applyMappings,
    buildPushBody,
    buildCurlPreview,
    resolveImportUrl
  };
})(typeof window !== "undefined" ? window : globalThis);
