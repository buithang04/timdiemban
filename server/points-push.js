/**
 * Gửi điểm bán ra hệ thống ngoài (Winmap hoặc webhook tùy cấu hình).
 *
 * PowerShell:
 *   $env:WINMAP_PUSH_URL = "http://localhost/winmap/api/points/import"
 *   $env:WINMAP_PUSH_TOKEN = "optional-bearer-token"
 */
/**
 * Chuẩn hóa URL endpoint nhận dữ liệu.
 * @param {string} input URL hoặc domain người dùng nhập
 * @param {"winmap"|"custom"} urlMode winmap = tự thêm /api/points/import; custom = dùng đúng URL đã nhập
 */
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

/**
 * Trả về URL gốc và URL fallback (?q=) — chỉ áp dụng cho Winmap/Drupal.
 */
function resolveImportUrls(input, options = {}) {
  const urlMode = options.urlMode === "custom" ? "custom" : "winmap";
  const clean = resolveImportUrl(input, urlMode);
  if (!clean) return { clean: "", fallback: "" };
  if (urlMode === "custom") return { clean, fallback: "" };
  const base = clean.replace(/\/api\/points\/import$/i, "");
  const fallback = base + "/?q=api/points/import";
  return { clean, fallback };
}

/**
 * Gửi điểm bán sang Winmap.
 * @param {Array} points danh sách điểm.
 * @param {Object} options { url, token } — ghi đè site đích. Nếu không có sẽ
 *   fallback về biến môi trường WINMAP_PUSH_URL / WINMAP_PUSH_TOKEN.
 */
/**
 * Thử POST tới một URL cụ thể; trả về { ok, data, status, usedUrl } hoặc ném lỗi.
 */
async function tryPost(url, headers, body, method = "POST") {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data, usedUrl: url };
}

const { buildPushBody, parsePushConfig } = require("./push-config");

async function pushPointsExternal(points, options = {}) {
  const rawUrl = options.url || process.env.WINMAP_PUSH_URL || "";
  const token = String(options.token || process.env.WINMAP_PUSH_TOKEN || "").trim();
  const pushConfig = options.pushConfig ? parsePushConfig(options.pushConfig) : null;
  const urlMode = pushConfig?.urlMode || "winmap";
  const { clean: url, fallback: urlFallback } = resolveImportUrls(rawUrl, { urlMode });

  const normalized = (points || []).map(normalizePoint).filter((p) => p.name);

  if (!normalized.length) {
    return { pushed: 0, failed: 0, mode: "none", results: [], message: "Không có điểm hợp lệ" };
  }

  if (!url) {
    console.log(`[points-push] Chưa cấu hình WINMAP_PUSH_URL — ${normalized.length} điểm (chế độ log)`);
    normalized.forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.name} | ${p.phone || "-"} | ${p.address || "-"}`);
    });
    return {
      pushed: normalized.length,
      failed: 0,
      mode: "log",
      results: normalized.map((p) => ({ ok: true, name: p.name })),
      message:
        "Đã ghi log server (chưa cấu hình site nhận). Lưu site + token trong panel bên dưới bảng kết quả."
    };
  }

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = pushConfig ? buildPushBody(normalized, pushConfig) : { points: normalized, source: "timdiemban" };
  const batchBody = JSON.stringify(payload);
  const method = pushConfig?.method === "PUT" ? "PUT" : "POST";

  let lastErr = null;
  let usedUrl = url;

  // Thử clean URL trước, nếu 404 thì fallback sang ?q= (Drupal không bật Clean URLs)
  for (const tryUrl of [url, urlFallback]) {
    if (!tryUrl) continue;
    try {
      const { ok, status, data } = await tryPost(tryUrl, headers, batchBody, method);
      usedUrl = tryUrl;

      if (status === 404 && tryUrl === url && urlFallback) {
        console.log(`[points-push] ${tryUrl} → 404, thử fallback ${urlFallback}`);
        continue; // thử fallback
      }
      if (status === 403) {
        return {
          pushed: 0, failed: normalized.length, mode: "error", results: [],
          message: `403 Forbidden — token không khớp hoặc không có quyền. URL: ${tryUrl}`
        };
      }
      if (!ok) {
        lastErr = new Error(data.error || data.message || `HTTP ${status} từ ${tryUrl}`);
        break;
      }

      const pushed = data.pushed ?? data.count ?? normalized.length;
      const failed = data.failed ?? 0;
      return {
        pushed, failed, mode: "webhook", usedUrl,
        results: data.results || normalized.map((p) => ({ ok: true, name: p.name })),
        message: data.message || `Đã gửi ${pushed} điểm`
      };
    } catch (err) {
      lastErr = err;
      console.log(`[points-push] ${tryUrl} lỗi kết nối: ${err.message}`);
    }
  }

  // Nếu batch thất bại, thử gửi từng điểm một
  return pushPointsOneByOne(usedUrl, token, normalized, pushConfig);
}

async function pushPointsOneByOne(url, token, points, pushConfig) {
  const results = [];
  let pushed = 0;
  let failed = 0;

  const method = pushConfig?.method === "PUT" ? "PUT" : "POST";
  const cfg = pushConfig ? parsePushConfig(pushConfig) : null;

  for (const point of points) {
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const body = cfg
        ? { ...buildPushBody([point], cfg)[cfg.pointsKey][0], ...(cfg.sourceTag ? { source: cfg.sourceTag } : {}) }
        : { ...point, source: "timdiemban" };
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
      pushed++;
      results.push({ ok: true, name: point.name });
    } catch (err) {
      failed++;
      results.push({ ok: false, name: point.name, error: err.message });
    }
  }

  return {
    pushed,
    failed,
    mode: "webhook-single",
    results,
    message: failed ? `Gửi ${pushed}/${points.length} điểm (${failed} lỗi)` : `Đã gửi ${pushed} điểm`
  };
}

function normalizePoint(row) {
  return {
    name: String(row.name || "").trim(),
    address: String(row.address || "").trim(),
    phone: String(row.phone || "").trim(),
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    rating: row.rating != null ? String(row.rating) : "",
    reviews: row.reviews != null ? String(row.reviews) : "",
    mapsUrl: row.mapsUrl || row.href || "",
    googlePlaceId: row.googlePlaceId || row.placeId || "",
    category: row.category || "",
    website: row.website || "",
    distanceKm: row.distanceKm ?? null
  };
}

module.exports = { pushPointsExternal, normalizePoint, resolveImportUrl, resolveImportUrls };
