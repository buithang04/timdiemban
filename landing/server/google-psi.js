/**
 * google-psi.js — PageSpeed Insights API (Lighthouse trên server Google)
 * Điểm SEO/Performance lab; không phải điểm xếp hạng tìm kiếm.
 */
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function isLocalOrPrivateUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

function catScore(categories, key) {
  const raw = categories?.[key]?.score;
  if (raw == null || Number.isNaN(Number(raw))) return null;
  return Math.round(Number(raw) * 100);
}

function auditNum(audits, id) {
  const a = audits?.[id];
  if (!a || a.numericValue == null) return null;
  return Number(a.numericValue);
}

function failedSeoAudits(audits) {
  const out = [];
  for (const [id, a] of Object.entries(audits || {})) {
    if (!a || a.scoreDisplayMode === "informative" || a.scoreDisplayMode === "manual") continue;
    if (a.score == null) continue;
    if (Number(a.score) >= 0.9) continue;
    // Chỉ lấy audit thuộc nhóm SEO phổ biến / title trong lighthouseResult.categories.seo.auditRefs
    out.push({
      id,
      title: a.title || id,
      description: String(a.description || "")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .slice(0, 220),
      score: Math.round(Number(a.score) * 100)
    });
  }
  return out.slice(0, 12);
}

/**
 * @param {string} pageUrl
 * @param {{ apiKey?: string, strategy?: 'mobile'|'desktop' }} opts
 */
async function runPageSpeed(pageUrl, opts = {}) {
  const url = String(pageUrl || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("URL không hợp lệ để chấm PageSpeed");
  }
  if (isLocalOrPrivateUrl(url)) {
    const err = new Error(
      "PageSpeed Insights chạy từ máy Google — không chấm được localhost/IP nội bộ. Dùng NEWS_ORIGIN domain public (bài đã xuất bản)."
    );
    err.code = "PSI_LOCAL_URL";
    throw err;
  }

  const strategy = opts.strategy === "desktop" ? "desktop" : "mobile";
  const apiKey = String(opts.apiKey || process.env.PAGESPEED_API_KEY || "").trim();

  const endpoint = new URL(PSI_ENDPOINT);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  for (const cat of ["seo", "performance", "accessibility", "best-practices"]) {
    endpoint.searchParams.append("category", cat);
  }
  if (apiKey) endpoint.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let res;
  try {
    res = await fetch(endpoint.toString(), { signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("PageSpeed Insights timeout — thử lại sau");
    throw new Error(e.message || "Không gọi được PageSpeed Insights");
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.lighthouseResult?.runtimeError?.message ||
      `PageSpeed lỗi HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = "PSI_HTTP";
    err.status = res.status;
    throw err;
  }

  if (data.lighthouseResult?.runtimeError?.message) {
    throw new Error(data.lighthouseResult.runtimeError.message);
  }

  const lh = data.lighthouseResult || {};
  const cats = lh.categories || {};
  const audits = lh.audits || {};

  const seoAuditIds = new Set(
    (cats.seo?.auditRefs || []).map((r) => r.id).filter(Boolean)
  );
  const seoFails = failedSeoAudits(audits).filter((a) => seoAuditIds.has(a.id) || seoAuditIds.size === 0);

  const field = data.loadingExperience?.metrics || null;

  return {
    url,
    strategy,
    seo: catScore(cats, "seo"),
    performance: catScore(cats, "performance"),
    accessibility: catScore(cats, "accessibility"),
    bestPractices: catScore(cats, "best-practices"),
    metrics: {
      lcpMs: auditNum(audits, "largest-contentful-paint"),
      cls: auditNum(audits, "cumulative-layout-shift"),
      inpMs: auditNum(audits, "interaction-to-next-paint") ?? auditNum(audits, "experimental-interaction-to-next-paint"),
      tbtMs: auditNum(audits, "total-blocking-time")
    },
    fieldMetrics: field
      ? {
          lcp: field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
          cls: field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ?? null,
          inp: field.INTERACTION_TO_NEXT_PAINT?.percentile ?? null
        }
      : null,
    seoAuditsFailed: seoFails.slice(0, 8),
    fetchedAt: new Date().toISOString(),
    lighthouseVersion: lh.lighthouseVersion || null
  };
}

function summarizeForStorage(result) {
  return JSON.stringify({
    strategy: result.strategy,
    accessibility: result.accessibility,
    bestPractices: result.bestPractices,
    metrics: result.metrics,
    fieldMetrics: result.fieldMetrics,
    seoAuditsFailed: result.seoAuditsFailed,
    lighthouseVersion: result.lighthouseVersion,
    url: result.url
  });
}

module.exports = {
  runPageSpeed,
  isLocalOrPrivateUrl,
  summarizeForStorage
};
