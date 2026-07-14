/**
 * CMS routes — public tin tức + admin CRUD / SEO / GSC settings.
 */
const express = require("express");
const fs = require("fs");
const multer = require("multer");
const XLSX = require("xlsx");
const cms = require("./cms-store");
const media = require("./cms-media");
const { runPageSpeed, isLocalOrPrivateUrl } = require("./google-psi");

media.ensureMediaDir();

function parseGooglePsi(post) {
  if (!post) return null;
  let detail = null;
  if (post.google_psi_json) {
    try {
      detail = JSON.parse(post.google_psi_json);
    } catch {
      detail = null;
    }
  }
  if (post.google_seo_score == null && !post.google_psi_checked_at) return null;
  return {
    seo: post.google_seo_score,
    performance: post.google_performance_score,
    checkedAt: post.google_psi_checked_at,
    ...(detail || {})
  };
}

async function runAndSaveGoogleScore(post, { getSetting, appOrigin }) {
  const origin = String(appOrigin || "").replace(/\/+$/, "");
  const path = post.path || cms.publicPathForPost(post);
  const pageUrl = post.canonical_url?.trim() || `${origin}${path}`;
  const apiKey =
    (await getSetting("pagespeed_api_key", "")) || process.env.PAGESPEED_API_KEY || "";
  const psi = await runPageSpeed(pageUrl, { apiKey, strategy: "mobile" });
  const saved = await cms.saveGooglePsiResult(post.id, psi);
  return { post: saved, google: { ...psi, checkedAt: psi.fetchedAt }, pageUrl };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      media.ensureMediaDir();
      cb(null, media.MEDIA_DIR);
    },
    filename: (_req, file, cb) => cb(null, media.safeFilename(file.originalname))
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (media.isAllowedUpload(file.originalname, file.mimetype)) cb(null, true);
    else cb(new Error("Chỉ chấp nhận ảnh hoặc video"));
  }
});

