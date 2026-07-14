/**
 * CMS tin tức — categories, posts, SEO helpers.
 */
const crypto = require("crypto");
const { getPool } = require("./db");

function pool() {
  return getPool();
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Chuẩn hóa shortcode WordPress [caption] và artifact dán từ Sheets. */
function normalizeWpHtml(html) {
  let s = String(html || "");
  if (!s) return "";
  s = s.replace(/\[caption([^\]]*)\]([\s\S]*?)\[\/caption\]/gi, (_, attrs, inner) => {
    const widthMatch = String(attrs).match(/\bwidth=["']?(\d+)/i);
    const alignMatch = String(attrs).match(/\balign=["']?([a-z0-9_-]+)/i);
    const width = widthMatch ? widthMatch[1] : "";
    const align = alignMatch ? alignMatch[1] : "alignnone";
    const imgMatch = inner.match(/<img\b[^>]*>/i);
    const img = imgMatch ? imgMatch[0] : "";
    const caption = inner
      .replace(/<img\b[^>]*>/i, "")
      .replace(/<\/?a\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    const style = width ? ` style="max-width:${width}px"` : "";
    const cap = caption ? `<figcaption class="wp-caption-text">${caption}</figcaption>` : "";
    return `<figure class="wp-caption ${align}"${style}>${img}${cap}</figure>`;
  });
  s = s.replace(/<span[^>]*data-sheets-root[^>]*>([\s\S]*?)<\/span>/gi, "$1");
  s = s.replace(/\sdata-sheets-[a-z-]+="[^"]*"/gi, "");
  s = s.replace(/\[\/?caption[^\]]*\]/gi, "");
  return s;
}

/** Khôi phục HTML bị middleware cũ strip ký tự <> (vd: h2Title/h2 → <h2>Title</h2>). */
function restoreStrippedHtml(text) {
  let s = String(text || "");
  if (!s || /[<>]/.test(s)) return s;
  // Tag dài trước; không khớp giữa từ (tránh "p" trong "Findmap")
  const tags = ["blockquote", "strong", "h2", "h3", "h4", "h1", "ul", "ol", "li", "div", "em", "p"];
  for (const tag of tags) {
    const re = new RegExp(`(^|[^a-z0-9])${tag}([\\s\\S]*?)/${tag}(?![a-z0-9])`, "gi");
    s = s.replace(re, (_, pre, inner) => `${pre}<${tag}>${String(inner).trim()}</${tag}>`);
  }
  return s;
}

function looksLikeStrippedHtml(html) {
  const s = String(html || "");
  if (!s || /[<>]/.test(s)) return false;
  return /(?:h[1-6]|p|strong|em|ul|ol|li)\S[\s\S]*?\/(?:h[1-6]|p|strong|em|ul|ol|li)/i.test(s);
}

const DEFAULT_GUIDE_HTML = `
          <h2>Findmap làm gì?</h2>
          <p>Findmap giúp đội bán hàng tìm điểm bán trên Google Maps theo khu vực, gom kết quả về một bảng, trừ điểm sử dụng rõ ràng và xuất Excel hoặc gửi sang hệ thống ngoài khi đã cấu hình.</p>
          <h2>4 bước để chạy lần đầu</h2>
          <h3>1. Đăng nhập &amp; nhận điểm sử dụng</h3>
          <p>Đăng nhập tài khoản Findmap. Điểm (credit) được cấp theo gói — mỗi điểm bán có số điện thoại sẽ trừ theo cấu hình hệ thống.</p>
          <h3>2. Cài tiện ích Chrome</h3>
          <p>Cài extension Findmap, mở lại tiện ích rồi vào trang làm việc để đồng bộ phiên đăng nhập.</p>
          <h3>3. Chọn khu vực tìm kiếm</h3>
          <p>Chọn tâm tìm, bán kính và từ khóa (ví dụ: quán cà phê, cửa hàng mẹ và bé).</p>
          <h3>4. Giữ Google Maps mở khi đang chạy</h3>
          <p>Hệ thống lấy dữ liệu trên Maps. Kết quả hiện trên bảng Findmap — lọc, xuất Excel hoặc gửi về site đã cấu hình.</p>
          <h2>Tiếp theo</h2>
          <p>Vào <strong>Cấu hình site</strong> nếu cần gửi danh sách sang Winmap hoặc webhook API khác. Quản trị viên dùng CMS để đăng hướng dẫn và tin sản phẩm tại mục Tin tức.</p>
        `;

async function repairStrippedPostContent() {
  const [rows] = await pool().execute(`SELECT id, slug, content_html FROM posts`);
  for (const row of rows) {
    const html = String(row.content_html || "");
    if (!looksLikeStrippedHtml(html)) continue;
    const fixed =
      /bat-dau-voi-findmap/i.test(row.slug || "") || /Findmap làm gì/i.test(html)
        ? DEFAULT_GUIDE_HTML.trim()
        : restoreStrippedHtml(html);
    if (fixed && fixed !== html) {
      await pool().execute(`UPDATE posts SET content_html = ? WHERE id = ?`, [fixed, row.id]);
    }
  }
}

function wordCount(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function parseSecondaryKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map((k) => String(k || "").trim()).filter(Boolean);
  }
  return String(raw || "")
    .split(/[,;\n]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  const h = String(haystack || "").toLowerCase();
  const n = String(needle).toLowerCase();
  if (!n) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = h.indexOf(n, idx)) !== -1) {
    count += 1;
    idx += n.length;
  }
  return count;
}

function introText(content, maxWords = 50) {
  const words = String(content || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

/** Bỏ dấu tiếng Việt để so khớp từ khóa linh hoạt hơn. */
function foldVi(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase();
}

function containsKeyword(haystack, keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return false;
  const h = String(haystack || "");
  if (h.toLowerCase().includes(kw.toLowerCase())) return true;
  return foldVi(h).includes(foldVi(kw));
}

function isInternalHref(href, appOrigin) {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw) || /^mailto:/i.test(raw)) {
    return false;
  }
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return true;
  const origin = String(appOrigin || "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!origin) return false;
  try {
    const u = new URL(raw, origin);
    const o = new URL(origin);
    return u.host === o.host;
  } catch {
    return false;
  }
}

/**
 * Điểm SEO kiểu Yoast: mỗi check có điểm 0–weight (partial), rồi quy về 0–100.
 */
function computeSeoScore(post, opts = {}) {
  const appOrigin = opts.appOrigin || post.appOrigin || "";
  const title = String(post.seo_title || post.title || "").trim();
  const meta = String(post.seo_description || post.excerpt || "").trim();
  const slug = String(post.slug || "").trim();
  const focus = String(post.focus_keyword || "").trim();
  const secondary = parseSecondaryKeywords(post.secondary_keywords);
  const content = stripHtml(post.content_html || "");
  const words = wordCount(content);
  const html = String(post.content_html || "");
  const intro = introText(content, 50);

  const checks = [];

  function addCheck({ id, group, label, score, weight, detail, severity = "error" }) {
    const w = Number(weight) || 0;
    const s = Math.max(0, Math.min(w, Number(score) || 0));
    const ratio = w ? s / w : 0;
    checks.push({
      id,
      group,
      label,
      weight: w,
      score: s,
      pass: ratio >= 0.85,
      partial: ratio > 0 && ratio < 0.85,
      detail,
      severity: ratio >= 0.85 ? "ok" : severity
    });
  }

  // —— Title length (Google ~50–60 ideal; 40–70 vẫn chấp nhận) ——
  const titleLen = title.length;
  let titleScore = 0;
  let titleDetail = `${titleLen} ký tự`;
  if (titleLen === 0) {
    titleDetail = "Chưa có tiêu đề SEO";
  } else if (titleLen >= 50 && titleLen <= 60) {
    titleScore = 10;
    titleDetail += " — lý tưởng";
  } else if (titleLen >= 40 && titleLen <= 70) {
    titleScore = 7;
    titleDetail += " — chấp nhận được (lý tưởng 50–60)";
  } else if (titleLen >= 30 && titleLen <= 80) {
    titleScore = 4;
    titleDetail += " — hơi lệch khuyến nghị";
  } else {
    titleScore = 1;
    titleDetail += " — quá ngắn/dài";
  }
  addCheck({
    id: "title_length",
    group: "title",
    label: "Độ dài tiêu đề SEO",
    score: titleScore,
    weight: 10,
    detail: titleDetail,
    severity: titleLen === 0 ? "error" : "warning"
  });

  // —— Meta length (120–160 ideal; 100–180 ok) ——
  const metaLen = meta.length;
  let metaScore = 0;
  let metaDetail = `${metaLen} ký tự`;
  if (metaLen === 0) {
    metaDetail = "Chưa có mô tả meta";
  } else if (metaLen >= 120 && metaLen <= 160) {
    metaScore = 10;
    metaDetail += " — lý tưởng";
  } else if (metaLen >= 100 && metaLen <= 180) {
    metaScore = 7;
    metaDetail += " — chấp nhận được (lý tưởng 120–160)";
  } else if (metaLen >= 70 && metaLen <= 200) {
    metaScore = 4;
    metaDetail += " — hơi lệch khuyến nghị";
  } else {
    metaScore = 1;
    metaDetail += " — quá ngắn/dài";
  }
  addCheck({
    id: "meta_length",
    group: "meta",
    label: "Độ dài mô tả meta",
    score: metaScore,
    weight: 10,
    detail: metaDetail,
    severity: metaLen === 0 ? "error" : "warning"
  });

  // —— Focus keyword ——
  if (focus) {
    const inTitle = containsKeyword(title, focus);
    const inMeta = containsKeyword(meta, focus);
    const inSlug = slug.includes(slugify(focus)) || containsKeyword(slug.replace(/-/g, " "), focus);
    const inIntro = containsKeyword(intro, focus);
    const inBody = containsKeyword(content, focus);

    addCheck({
      id: "focus_title",
      group: "keywords",
      label: "Từ khóa chính trong tiêu đề",
      score: inTitle ? 12 : 0,
      weight: 12,
      detail: inTitle ? "Có" : "Thiếu"
    });
    addCheck({
      id: "focus_slug",
      group: "keywords",
      label: "Từ khóa chính trong slug",
      score: inSlug ? 8 : 0,
      weight: 8,
      detail: inSlug ? "Có" : "Thiếu"
    });
    addCheck({
      id: "focus_meta",
      group: "keywords",
      label: "Từ khóa chính trong mô tả meta",
      score: inMeta ? 10 : 0,
      weight: 10,
      detail: inMeta ? "Có" : "Thiếu"
    });
    addCheck({
      id: "focus_intro",
      group: "keywords",
      label: "Từ khóa chính trong đoạn mở đầu",
      score: inIntro ? 8 : 0,
      weight: 8,
      detail: inIntro ? "Có" : "Thiếu"
    });
    addCheck({
      id: "focus_body",
      group: "keywords",
      label: "Từ khóa chính trong nội dung",
      score: inBody ? 10 : 0,
      weight: 10,
      detail: inBody ? "Có" : "Thiếu"
    });

    const focusHits = Math.max(
      countOccurrences(foldVi(content), foldVi(focus)),
      countOccurrences(content.toLowerCase(), focus.toLowerCase())
    );
    const density = words > 0 ? (focusHits / words) * 100 : 0;
    let densScore = 0;
    let densDetail = `${density.toFixed(1)}% (${focusHits} lần)`;
    if (focusHits === 0) {
      densScore = 0;
      densDetail = "Chưa xuất hiện trong nội dung";
    } else if (density >= 0.5 && density <= 2.5) {
      densScore = 6;
      densDetail += " — tốt";
    } else if (density > 0 && density <= 3.5) {
      densScore = 4;
      densDetail += " — chấp nhận được";
    } else if (density > 3.5) {
      densScore = 1;
      densDetail += " — dens quá cao (nhồi từ khóa)";
    } else {
      densScore = 2;
      densDetail += " — hơi thấp";
    }
    addCheck({
      id: "keyword_density",
      group: "keywords",
      label: "Mật độ từ khóa chính",
      score: densScore,
      weight: 6,
      detail: densDetail,
      severity: "warning"
    });
  } else {
    addCheck({
      id: "focus_keyword",
      group: "keywords",
      label: "Đã đặt từ khóa chính",
      score: 0,
      weight: 12,
      detail: "Chưa đặt — điểm từ khóa sẽ thấp"
    });
    // Giữ khung trọng số ổn định khi chưa có focus (tránh nhảy điểm ảo)
    addCheck({
      id: "focus_placements",
      group: "keywords",
      label: "Từ khóa trong title/slug/meta/nội dung",
      score: 0,
      weight: 36,
      detail: "Cần đặt từ khóa chính trước",
      severity: "warning"
    });
    addCheck({
      id: "keyword_density",
      group: "keywords",
      label: "Mật độ từ khóa chính",
      score: 0,
      weight: 6,
      detail: "Chưa có từ khóa",
      severity: "warning"
    });
  }

  // —— Secondary keywords ——
  if (secondary.length) {
    const found = secondary.filter((kw) => containsKeyword(content, kw));
    const ratio = found.length / secondary.length;
    const secScore = found.length >= 1 ? Math.round(6 * Math.min(1, 0.5 + ratio * 0.5)) : 0;
    addCheck({
      id: "secondary_keywords",
      group: "keywords",
      label: "Từ khóa phụ trong nội dung",
      score: secScore,
      weight: 6,
      detail: found.length
        ? `${found.length}/${secondary.length}: ${found.slice(0, 3).join(", ")}`
        : `0/${secondary.length} xuất hiện`,
      severity: "warning"
    });
  } else {
    addCheck({
      id: "secondary_keywords",
      group: "keywords",
      label: "Từ khóa phụ trong nội dung",
      score: 2,
      weight: 6,
      detail: "Chưa đặt (không bắt buộc)",
      severity: "warning"
    });
  }

  // —— Content length ——
  let contentScore = 0;
  let contentDetail = `${words} từ`;
  if (words >= 900) {
    contentScore = 12;
    contentDetail += " — rất tốt";
  } else if (words >= 600) {
    contentScore = 12;
    contentDetail += " — tốt (≥ 600)";
  } else if (words >= 300) {
    contentScore = 10;
    contentDetail += " — đạt tối thiểu";
  } else if (words >= 150) {
    contentScore = 5;
    contentDetail += " — còn ngắn (cần ≥ 300)";
  } else if (words > 0) {
    contentScore = 2;
    contentDetail += " — quá ngắn";
  } else {
    contentDetail = "Chưa có nội dung";
  }
  addCheck({
    id: "content_length",
    group: "content",
    label: "Độ dài nội dung",
    score: contentScore,
    weight: 12,
    detail: contentDetail
  });

  // —— Headings ——
  const h2 = (html.match(/<h2\b/gi) || []).length;
  const h3 = (html.match(/<h3\b/gi) || []).length;
  let headScore = 0;
  let headDetail = `H2: ${h2}, H3: ${h3}`;
  if (h2 >= 1 && h3 >= 1) {
    headScore = 6;
    headDetail += " — tốt";
  } else if (h2 >= 1 || h3 >= 1) {
    headScore = 4;
    headDetail += " — nên có cả H2 và H3";
  } else {
    headDetail = "Thiếu H2/H3";
  }
  addCheck({
    id: "headings",
    group: "content",
    label: "Tiêu đề phụ H2/H3",
    score: headScore,
    weight: 6,
    detail: headDetail
  });

  // —— Images ——
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const imgsWithAlt = imgs.filter((tag) => /\balt\s*=\s*["'][^"']+["']/i.test(tag));
  let imgScore = 0;
  let imgDetail = "";
  if (imgs.length === 0) {
    imgScore = 1;
    imgDetail = "Chưa có ảnh trong bài";
  } else if (imgsWithAlt.length === imgs.length) {
    imgScore = 5;
    imgDetail = `${imgs.length} ảnh, đủ alt`;
  } else if (imgsWithAlt.length > 0) {
    imgScore = 3;
    imgDetail = `${imgsWithAlt.length}/${imgs.length} ảnh có alt`;
  } else {
    imgScore = 1;
    imgDetail = `${imgs.length} ảnh nhưng thiếu alt`;
  }
  addCheck({
    id: "img_alt",
    group: "media",
    label: "Ảnh trong bài + alt",
    score: imgScore,
    weight: 5,
    detail: imgDetail,
    severity: "warning"
  });

  // —— Links ——
  const anchors = html.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi) || [];
  let internalLinks = 0;
  let externalLinks = 0;
  for (const tag of anchors) {
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    const href = m[1].trim();
    if (!href || href.startsWith("#") || /^javascript:/i.test(href) || /^mailto:/i.test(href)) {
      continue;
    }
    if (isInternalHref(href, appOrigin)) internalLinks += 1;
    else if (/^https?:\/\//i.test(href)) externalLinks += 1;
  }
  addCheck({
    id: "internal_links",
    group: "links",
    label: "Liên kết nội bộ",
    score: internalLinks >= 1 ? 4 : 0,
    weight: 4,
    detail: internalLinks ? `${internalLinks} liên kết nội bộ` : "Thiếu (dùng /tin-tuc/... hoặc domain site)",
    severity: "warning"
  });
  addCheck({
    id: "external_links",
    group: "links",
    label: "Liên kết ngoài",
    score: externalLinks >= 1 ? 3 : 1,
    weight: 3,
    detail: externalLinks ? `${externalLinks} liên kết ngoài` : "Chưa có (không bắt buộc)",
    severity: "warning"
  });

  // —— OG / cover ——
  addCheck({
    id: "og_image",
    group: "social",
    label: "Ảnh đại diện / OG",
    score: post.cover_image || post.og_image ? 6 : 0,
    weight: 6,
    detail: post.cover_image || post.og_image ? "Có" : "Thiếu"
  });

  // —— Excerpt ——
  const excerptOk = Boolean(String(post.excerpt || "").trim());
  addCheck({
    id: "excerpt",
    group: "content",
    label: "Tóm tắt (excerpt)",
    score: excerptOk ? 4 : 0,
    weight: 4,
    detail: excerptOk ? "Có" : "Thiếu",
    severity: "warning"
  });

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const earned = checks.reduce((s, c) => s + c.score, 0);
  const score = Math.round((earned / totalWeight) * 100);

  let grade = "Kém";
  if (score >= 85) grade = "Tốt";
  else if (score >= 65) grade = "Khá";
  else if (score >= 45) grade = "Trung bình";

  const groups = {};
  for (const c of checks) {
    if (!groups[c.group]) {
      groups[c.group] = { pass: 0, fail: 0, partial: 0, weight: 0, earned: 0, checks: [] };
    }
    const g = groups[c.group];
    g.checks.push(c);
    g.weight += c.weight;
    g.earned += c.score;
    if (c.pass) g.pass += 1;
    else if (c.partial) g.partial += 1;
    else g.fail += 1;
  }
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    g.score = g.weight ? Math.round((g.earned / g.weight) * 100) : 0;
  }

  return { score, grade, checks, wordCount: words, groups, totalWeight, earned: Math.round(earned) };
}

async function migrateCmsColumns() {
  const alters = [
    `ALTER TABLE posts ADD COLUMN secondary_keywords TEXT DEFAULT NULL`,
    `ALTER TABLE posts ADD COLUMN trashed_at VARCHAR(64) DEFAULT NULL`,
    `ALTER TABLE posts ADD COLUMN url_path VARCHAR(120) NOT NULL DEFAULT 'tin-tuc'`,
    `ALTER TABLE posts ADD COLUMN google_seo_score INT DEFAULT NULL`,
    `ALTER TABLE posts ADD COLUMN google_performance_score INT DEFAULT NULL`,
    `ALTER TABLE posts ADD COLUMN google_psi_json MEDIUMTEXT DEFAULT NULL`,
    `ALTER TABLE posts ADD COLUMN google_psi_checked_at VARCHAR(64) DEFAULT NULL`
  ];
  for (const sql of alters) {
    try {
      await pool().execute(sql);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const code = err && err.code;
      if (code === "ER_DUP_FIELDNAME" || /Duplicate column/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }
}

/** Đảm bảo author_id trỏ cms_users (không còn FK sang users hệ tìm kiếm). */
async function repairCmsAuthorFk() {
  try {
    await pool().execute(`ALTER TABLE posts DROP FOREIGN KEY fk_post_author`);
  } catch (err) {
    if (!/check that.*exists|Unknown.*CONSTRAINT|ER_CANT_DROP/i.test(String(err.message || err))) {
      /* ignore missing */
    }
  }
  try {
    await pool().execute(`
      ALTER TABLE posts
      ADD CONSTRAINT fk_post_author FOREIGN KEY (author_id) REFERENCES cms_users(id) ON DELETE SET NULL
    `);
  } catch (err) {
    if (!/Duplicate|already exists|ER_DUP_KEY|ER_FK_DUP_NAME/i.test(String(err.message || err))) {
      // Có thể đã đúng FK — bỏ qua
    }
  }
}

async function ensureCmsTables() {
  const conn = await pool().getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS post_categories (
        id          VARCHAR(64)  NOT NULL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        slug        VARCHAR(180) NOT NULL,
        description TEXT         DEFAULT NULL,
        created_at  VARCHAR(64)  NOT NULL,
        UNIQUE KEY uq_cat_slug (slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS posts (
        id               VARCHAR(64)  NOT NULL PRIMARY KEY,
        title            VARCHAR(500) NOT NULL,
        slug             VARCHAR(180) NOT NULL,
        excerpt          TEXT         DEFAULT NULL,
        content_html     MEDIUMTEXT   NOT NULL,
        cover_image      TEXT         DEFAULT NULL,
        category_id      VARCHAR(64)  DEFAULT NULL,
        author_id        VARCHAR(64)  DEFAULT NULL,
        status           VARCHAR(20)  NOT NULL DEFAULT 'draft',
        published_at     VARCHAR(64)  DEFAULT NULL,
        seo_title        VARCHAR(255) DEFAULT NULL,
        seo_description  TEXT         DEFAULT NULL,
        focus_keyword    VARCHAR(255) DEFAULT NULL,
        og_image         TEXT         DEFAULT NULL,
        canonical_url    VARCHAR(500) DEFAULT NULL,
        noindex          TINYINT      NOT NULL DEFAULT 0,
        seo_score        INT          NOT NULL DEFAULT 0,
        view_count       INT          NOT NULL DEFAULT 0,
        created_at       VARCHAR(64)  NOT NULL,
        updated_at       VARCHAR(64)  NOT NULL,
        UNIQUE KEY uq_post_slug (slug),
        KEY idx_post_status (status),
        KEY idx_post_category (category_id),
        KEY idx_post_published (published_at),
        CONSTRAINT fk_post_category FOREIGN KEY (category_id) REFERENCES post_categories(id) ON DELETE SET NULL,
        CONSTRAINT fk_post_author FOREIGN KEY (author_id) REFERENCES cms_users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } finally {
    conn.release();
  }

  await migrateCmsColumns();
  await repairCmsAuthorFk();
  await repairStrippedPostContent();

  const [cats] = await pool().execute("SELECT COUNT(*) AS c FROM post_categories");
  if (Number(cats[0].c) === 0) {
    const defaults = [
      { name: "Hướng dẫn", slug: "huong-dan", description: "Cách dùng Findmap theo từng bước" },
      { name: "Tin sản phẩm", slug: "tin-san-pham", description: "Cập nhật tính năng Findmap" },
      { name: "Kinh nghiệm", slug: "kinh-nghiem", description: "Tips tìm điểm bán hiệu quả" }
    ];
    for (const c of defaults) {
      await createCategory(c);
    }
  }

  const [postCount] = await pool().execute("SELECT COUNT(*) AS c FROM posts");
  if (Number(postCount[0].c) === 0) {
    const [catRows] = await pool().execute(`SELECT id FROM post_categories WHERE slug = 'huong-dan' LIMIT 1`);
    const categoryId = catRows[0]?.id || null;
    await createPost(
      {
        title: "Bắt đầu với Findmap: 4 bước tìm điểm bán trên Google Maps",
        slug: "bat-dau-voi-findmap-4-buoc",
        excerpt:
          "Hướng dẫn nhanh: đăng nhập, cài tiện ích Chrome, chọn khu vực tìm kiếm và giữ Google Maps mở để gom danh sách điểm bán.",
        content_html: DEFAULT_GUIDE_HTML,
        category_id: categoryId,
        status: "published",
        focus_keyword: "tìm điểm bán google maps",
        seo_title: "Bắt đầu với Findmap — tìm điểm bán trên Google Maps",
        seo_description:
          "Hướng dẫn 4 bước dùng Findmap: đăng nhập, cài tiện ích Chrome, chọn khu vực và gom điểm bán từ Google Maps về một bảng."
      },
      null
    );
  }
}

function daysLeftInTrash(trashedAt, retentionDays = 30) {
  if (!trashedAt) return null;
  const t = new Date(trashedAt).getTime();
  if (Number.isNaN(t)) return null;
  const elapsedDays = Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
  return Math.max(0, retentionDays - elapsedDays);
}

/** Chuẩn hóa prefix URL: "" = gốc site, "tin-tuc" = /tin-tuc/... */
function normalizeUrlPath(raw) {
  let s = String(raw == null ? "tin-tuc" : raw).trim().toLowerCase();
  s = s.replace(/^\/+|\/+$/g, "");
  if (!s || s === "." || s === "root") return "";
  const parts = s
    .split("/")
    .map((p) => slugify(p))
    .filter(Boolean);
  return parts.join("/").slice(0, 120);
}

function publicPathForPost(post) {
  if (!post || !post.slug) return "/tin-tuc";
  const prefix = normalizeUrlPath(post.url_path != null ? post.url_path : "tin-tuc");
  const slug = String(post.slug);
  return prefix ? `/${prefix}/${slug}` : `/${slug}`;
}

function parseRequestPath(pathname) {
  const clean = String(pathname || "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");
  if (!clean) return null;
  const parts = clean.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (!parts.length) return null;
  const slug = parts[parts.length - 1];
  const urlPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return { slug, urlPath };
}

const RESERVED_ROOT_SLUGS = new Set([
  "api",
  "admin",
  "login",
  "cms",
  "tin-tuc",
  "gioi-thieu",
  "landing",
  "assets",
  "nap-diem",
  "cau-hinh-site",
  "quen-mat-khau",
  "dat-lai-mat-khau",
  "admin-post-article",
  "admin-post-editor",
  "admin-post-categories",
  "admin-post-seo",
  "admin-post-trash",
  "admin-post-media",
  "preview-bai-viet",
  "media",
  "login-admin",
  "login-admin-post",
  "robots.txt",
  "sitemap.xml",
  "favicon.ico"
]);

function isReservedRootSlug(slug) {
  return RESERVED_ROOT_SLUGS.has(String(slug || "").toLowerCase());
}

/**
 * Khớp pathname với bài viết theo slug + url_path.
 * publicOnly=true: chỉ published (SEO/redirect công khai).
 * publicOnly=false: cho phép preview nháp trong CMS.
 */
async function resolvePostPath(pathname, { publicOnly = true } = {}) {
  const parsed = parseRequestPath(pathname);
  if (!parsed || !parsed.slug) return null;
  if (!parsed.urlPath && isReservedRootSlug(parsed.slug)) return null;

  const post = await getPostBySlug(parsed.slug, { publicOnly });
  if (!post) return null;

  const canonicalPath = publicPathForPost(post);
  const requested =
    parsed.urlPath ? `/${parsed.urlPath}/${parsed.slug}` : `/${parsed.slug}`;
  if (requested !== canonicalPath) {
    return { post, canonicalPath, redirect: true };
  }
  return { post, canonicalPath, redirect: false };
}

async function resolvePublishedPath(pathname) {
  return resolvePostPath(pathname, { publicOnly: true });
}

/** Lấy src ảnh đầu tiên trong HTML nội dung (bỏ data: URI). */
function extractFirstImageSrc(html) {
  const s = String(html || "");
  const re = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = re.exec(s))) {
    const src = String(m[2] || "").trim();
    if (!src || /^data:/i.test(src)) continue;
    return src;
  }
  return "";
}

function resolveCoverImage(post) {
  const cover = String(post?.cover_image || "").trim();
  if (cover) return cover;
  return extractFirstImageSrc(post?.content_html || "");
}

function resolveCoverFromFields(coverImage, contentHtml, useFirstImage = true) {
  const cover = String(coverImage || "").trim();
  if (cover) return cover;
  if (!useFirstImage) return "";
  return extractFirstImageSrc(contentHtml || "");
}

function mapPost(row) {
  if (!row) return null;
  const status = row.status;
  const trashedAt = row.trashed_at || null;
  const urlPath = normalizeUrlPath(row.url_path != null ? row.url_path : "tin-tuc");
  const contentHtml = normalizeWpHtml(row.content_html || "");
  const coverStored = row.cover_image || "";
  const mapped = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    url_path: urlPath,
    path: publicPathForPost({ slug: row.slug, url_path: urlPath }),
    excerpt: row.excerpt || "",
    content_html: contentHtml,
    cover_image: coverStored,
    cover_image_resolved: coverStored || extractFirstImageSrc(contentHtml) || "",
    category_id: row.category_id || null,
    category_name: row.category_name || null,
    category_slug: row.category_slug || null,
    author_id: row.author_id || null,
    author_email: row.author_email || null,
    status,
    published_at: row.published_at || null,
    seo_title: row.seo_title || "",
    seo_description: row.seo_description || "",
    focus_keyword: row.focus_keyword || "",
    secondary_keywords: row.secondary_keywords || "",
    og_image: row.og_image || "",
    canonical_url: row.canonical_url || "",
    noindex: Boolean(row.noindex),
    seo_score: Number(row.seo_score || 0),
    google_seo_score: row.google_seo_score == null ? null : Number(row.google_seo_score),
    google_performance_score:
      row.google_performance_score == null ? null : Number(row.google_performance_score),
    google_psi_json: row.google_psi_json || null,
    google_psi_checked_at: row.google_psi_checked_at || null,
    view_count: Number(row.view_count || 0),
    trashed_at: trashedAt,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (status === "trash" && trashedAt) {
    mapped.daysLeft = daysLeftInTrash(trashedAt, 30);
  }
  return mapped;
}

async function listCategories() {
  const [rows] = await pool().execute(
    `SELECT c.*,
      (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id AND p.status != 'trash') AS post_count
     FROM post_categories c
     ORDER BY c.name ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description || "",
    post_count: Number(r.post_count || 0),
    created_at: r.created_at
  }));
}

async function createCategory({ name, slug, description }) {
  const id = crypto.randomBytes(12).toString("hex");
  const s = slugify(slug || name);
  if (!name || !s) throw new Error("Thiếu tên hoặc slug danh mục");
  const now = nowIso();
  await pool().execute(
    `INSERT INTO post_categories (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, String(name).trim(), s, description ? String(description).trim() : null, now]
  );
  return { id, name: String(name).trim(), slug: s, description: description || "", created_at: now };
}

async function updateCategory(id, { name, slug, description }) {
  const s = slugify(slug || name);
  await pool().execute(
    `UPDATE post_categories SET name = ?, slug = ?, description = ? WHERE id = ?`,
    [String(name).trim(), s, description ? String(description).trim() : null, id]
  );
  return getCategory(id);
}

async function getCategory(id) {
  const [rows] = await pool().execute(`SELECT * FROM post_categories WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function deleteCategory(id) {
  await pool().execute(`UPDATE posts SET category_id = NULL WHERE category_id = ?`, [id]);
  await pool().execute(`DELETE FROM post_categories WHERE id = ?`, [id]);
}

const POST_SELECT = `
  SELECT p.*,
    c.name AS category_name,
    c.slug AS category_slug,
    u.email AS author_email
  FROM posts p
  LEFT JOIN post_categories c ON c.id = p.category_id
  LEFT JOIN cms_users u ON u.id = p.author_id
`;

async function listPosts({ status, categoryId, q, limit = 50, offset = 0, publicOnly = false } = {}) {
  const where = [];
  const params = [];
  if (publicOnly) {
    where.push(`p.status = 'published'`);
  } else if (status === "trash") {
    where.push(`p.status = 'trash'`);
  } else if (status && status !== "all") {
    where.push(`p.status = ?`);
    params.push(status);
  } else {
    // status === 'all' or unset: exclude trash
    where.push(`p.status != 'trash'`);
  }
  if (categoryId) {
    where.push(`p.category_id = ?`);
    params.push(categoryId);
  }
  if (q) {
    where.push(`(p.title LIKE ? OR p.excerpt LIKE ? OR p.focus_keyword LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = publicOnly
    ? `ORDER BY COALESCE(p.published_at, p.created_at) DESC`
    : `ORDER BY p.updated_at DESC`;

  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const [countRows] = await pool().execute(
    `SELECT COUNT(*) AS total FROM posts p ${sqlWhere}`,
    params
  );
  const [rows] = await pool().execute(
    `${POST_SELECT} ${sqlWhere} ${order} LIMIT ${lim} OFFSET ${off}`,
    params
  );
  return {
    total: Number(countRows[0].total || 0),
    posts: rows.map(mapPost)
  };
}

async function getPostById(id) {
  const [rows] = await pool().execute(`${POST_SELECT} WHERE p.id = ?`, [id]);
  return mapPost(rows[0]);
}

async function getPostBySlug(slug, { publicOnly = false } = {}) {
  const extra = publicOnly ? ` AND p.status = 'published'` : "";
  const [rows] = await pool().execute(`${POST_SELECT} WHERE p.slug = ?${extra}`, [slug]);
  return mapPost(rows[0]);
}

async function ensureUniqueSlug(base, excludeId = null) {
  let slug = slugify(base) || `bai-viet-${Date.now()}`;
  let n = 0;
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const [rows] = await pool().execute(
      excludeId
        ? `SELECT id FROM posts WHERE slug = ? AND id != ? LIMIT 1`
        : `SELECT id FROM posts WHERE slug = ? LIMIT 1`,
      excludeId ? [candidate, excludeId] : [candidate]
    );
    if (!rows.length) return candidate;
    n += 1;
  }
}

function normalizeSecondaryKeywords(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const joined = raw.map((k) => String(k || "").trim()).filter(Boolean).join(", ");
    return joined || null;
  }
  const s = String(raw).trim();
  return s || null;
}

async function createPost(data, authorId, opts = {}) {
  const id = crypto.randomBytes(12).toString("hex");
  const now = nowIso();
  const status = ["draft", "published", "hidden"].includes(data.status) ? data.status : "draft";
  const slug = await ensureUniqueSlug(data.slug || data.title);
  const urlPath = normalizeUrlPath(data.url_path != null ? data.url_path : "tin-tuc");
  if (!urlPath && isReservedRootSlug(slug)) {
    throw new Error(`Slug "${slug}" trùng đường dẫn hệ thống — chọn slug khác hoặc dùng prefix /tin-tuc/`);
  }
  const publishedAt = status === "published" ? data.published_at || now : null;
  const secondaryKeywords = normalizeSecondaryKeywords(data.secondary_keywords);
  const draft = {
    ...data,
    title: String(data.title || "").trim() || "Bài viết chưa đặt tên",
    slug,
    url_path: urlPath,
    content_html: data.content_html || "",
    status,
    published_at: publishedAt,
    secondary_keywords: secondaryKeywords || ""
  };
  draft.content_html = normalizeWpHtml(draft.content_html);
  // Chỉ lưu ảnh đại diện khi user chọn rõ — không tự ghi ảnh đầu trong bài vào DB
  const coverImage = String(data.cover_image || "").trim() || null;
  draft.cover_image = coverImage || "";
  const seo = computeSeoScore(draft, { appOrigin: opts.appOrigin });

  await pool().execute(
    `INSERT INTO posts (
      id, title, slug, excerpt, content_html, cover_image, category_id, author_id,
      status, published_at, seo_title, seo_description, focus_keyword, secondary_keywords,
      url_path, og_image, canonical_url, noindex, seo_score, view_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      draft.title,
      slug,
      data.excerpt || null,
      draft.content_html,
      coverImage,
      data.category_id || null,
      authorId || null,
      status,
      publishedAt,
      data.seo_title || null,
      data.seo_description || null,
      data.focus_keyword || null,
      secondaryKeywords,
      urlPath,
      data.og_image || null,
      data.canonical_url || null,
      data.noindex ? 1 : 0,
      seo.score,
      now,
      now
    ]
  );
  return getPostById(id);
}

async function updatePost(id, data, opts = {}) {
  const existing = await getPostById(id);
  if (!existing) throw new Error("Không tìm thấy bài viết");
  if (existing.status === "trash") {
    throw new Error("Khôi phục bài từ thùng rác trước khi chỉnh sửa");
  }

  const status = ["draft", "published", "hidden"].includes(data.status) ? data.status : existing.status;
  let publishedAt = existing.published_at;
  if (status === "published" && !publishedAt) publishedAt = nowIso();
  if (status !== "published" && data.clear_published) publishedAt = null;
  if (status === "hidden" || status === "draft") {
    /* keep published_at for history unless explicitly cleared */
  }

  const slug = await ensureUniqueSlug(data.slug || existing.slug, id);
  const urlPath =
    data.url_path !== undefined
      ? normalizeUrlPath(data.url_path)
      : normalizeUrlPath(existing.url_path);
  if (!urlPath && isReservedRootSlug(slug)) {
    throw new Error(`Slug "${slug}" trùng đường dẫn hệ thống — chọn slug khác hoặc dùng prefix /tin-tuc/`);
  }
  const secondaryKeywords =
    data.secondary_keywords !== undefined
      ? normalizeSecondaryKeywords(data.secondary_keywords)
      : existing.secondary_keywords || null;
  const merged = {
    ...existing,
    ...data,
    title: String(data.title != null ? data.title : existing.title).trim(),
    slug,
    url_path: urlPath,
    status,
    published_at: publishedAt,
    content_html:
      data.content_html != null ? normalizeWpHtml(data.content_html) : existing.content_html,
    secondary_keywords: secondaryKeywords || ""
  };
  // Chỉ cập nhật ảnh đại diện khi gửi rõ — không tự lấy ảnh trong bài để lưu
  if (data.cover_image !== undefined) {
    merged.cover_image = String(data.cover_image || "").trim();
  } else {
    merged.cover_image = existing.cover_image || "";
  }
  const seo = computeSeoScore(merged, { appOrigin: opts.appOrigin });
  const now = nowIso();

  await pool().execute(
    `UPDATE posts SET
      title = ?, slug = ?, excerpt = ?, content_html = ?, cover_image = ?, category_id = ?,
      status = ?, published_at = ?, seo_title = ?, seo_description = ?, focus_keyword = ?,
      secondary_keywords = ?, url_path = ?, og_image = ?, canonical_url = ?, noindex = ?, seo_score = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.title,
      slug,
      merged.excerpt || null,
      merged.content_html || "",
      merged.cover_image || null,
      merged.category_id || null,
      status,
      publishedAt,
      merged.seo_title || null,
      merged.seo_description || null,
      merged.focus_keyword || null,
      secondaryKeywords,
      urlPath,
      merged.og_image || null,
      merged.canonical_url || null,
      merged.noindex ? 1 : 0,
      seo.score,
      now,
      id
    ]
  );
  return getPostById(id);
}

async function duplicatePost(id, authorId, opts = {}) {
  const existing = await getPostById(id);
  if (!existing) throw new Error("Không tìm thấy bài viết");
  if (existing.status === "trash") {
    throw new Error("Khôi phục bài từ thùng rác trước khi nhân đôi");
  }
  const baseTitle = String(existing.title || "Bài viết").trim() || "Bài viết";
  const copyTitle = / \(bản sao( \d+)?\)$/i.test(baseTitle)
    ? baseTitle.replace(/ \(bản sao( \d+)?\)$/i, "") + " (bản sao)"
    : `${baseTitle} (bản sao)`;
  return createPost(
    {
      title: copyTitle,
      slug: "",
      url_path: existing.url_path,
      excerpt: existing.excerpt,
      content_html: existing.content_html,
      cover_image: existing.cover_image,
      category_id: existing.category_id,
      status: "draft",
      seo_title: existing.seo_title,
      seo_description: existing.seo_description,
      focus_keyword: existing.focus_keyword,
      secondary_keywords: existing.secondary_keywords,
      og_image: existing.og_image,
      canonical_url: "",
      noindex: existing.noindex
    },
    authorId,
    opts
  );
}

async function moveToTrash(id) {
  const existing = await getPostById(id);
  if (!existing) throw new Error("Không tìm thấy bài viết");
  if (existing.status === "trash") return existing;
  const now = nowIso();
  await pool().execute(
    `UPDATE posts SET status = 'trash', trashed_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, id]
  );
  return getPostById(id);
}

async function restoreFromTrash(id) {
  const existing = await getPostById(id);
  if (!existing) throw new Error("Không tìm thấy bài viết");
  if (existing.status !== "trash") {
    throw new Error("Bài viết không nằm trong thùng rác");
  }
  const now = nowIso();
  await pool().execute(
    `UPDATE posts SET status = 'draft', trashed_at = NULL, updated_at = ? WHERE id = ?`,
    [now, id]
  );
  return getPostById(id);
}

async function deletePostPermanent(id) {
  const existing = await getPostById(id);
  if (!existing) throw new Error("Không tìm thấy bài viết");
  if (existing.status !== "trash") {
    throw new Error("Chỉ xóa vĩnh viễn bài viết trong thùng rác");
  }
  await pool().execute(`DELETE FROM posts WHERE id = ?`, [id]);
  return true;
}

async function purgeTrashOlderThan(days = 30) {
  const retention = Math.max(Number(days) || 30, 1);
  const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000).toISOString();
  const [result] = await pool().execute(
    `DELETE FROM posts WHERE status = 'trash' AND trashed_at IS NOT NULL AND trashed_at < ?`,
    [cutoff]
  );
  return { deleted: result.affectedRows || 0, olderThanDays: retention };
}

async function setPostStatus(id, status) {
  if (!["draft", "published", "hidden"].includes(status)) {
    throw new Error("Trạng thái không hợp lệ");
  }
  const existing = await getPostById(id);
  if (!existing) throw new Error("Không tìm thấy bài viết");
  const now = nowIso();
  let publishedAt = existing.published_at;
  if (status === "published" && !publishedAt) publishedAt = now;
  await pool().execute(
    `UPDATE posts SET status = ?, published_at = ?, updated_at = ? WHERE id = ?`,
    [status, publishedAt, now, id]
  );
  return getPostById(id);
}

async function incrementView(id) {
  await pool().execute(`UPDATE posts SET view_count = view_count + 1 WHERE id = ?`, [id]);
}

/** Lưu kết quả PageSpeed Insights (điểm Google Lighthouse). */
async function saveGooglePsiResult(id, psi) {
  const checkedAt = psi.fetchedAt || new Date().toISOString();
  const { summarizeForStorage } = require("./google-psi");
  const json = summarizeForStorage(psi);
  await pool().execute(
    `UPDATE posts SET
      google_seo_score = ?,
      google_performance_score = ?,
      google_psi_json = ?,
      google_psi_checked_at = ?,
      updated_at = ?
     WHERE id = ?`,
    [
      psi.seo == null ? null : Number(psi.seo),
      psi.performance == null ? null : Number(psi.performance),
      json,
      checkedAt,
      nowIso(),
      id
    ]
  );
  return getPostById(id);
}

async function listPublishedForSitemap() {
  const [rows] = await pool().execute(
    `SELECT slug, url_path, updated_at, published_at
     FROM posts
     WHERE status = 'published' AND IFNULL(noindex, 0) = 0
     ORDER BY published_at DESC`
  );
  return rows.map((r) => ({
    slug: r.slug,
    url_path: normalizeUrlPath(r.url_path != null ? r.url_path : "tin-tuc"),
    path: publicPathForPost({
      slug: r.slug,
      url_path: r.url_path != null ? r.url_path : "tin-tuc"
    }),
    updated_at: r.updated_at,
    published_at: r.published_at
  }));
}

module.exports = {
  slugify,
  stripHtml,
  normalizeWpHtml,
  computeSeoScore,
  extractFirstImageSrc,
  resolveCoverImage,
  resolveCoverFromFields,
  normalizeUrlPath,
  publicPathForPost,
  resolvePublishedPath,
  resolvePostPath,
  isReservedRootSlug,
  ensureCmsTables,
  migrateCmsColumns,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategory,
  listPosts,
  getPostById,
  getPostBySlug,
  createPost,
  updatePost,
  duplicatePost,
  moveToTrash,
  restoreFromTrash,
  deletePostPermanent,
  purgeTrashOlderThan,
  setPostStatus,
  incrementView,
  saveGooglePsiResult,
  listPublishedForSitemap
};