function createCmsRouter({ requireCms, getSetting, setSetting, appOrigin }) {
  const router = express.Router();

  async function maybePurgeTrash() {
    try {
      await cms.purgeTrashOlderThan(30);
    } catch {
      /* ignore purge errors on read paths */
    }
  }

  // ——— Public ———
  router.get("/api/posts", async (req, res, next) => {
    try {
      const data = await cms.listPosts({
        publicOnly: true,
        categoryId: req.query.category || undefined,
        q: req.query.q || undefined,
        limit: req.query.limit || 12,
        offset: req.query.offset || 0
      });
      res.json({
        total: data.total,
        posts: data.posts.map(publicPost)
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/posts/:slug", async (req, res, next) => {
    try {
      const post = await cms.getPostBySlug(req.params.slug, { publicOnly: true });
      if (!post) return res.status(404).json({ error: "Không tìm thấy bài viết" });
      await cms.incrementView(post.id);
      const refreshed = await cms.getPostBySlug(req.params.slug, { publicOnly: true });
      res.json({ post: publicPost(refreshed, true) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/categories", async (req, res, next) => {
    try {
      const categories = await cms.listCategories();
      res.json({ categories });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/seo/site", async (req, res, next) => {
    try {
      const gscMeta = (await getSetting("gsc_verification_meta", "")).trim();
      const gscProperty = (await getSetting("gsc_property_url", "")).trim();
      const siteName = (await getSetting("seo_site_name", "Findmap")).trim() || "Findmap";
      const defaultDesc = (await getSetting(
        "seo_default_description",
        "Findmap — tìm điểm bán trên Google Maps, quản lý credit và xuất danh sách."
      )).trim();
      res.json({ gscMeta, gscProperty, siteName, defaultDesc, appOrigin });
    } catch (err) {
      next(err);
    }
  });

  // ——— Admin ———
  router.get("/api/admin/cms/media", requireCms, async (req, res, next) => {
    try {
      res.json({
        media: media.listMedia({
          type: req.query.type || "all",
          limit: req.query.limit || 200
        })
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/admin/cms/media", requireCms, (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload thất bại" });
      if (!req.file) return res.status(400).json({ error: "Thiếu file" });
      const item = {
        name: req.file.filename,
        url: `${media.PUBLIC_PREFIX}/${req.file.filename}`,
        kind: media.mediaKind(req.file.filename),
        size: req.file.size,
        updated_at: new Date().toISOString()
      };
      res.json({ ok: true, media: item });
    });
  });

  router.put("/api/admin/cms/media/:name", requireCms, async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name || "");
      const newName = String(req.body?.newName || req.body?.name || "").trim();
      if (!newName) return res.status(400).json({ error: "Thiếu tên mới" });
      const item = media.renameMedia(name, newName);
      res.json({ ok: true, media: item });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Đổi tên thất bại" });
    }
  });

  router.post("/api/admin/cms/media/:name/replace", requireCms, (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload thất bại" });
      if (!req.file) return res.status(400).json({ error: "Thiếu file" });
      try {
        const name = decodeURIComponent(req.params.name || "");
        const item = media.replaceMediaFile(name, req.file.path);
        res.json({ ok: true, media: item });
      } catch (e) {
        try {
          if (req.file?.path) fs.unlinkSync(req.file.path);
        } catch {
          /* ignore */
        }
        return res.status(400).json({ error: e.message || "Thay file thất bại" });
      }
    });
  });

  router.delete("/api/admin/cms/media/:name", requireCms, async (req, res, next) => {
    try {
      const name = decodeURIComponent(req.params.name || "");
      media.deleteMedia(name);
      res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Xóa media thất bại" });
    }
  });

  router.get("/api/admin/cms/posts", requireCms, async (req, res, next) => {
    try {
      const status = req.query.status || "all";
      if (status === "trash") await maybePurgeTrash();
      const data = await cms.listPosts({
        status,
        categoryId: req.query.category || undefined,
        q: req.query.q || undefined,
        limit: req.query.limit || 100,
        offset: req.query.offset || 0
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/admin/cms/posts/:id", requireCms, async (req, res, next) => {
    try {
      const post = await cms.getPostById(req.params.id);
      if (!post) return res.status(404).json({ error: "Không tìm thấy bài viết" });
      const seo = cms.computeSeoScore(post, { appOrigin });
      res.json({ post, seo: { ...seo, kind: "editorial" }, google: parseGooglePsi(post) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/admin/cms/posts", requireCms, async (req, res, next) => {
    try {
      const body = sanitizePostBody(req.body || {});
      if (!body.title) return res.status(400).json({ error: "Thiếu tiêu đề bài viết" });
      const post = await cms.createPost(body, (req.user || req.admin)?.id, { appOrigin });
      const seo = cms.computeSeoScore(post, { appOrigin });
      res.json({ ok: true, post, seo: { ...seo, kind: "editorial" } });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Slug đã tồn tại" });
      next(err);
    }
  });

  router.put("/api/admin/cms/posts/:id", requireCms, async (req, res, next) => {
    try {
      const body = sanitizePostBody(req.body || {});
      const before = await cms.getPostById(req.params.id);
      const post = await cms.updatePost(req.params.id, body, { appOrigin });
      const seo = cms.computeSeoScore(post, { appOrigin });
      let googlePsi = null;
      const becamePublished =
        post.status === "published" && before && before.status !== "published";
      if (becamePublished) {
        try {
          googlePsi = await runAndSaveGoogleScore(post, { getSetting, appOrigin });
        } catch (psiErr) {
          googlePsi = { error: psiErr.message, code: psiErr.code || null, post };
        }
      }
      res.json({
        ok: true,
        post: googlePsi?.post || post,
        seo: { ...seo, kind: "editorial" },
        google: googlePsi?.google || parseGooglePsi(googlePsi?.post || post),
        googleError: googlePsi?.error || null
      });
    } catch (err) {
      if (err.message === "Không tìm thấy bài viết") return res.status(404).json({ error: err.message });
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Slug đã tồn tại" });
      next(err);
    }
  });

  router.post("/api/admin/cms/posts/:id/google-score", requireCms, async (req, res, next) => {
    try {
      const post = await cms.getPostById(req.params.id);
      if (!post) return res.status(404).json({ error: "Không tìm thấy bài viết" });
      if (post.status !== "published") {
        return res.status(400).json({
          error:
            "Chỉ chấm PageSpeed khi bài đã xuất bản trên URL public. Xuất bản trước rồi bấm Chấm lại từ Google."
        });
      }
      const origin = String(appOrigin || "").replace(/\/+$/, "");
      const pageUrl =
        String(req.body?.url || "").trim() ||
        post.canonical_url?.trim() ||
        `${origin}${post.path || cms.publicPathForPost(post)}`;
      if (isLocalOrPrivateUrl(pageUrl)) {
        return res.status(400).json({
          error:
            "URL đang là localhost/nội bộ — Google PageSpeed không crawl được. Đặt NEWS_ORIGIN domain public rồi thử lại.",
          code: "PSI_LOCAL_URL",
          pageUrl
        });
      }
      const apiKey =
        (await getSetting("pagespeed_api_key", "")) || process.env.PAGESPEED_API_KEY || "";
      const psi = await runPageSpeed(pageUrl, { apiKey, strategy: "mobile" });
      const saved = await cms.saveGooglePsiResult(post.id, psi);
      res.json({
        ok: true,
        post: saved,
        google: { ...psi, checkedAt: psi.fetchedAt },
        pageUrl
      });
    } catch (err) {
      return res.status(400).json({
        error: err.message || "Chấm PageSpeed thất bại",
        code: err.code || null
      });
    }
  });

  router.post("/api/admin/cms/posts/:id/duplicate", requireCms, async (req, res, next) => {
    try {
      const post = await cms.duplicatePost(req.params.id, (req.user || req.admin)?.id, { appOrigin });
      const seo = cms.computeSeoScore(post, { appOrigin });
      res.json({ ok: true, post, seo: { ...seo, kind: "editorial" } });
    } catch (err) {
      if (err.message === "Không tìm thấy bài viết") return res.status(404).json({ error: err.message });
      return res.status(400).json({ error: err.message || "Nhân đôi thất bại" });
    }
  });

  router.patch("/api/admin/cms/posts/:id/status", requireCms, async (req, res, next) => {
    try {
      const status = String(req.body?.status || "").trim();
      const before = await cms.getPostById(req.params.id);
      const post = await cms.setPostStatus(req.params.id, status);
      let google = parseGooglePsi(post);
      let googleError = null;
      if (status === "published" && before?.status !== "published") {
        try {
          const result = await runAndSaveGoogleScore(post, { getSetting, appOrigin });
          return res.json({ ok: true, post: result.post, google: result.google });
        } catch (psiErr) {
          googleError = psiErr.message;
        }
      }
      res.json({ ok: true, post, google, googleError });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Lỗi đổi trạng thái" });
    }
  });

  router.patch("/api/admin/cms/posts/:id/trash", requireCms, async (req, res, next) => {
    try {
      const post = await cms.moveToTrash(req.params.id);
      res.json({ ok: true, post });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Không đưa vào thùng rác được" });
    }
  });

  router.patch("/api/admin/cms/posts/:id/restore", requireCms, async (req, res, next) => {
    try {
      const post = await cms.restoreFromTrash(req.params.id);
      res.json({ ok: true, post });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Không khôi phục được" });
    }
  });

  router.delete("/api/admin/cms/posts/:id", requireCms, async (req, res, next) => {
    try {
      await cms.deletePostPermanent(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Chỉ xóa vĩnh viễn bài trong thùng rác" });
    }
  });

  router.post("/api/admin/cms/seo-score", requireCms, async (req, res) => {
    const seo = cms.computeSeoScore(sanitizePostBody(req.body || {}), { appOrigin });
    res.json({ ...seo, kind: "editorial" });
  });

  router.get("/api/admin/cms/categories", requireCms, async (req, res, next) => {
    try {
      res.json({ categories: await cms.listCategories() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/admin/cms/categories", requireCms, async (req, res, next) => {
    try {
      const { name, slug, description } = req.body || {};
      const cat = await cms.createCategory({ name, slug, description });
      res.json({ ok: true, category: cat });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Slug danh mục đã tồn tại" });
      return res.status(400).json({ error: err.message || "Lỗi tạo danh mục" });
    }
  });

  router.put("/api/admin/cms/categories/:id", requireCms, async (req, res, next) => {
    try {
      const { name, slug, description } = req.body || {};
      const cat = await cms.updateCategory(req.params.id, { name, slug, description });
      res.json({ ok: true, category: cat });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Slug danh mục đã tồn tại" });
      next(err);
    }
  });

  router.delete("/api/admin/cms/categories/:id", requireCms, async (req, res, next) => {
    try {
      await cms.deleteCategory(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/admin/cms/seo-settings", requireCms, async (req, res, next) => {
    try {
      const psiKey = await getSetting("pagespeed_api_key", "");
      res.json({
        gscVerificationMeta: await getSetting("gsc_verification_meta", ""),
        gscPropertyUrl: await getSetting("gsc_property_url", ""),
        pagespeedApiKey: "",
        hasPagespeedApiKey: Boolean(String(psiKey || "").trim()),
        seoSiteName: await getSetting("seo_site_name", "Findmap"),
        seoDefaultDescription: await getSetting(
          "seo_default_description",
          "Findmap — tìm điểm bán trên Google Maps, quản lý credit và xuất danh sách."
        )
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/admin/cms/seo-settings", requireCms, async (req, res, next) => {
    try {
      const b = req.body || {};
      await setSetting("gsc_verification_meta", String(b.gscVerificationMeta || "").trim());
      await setSetting("gsc_property_url", String(b.gscPropertyUrl || "").trim());
      if (Object.prototype.hasOwnProperty.call(b, "pagespeedApiKey")) {
        const key = String(b.pagespeedApiKey || "").trim();
        if (key) await setSetting("pagespeed_api_key", key);
        else if (!b.keepPagespeedApiKey) await setSetting("pagespeed_api_key", "");
      }
      await setSetting("seo_site_name", String(b.seoSiteName || "Findmap").trim() || "Findmap");
      await setSetting(
        "seo_default_description",
        String(b.seoDefaultDescription || "").trim()
      );
      res.json({ ok: true, message: "Đã lưu cấu hình SEO / Search Console" });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/admin/cms/export", requireCms, async (req, res, next) => {
    try {
      const origin = String(appOrigin || "").replace(/\/+$/, "");
      const status = req.query.status && req.query.status !== "trash" ? req.query.status : "all";
      const data = await cms.listPosts({ status, limit: 500 });
      const rows = (data.posts || []).map((p) => ({
        URL: `${origin}${cms.publicPathForPost(p)}`,
        "Từ khóa chính": p.focus_keyword || "",
        "Từ khóa phụ": p.secondary_keywords || "",
        "Danh mục": p.category_name || "",
        "Tiêu đề": p.title || "",
        "Trạng thái": p.status || ""
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [
        {
          URL: "",
          "Từ khóa chính": "",
          "Từ khóa phụ": "",
          "Danh mục": "",
          "Tiêu đề": "",
          "Trạng thái": ""
        }
      ]);
      XLSX.utils.book_append_sheet(wb, ws, "Bai viet");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="findmap-posts-${Date.now()}.xlsx"`
      );
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function decodeHtmlEntities(str) {
  let s = String(str || "");
  if (!s.includes("&")) return s;
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    aacute: "á",
    Aacute: "Á",
    agrave: "à",
    Agrave: "À",
    acirc: "â",
    Acirc: "Â",
    atilde: "ã",
    Atilde: "Ã",
    auml: "ä",
    Auml: "Ä",
    aelig: "æ",
    AElig: "Æ",
    ccedil: "ç",
    Ccedil: "Ç",
    eacute: "é",
    Eacute: "É",
    egrave: "è",
    Egrave: "È",
    ecirc: "ê",
    Ecirc: "Ê",
    euml: "ë",
    Euml: "Ë",
    iacute: "í",
    Iacute: "Í",
    igrave: "ì",
    Igrave: "Ì",
    icirc: "î",
    Icirc: "Î",
    iuml: "ï",
    Iuml: "Ï",
    ntilde: "ñ",
    Ntilde: "Ñ",
    oacute: "ó",
    Oacute: "Ó",
    ograve: "ò",
    Ograve: "Ò",
    ocirc: "ô",
    Ocirc: "Ô",
    otilde: "õ",
    Otilde: "Õ",
    ouml: "ö",
    Ouml: "Ö",
    oslash: "ø",
    Oslash: "Ø",
    uacute: "ú",
    Uacute: "Ú",
    ugrave: "ù",
    Ugrave: "Ù",
    ucirc: "û",
    Ucirc: "Û",
    uuml: "ü",
    Uuml: "Ü",
    yacute: "ý",
    Yacute: "Ý",
    yuml: "ÿ",
    szlig: "ß",
    ndash: "–",
    mdash: "—",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    hellip: "…",
    middot: "·",
    bull: "•",
    copy: "©",
    reg: "®",
    trade: "™"
  };
  for (let i = 0; i < 2; i += 1) {
    const next = s
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const cp = parseInt(hex, 16);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
      })
      .replace(/&#(\d+);/g, (_, num) => {
        const cp = Number(num);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
      })
      .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
        if (Object.prototype.hasOwnProperty.call(named, name)) return named[name];
        const lower = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : m;
      });
    if (next === s) break;
    s = next;
  }
  return s;
}

function excerptFromHtml(html, maxLen = 150) {
  const plain = decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
  if (!plain) return "";
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen - 1).trim()}…`;
}

function publicPost(post, includeContent = false) {
  if (!post) return null;
  const path = post.path || cms.publicPathForPost(post);
  const storedCover = String(post.cover_image || "").trim();
  const cover = cms.resolveCoverImage(post);
  const excerpt =
    String(post.excerpt || "").trim() ||
    excerptFromHtml(post.content_html || "", 150) ||
    "";
  const base = {
    id: post.id,
    title: post.title,
    slug: post.slug,
    url_path: post.url_path != null ? post.url_path : "tin-tuc",
    path,
    excerpt,
    cover_image: cover,
    cover_is_temp: Boolean(cover && !storedCover),
    category_name: post.category_name,
    category_slug: post.category_slug,
    published_at: post.published_at,
    seo_title: post.seo_title || post.title,
    seo_description: post.seo_description || excerpt,
    focus_keyword: post.focus_keyword,
    og_image: post.og_image || cover,
    canonical_url: post.canonical_url,
    noindex: post.noindex,
    view_count: post.view_count,
    updated_at: post.updated_at
  };
  if (includeContent) base.content_html = post.content_html;
  return base;
}

function sanitizePostBody(body) {
  return {
    title: String(body.title || "").trim().slice(0, 500),
    slug: String(body.slug || "").trim().slice(0, 180),
    url_path: body.url_path,
    excerpt: String(body.excerpt || "").trim().slice(0, 2000),
    content_html: String(body.content_html || ""),
    cover_image: String(body.cover_image || "").trim().slice(0, 2000),
    category_id: body.category_id || null,
    status: body.status,
    seo_title: String(body.seo_title || "").trim().slice(0, 255),
    seo_description: String(body.seo_description || "").trim().slice(0, 500),
    focus_keyword: String(body.focus_keyword || "").trim().slice(0, 255),
    secondary_keywords: String(body.secondary_keywords || "").trim().slice(0, 2000),
    og_image: String(body.og_image || "").trim().slice(0, 2000),
    canonical_url: String(body.canonical_url || "").trim().slice(0, 500),
    noindex: Boolean(body.noindex),
    use_first_image: body.use_first_image !== false && body.use_first_image !== 0
  };
}

async function buildSitemapXml(appOrigin) {
  const origin = String(appOrigin || "").replace(/\/+$/, "");
  const posts = await cms.listPublishedForSitemap();
  const urls = [
    { loc: `${origin}/`, priority: "1.0", changefreq: "weekly" },
    { loc: `${origin}/gioi-thieu`, priority: "0.95", changefreq: "weekly" },
    { loc: `${origin}/tin-tuc`, priority: "0.9", changefreq: "daily" },
    ...posts.map((p) => ({
      loc: `${origin}${p.path || cms.publicPathForPost(p)}`,
      lastmod: (p.updated_at || p.published_at || "").slice(0, 10),
      priority: "0.7",
      changefreq: "weekly"
    }))
  ];
  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const body = urls
    .map((u) => {
      const last = u.lastmod ? `\n    <lastmod>${esc(u.lastmod)}</lastmod>` : "";
      return `  <url>\n    <loc>${esc(u.loc)}</loc>${last}\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

module.exports = { createCmsRouter, buildSitemapXml, cms };
