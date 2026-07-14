(function () {
  const PAGE_SIZE = 9;

  function stripSlash(o) {
    return String(o || "").replace(/\/+$/, "");
  }

  /** Gắn APP/NEWS/SEARCH origin từ config hoặc /api/config/origins — không hardcode domain. */
  function applyOriginLinks(origins) {
    const search = stripSlash(
      origins?.searchOrigin ||
        origins?.SEARCH_ORIGIN ||
        globalThis.TIMDIEMBAN_CONFIG?.SEARCH_ORIGIN ||
        globalThis.TIMDIEMBAN_CONFIG?.APP_ORIGIN ||
        ""
    );
    const news = stripSlash(
      origins?.newsOrigin ||
        origins?.NEWS_ORIGIN ||
        globalThis.TIMDIEMBAN_CONFIG?.NEWS_ORIGIN ||
        (typeof location !== "undefined" ? location.origin : "")
    );

    document.querySelectorAll("[data-href-search]").forEach((el) => {
      const path = el.getAttribute("data-href-search") || "/";
      if (!search) return;
      el.setAttribute("href", path.startsWith("http") ? path : `${search}${path.startsWith("/") ? path : `/${path}`}`);
    });

    document.querySelectorAll("[data-href-news]").forEach((el) => {
      const path = el.getAttribute("data-href-news") || "/";
      if (!news) return;
      el.setAttribute("href", path.startsWith("http") ? path : `${news}${path.startsWith("/") ? path : `/${path}`}`);
    });

    const canon = document.querySelector('link[rel="canonical"]');
    if (canon && news) {
      const path = location.pathname.replace(/\/+$/, "") || "/gioi-thieu";
      canon.setAttribute("href", `${news}${path}`);
    }

    document.querySelectorAll('meta[property="og:image"]').forEach((meta) => {
      const raw = meta.getAttribute("content") || "";
      if (raw.startsWith("/") && news) meta.setAttribute("content", `${news}${raw}`);
      else if (raw.includes("://") && news && /localhost|127\.0\.0\.1|findmap\.app\.chatplus\.io\.vn/i.test(raw)) {
        try {
          const u = new URL(raw);
          meta.setAttribute("content", `${news}${u.pathname}${u.search}`);
        } catch {
          /* keep */
        }
      }
    });

    document.querySelectorAll("script[type='application/ld+json']").forEach((el) => {
      try {
        const data = JSON.parse(el.textContent || "{}");
        if (data?.publisher && search) data.publisher.url = search;
        if (data && news && !data.url) data.url = `${news}${location.pathname}`;
        el.textContent = JSON.stringify(data);
      } catch {
        /* ignore */
      }
    });
  }

  async function bootOrigins() {
    let origins = null;
    try {
      origins = await fetch("/api/config/origins").then((r) => (r.ok ? r.json() : null));
    } catch {
      origins = null;
    }
    applyOriginLinks(origins);
  }

  bootOrigins();

  const nav = document.getElementById("mainNav");
  const toggle = document.getElementById("menuToggle");

  toggle?.addEventListener("click", () => {
    nav?.classList.toggle("open");
  });

  nav?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => nav.classList.remove("open"));
  });

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) e.target.classList.add("in");
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );

  function observeReveals(root) {
    (root || document).querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
  }

  observeReveals();

  const termsWrap = document.getElementById("termsWrap");
  const termsBlock = document.getElementById("termsBlock");
  const termsToggle = document.getElementById("termsToggle");
  termsToggle?.addEventListener("click", () => {
    const expanded = termsWrap?.classList.toggle("is-expanded");
    termsBlock?.classList.toggle("is-expanded", !!expanded);
    termsToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    termsToggle.textContent = expanded ? "Thu gọn" : "Xem thêm";
    if (!expanded) {
      document.getElementById("chinh-sach")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  /* ——— Helpers ——— */
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
  }

  function postUrl(postOrSlug) {
    if (postOrSlug && typeof postOrSlug === "object") {
      if (postOrSlug.path) return postOrSlug.path;
      const slug = postOrSlug.slug || "";
      const prefix = String(postOrSlug.url_path != null ? postOrSlug.url_path : "tin-tuc")
        .replace(/^\/+|\/+$/g, "");
      return prefix
        ? `/${prefix}/${encodeURIComponent(slug)}`
        : `/${encodeURIComponent(slug)}`;
    }
    return `/tin-tuc/${encodeURIComponent(postOrSlug || "")}`;
  }

  function decodeHtmlEntities(str) {
    const s = String(str ?? "");
    if (!s || !s.includes("&")) return s;
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  }

  function newsCardHtml(post) {
    const title = escapeHtml(post.title || "Không tiêu đề");
    const excerptRaw = decodeHtmlEntities(String(post.excerpt || "").trim());
    const excerpt = escapeHtml(excerptRaw);
    const cat = escapeHtml(post.category_name || "Tin tức");
    const date = formatDate(post.published_at || post.updated_at);
    const href = postUrl(post);
    const cover = post.cover_image
      ? `<img src="${escapeHtml(post.cover_image)}" alt="" loading="lazy" />`
      : "";
    return `
      <a class="news-card reveal" href="${href}">
        <div class="news-card-cover">${cover}</div>
        <div class="news-card-body">
          <span class="news-card-cat">${cat}</span>
          <h3>${title}</h3>
          ${excerpt ? `<p class="news-card-excerpt">${excerpt}</p>` : `<p class="news-card-excerpt">Xem chi tiết bài viết trên Findmap.</p>`}
          ${date ? `<time class="news-card-date" datetime="${escapeHtml(post.published_at || "")}">${date}</time>` : ""}
        </div>
      </a>
    `;
  }

  async function fetchPosts({ limit = 12, offset = 0, category, q } = {}) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    const res = await fetch(`/api/posts?${params.toString()}`);
    if (!res.ok) throw new Error("Không tải được tin tức");
    return res.json();
  }

  function parseGscContent(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    const match = value.match(/content\s*=\s*["']([^"']+)["']/i);
    if (match) return match[1].trim();
    return value.replace(/^["']|["']$/g, "").trim();
  }

  async function applySeoSite() {
    const meta = document.getElementById("gscMeta");
    if (!meta) return;
    try {
      const res = await fetch("/api/seo/site");
      if (!res.ok) return;
      const data = await res.json();
      const content = parseGscContent(data.gscMeta);
      if (content) meta.setAttribute("content", content);
    } catch {
      /* ignore offline / missing API */
    }
  }

  /* ——— Home news rail (1 hàng 3 bài + mũi tên) ——— */
  function initNewsRail(track, prevBtn, nextBtn) {
    if (!track || !prevBtn || !nextBtn) return;

    function cardStep() {
      const card = track.querySelector(".news-card");
      if (!card) return track.clientWidth * 0.85;
      const styles = getComputedStyle(track);
      const gap = parseFloat(styles.columnGap || styles.gap || "0") || 0;
      return card.getBoundingClientRect().width + gap;
    }

    function setBtnHidden(btn, hide) {
      btn.classList.toggle("is-hidden", hide);
      btn.hidden = hide;
      btn.setAttribute("aria-hidden", hide ? "true" : "false");
      btn.tabIndex = hide ? -1 : 0;
    }

    function updateButtons() {
      const max = Math.max(0, track.scrollWidth - track.clientWidth - 1);
      const canScroll = max > 8;
      const atStart = track.scrollLeft <= 4;
      const atEnd = !canScroll || track.scrollLeft >= max - 1;

      setBtnHidden(prevBtn, !canScroll || atStart);
      setBtnHidden(nextBtn, !canScroll || atEnd);
    }

    prevBtn.addEventListener("click", () => {
      track.scrollBy({ left: -cardStep(), behavior: "smooth" });
    });
    nextBtn.addEventListener("click", () => {
      track.scrollBy({ left: cardStep(), behavior: "smooth" });
    });
    track.addEventListener("scroll", updateButtons, { passive: true });
    window.addEventListener("resize", updateButtons);
    updateButtons();
    requestAnimationFrame(updateButtons);
    setTimeout(updateButtons, 120);
  }

  async function loadHomeNews() {
    const grid = document.getElementById("homeNewsGrid");
    if (!grid) return;
    try {
      const data = await fetchPosts({ limit: 12, offset: 0 });
      const posts = data.posts || [];
      if (!posts.length) {
        grid.innerHTML = `<div class="news-empty">Chưa có bài viết công khai.</div>`;
        return;
      }
      grid.innerHTML = posts.map(newsCardHtml).join("");
      observeReveals(grid);
      initNewsRail(
        grid,
        document.getElementById("homeNewsPrev"),
        document.getElementById("homeNewsNext")
      );
    } catch {
      grid.innerHTML = `<div class="news-empty">Không tải được tin tức. Thử lại sau.</div>`;
    }
  }

  /* ——— News listing ——— */
  function initNewsPage() {
    const grid = document.getElementById("newsGrid");
    const filtersEl = document.getElementById("newsFilters");
    const form = document.getElementById("newsSearchForm");
    const input = document.getElementById("newsSearchInput");
    const moreWrap = document.getElementById("newsMoreWrap");
    const moreBtn = document.getElementById("newsLoadMore");
    if (!grid) return;

    const state = {
      category: "",
      q: "",
      offset: 0,
      total: 0,
      loading: false
    };

    function setActiveChip() {
      filtersEl?.querySelectorAll(".filter-chip").forEach((btn) => {
        btn.classList.toggle("is-active", (btn.dataset.category || "") === state.category);
      });
    }

    async function loadCategories() {
      if (!filtersEl) return;
      try {
        const res = await fetch("/api/categories");
        if (!res.ok) throw new Error("categories");
        const data = await res.json();
        const cats = data.categories || [];
        filtersEl.innerHTML =
          `<button type="button" class="filter-chip is-active" data-category="">Tất cả</button>` +
          cats
            .map(
              (c) =>
                `<button type="button" class="filter-chip" data-category="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`
            )
            .join("");
        filtersEl.addEventListener("click", (e) => {
          const btn = e.target.closest(".filter-chip");
          if (!btn) return;
          state.category = btn.dataset.category || "";
          setActiveChip();
          reload();
        });
      } catch {
        filtersEl.innerHTML = "";
      }
    }

    async function load(append) {
      if (state.loading) return;
      state.loading = true;
      if (!append) {
        grid.innerHTML = `<div class="news-loading" style="grid-column: 1 / -1">Đang tải tin tức…</div>`;
        moreWrap.hidden = true;
      } else if (moreBtn) {
        moreBtn.disabled = true;
        moreBtn.textContent = "Đang tải…";
      }

      try {
        const data = await fetchPosts({
          limit: PAGE_SIZE,
          offset: state.offset,
          category: state.category || undefined,
          q: state.q || undefined
        });
        const posts = data.posts || [];
        state.total = Number(data.total || 0);

        if (!append && !posts.length) {
          grid.innerHTML = `<div class="news-empty" style="grid-column: 1 / -1">Không tìm thấy bài viết phù hợp.</div>`;
          moreWrap.hidden = true;
          return;
        }

        const html = posts.map(newsCardHtml).join("");
        if (append) {
          grid.insertAdjacentHTML("beforeend", html);
        } else {
          grid.innerHTML = html;
        }
        observeReveals(grid);

        state.offset += posts.length;
        const hasMore = state.offset < state.total;
        moreWrap.hidden = !hasMore;
      } catch {
        if (!append) {
          grid.innerHTML = `<div class="news-empty" style="grid-column: 1 / -1">Không tải được tin tức. Thử lại sau.</div>`;
        }
        moreWrap.hidden = true;
      } finally {
        state.loading = false;
        if (moreBtn) {
          moreBtn.disabled = false;
          moreBtn.textContent = "Xem thêm";
        }
      }
    }

    function reload() {
      state.offset = 0;
      load(false);
    }

    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = (input?.value || "").trim();
      reload();
    });

    moreBtn?.addEventListener("click", () => load(true));

    loadCategories().then(reload);
  }

  /* ——— Article detail ——— */
  function setMeta(id, attr, value) {
    const el = document.getElementById(id);
    if (!el || value == null) return;
    el.setAttribute(attr, value);
  }

  function formatDateLong(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return `Tháng ${d.getMonth() + 1} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function slugifyHeading(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "muc";
  }

  function stripLeadingCoverImage(html, coverUrl) {
    if (!html || !coverUrl) return html || "";
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const firstImg = wrap.querySelector("img");
    if (!firstImg) return html;
    const src = (firstImg.getAttribute("src") || "").trim();
    if (!src || src !== coverUrl) return html;
    const block = firstImg.closest("figure, p, div") || firstImg;
    if (block === firstImg || (block.tagName === "P" && block.childElementCount <= 1 && !block.textContent.trim())) {
      block.remove();
    } else {
      firstImg.remove();
    }
    return wrap.innerHTML;
  }

  function buildArticleToc(articleEl) {
    const headings = [...articleEl.querySelectorAll("h2, h3")];
    if (headings.length < 2) return "";
    const used = new Set();
    let h2n = 0;
    const parts = [];
    headings.forEach((h) => {
      const text = (h.textContent || "").trim();
      if (!text) return;
      let id = h.id;
      if (!id) {
        let base = `muc-${slugifyHeading(text)}`;
        let candidate = base;
        let i = 2;
        while (used.has(candidate) || document.getElementById(candidate)) {
          candidate = `${base}-${i++}`;
        }
        id = candidate;
        h.id = id;
      }
      used.add(id);
      const isH2 = h.tagName === "H2";
      if (isH2) h2n += 1;
      const label = isH2 ? `${h2n}. ${escapeHtml(text)}` : escapeHtml(text);
      parts.push(
        `<a class="article-toc-item ${isH2 ? "is-h2" : "is-h3"}" href="#${escapeHtml(id)}">${label}</a>`
      );
    });
    if (!parts.length) return "";
    return `
      <div class="article-toc" id="articleToc">
        <button type="button" class="article-toc-toggle" id="articleTocToggle" aria-expanded="false" aria-controls="articleTocPanel">
          <span>Tóm tắt</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
          </svg>
        </button>
        <nav class="article-toc-panel" id="articleTocPanel" hidden>
          <div class="article-toc-panel-head">
            <strong>Tóm tắt</strong>
            <button type="button" class="article-toc-icon" id="articleTocClose" aria-label="Thu gọn tóm tắt">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
              </svg>
            </button>
          </div>
          <div class="article-toc-list">${parts.join("")}</div>
        </nav>
      </div>
    `;
  }

  function bindArticleToc(root) {
    const toc = root.querySelector("#articleToc");
    if (!toc) return;
    const toggle = toc.querySelector("#articleTocToggle");
    const panel = toc.querySelector("#articleTocPanel");
    if (!toggle || !panel) return;

    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toc.classList.toggle("is-open", open);
    }

    toggle.addEventListener("click", () => {
      setOpen(panel.hidden);
    });

    toc.addEventListener("click", (e) => {
      const closeBtn = e.target.closest("#articleTocClose, .article-toc-icon");
      if (!closeBtn) return;
      e.preventDefault();
      setOpen(false);
    });
  }

  function relatedCardHtml(post) {
    const href = postUrl(post);
    const title = escapeHtml(post.title || "Không tiêu đề");
    const date = formatDateLong(post.published_at || post.updated_at);
    const cover = post.cover_image
      ? `<div class="related-card-cover"><img src="${escapeHtml(post.cover_image)}" alt="" loading="lazy" /></div>`
      : `<div class="related-card-cover related-card-cover--empty"></div>`;
    return `
      <a class="related-card" href="${href}">
        ${cover}
        <h3 class="related-card-title">${title}</h3>
        ${date ? `<time class="related-card-date" datetime="${escapeHtml(post.published_at || "")}">${date}</time>` : ""}
      </a>
    `;
  }

  async function loadRelatedPosts(excludeId) {
    try {
      const data = await fetchPosts({ limit: 6, offset: 0 });
      const posts = (data.posts || []).filter((p) => p.id !== excludeId).slice(0, 3);
      if (!posts.length) return "";
      return `
        <section class="related-posts" aria-label="Bài viết liên quan">
          <div class="container">
            <h2 class="related-posts-title">Bài viết liên quan</h2>
            <div class="related-grid">${posts.map(relatedCardHtml).join("")}</div>
          </div>
        </section>
      `;
    } catch {
      return "";
    }
  }

  function recentPostHtml(post, withThumb) {
    const href = postUrl(post);
    const title = escapeHtml(post.title || "Không tiêu đề");
    const date = formatDate(post.published_at || post.updated_at);
    const thumb =
      withThumb && post.cover_image
        ? `<div class="article-aside-thumb"><img src="${escapeHtml(post.cover_image)}" alt="" loading="lazy" /></div>`
        : "";
    return `
      <a class="article-aside-item" href="${href}">
        ${thumb}
        <span class="article-aside-item-title">${title}</span>
        ${date ? `<span class="article-aside-item-date"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>${date}</span>` : ""}
      </a>
    `;
  }

  async function loadRecentAside(excludeId) {
    try {
      const data = await fetchPosts({ limit: 6, offset: 0 });
      const posts = (data.posts || []).filter((p) => p.id !== excludeId).slice(0, 5);
      if (!posts.length) return `<p class="article-aside-empty">Chưa có bài khác.</p>`;
      return posts.map((p, i) => recentPostHtml(p, i === 0)).join("");
    } catch {
      return "";
    }
  }

  function renderArticle404(root) {
    document.title = "Không tìm thấy bài viết — Findmap";
    root.innerHTML = `
      <section class="page-hero">
        <div class="container">
          <a class="article-back" href="/tin-tuc">← Quay lại tin tức</a>
          <div class="article-404">
            <h1 style="margin:0 0 0.5rem;font-family:var(--display)">Không tìm thấy bài viết</h1>
            <p style="margin:0 0 1.25rem">Bài viết không tồn tại hoặc đã được ẩn.</p>
            <a class="btn btn-primary" href="/tin-tuc">Xem tất cả tin tức</a>
          </div>
        </div>
      </section>
    `;
  }

  async function loadArticle() {
    const root = document.getElementById("articleRoot");
    if (!root) return;

    const parts = location.pathname.replace(/\/+$/, "").split("/");
    const slug = decodeURIComponent(parts[parts.length - 1] || "");
    if (!slug || slug === "tin-tuc") {
      renderArticle404(root);
      return;
    }

    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        renderArticle404(root);
        return;
      }
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      const post = data.post;
      if (!post) {
        renderArticle404(root);
        return;
      }

      const title = post.seo_title || post.title || "Bài viết";
      const desc = post.seo_description || post.excerpt || "";
      const image = post.og_image || post.cover_image || "";
      const url = post.canonical_url || location.href;

      document.title = `${title} — Findmap`;
      setMeta("metaDescription", "content", desc);
      setMeta("ogTitle", "content", title);
      setMeta("ogDescription", "content", desc);
      setMeta("ogImage", "content", image);
      setMeta("ogUrl", "content", url);
      setMeta("canonicalLink", "href", url);
      if (post.noindex) {
        let robots = document.querySelector('meta[name="robots"]');
        if (!robots) {
          robots = document.createElement("meta");
          robots.setAttribute("name", "robots");
          document.head.appendChild(robots);
        }
        robots.setAttribute("content", "noindex,nofollow");
      }

      const date = formatDateLong(post.published_at || post.updated_at);
      const coverUrl = post.cover_image || "";
      let bodyHtml = post.content_html || "";
      if (coverUrl && post.cover_is_temp) {
        bodyHtml = stripLeadingCoverImage(bodyHtml, coverUrl);
      }

      const cover = coverUrl
        ? `<div class="article-cover"><img src="${escapeHtml(coverUrl)}" alt="" /></div>`
        : "";

      const asideHtml = await loadRecentAside(post.id);
      const relatedHtml = await loadRelatedPosts(post.id);

      root.innerHTML = `
        <section class="article-page">
          <div class="container article-layout">
            <div class="article-main">
              <a class="article-back" href="/tin-tuc">← Quay lại tin tức</a>
              <h1 class="article-title">${escapeHtml(post.title || "")}</h1>
              ${date ? `<time class="article-date" datetime="${escapeHtml(post.published_at || "")}">${date}</time>` : ""}
              ${cover}
              <div id="articleTocMount"></div>
              <article class="article-body" id="articleBody">${bodyHtml}</article>
            </div>
            <aside class="article-aside" aria-label="Bài viết mới">
              <h2 class="article-aside-title">Bài viết mới</h2>
              <div class="article-aside-card">${asideHtml}</div>
            </aside>
          </div>
        </section>
        ${relatedHtml}
      `;

      const bodyEl = root.querySelector("#articleBody");
      const tocMount = root.querySelector("#articleTocMount");
      if (bodyEl && tocMount) {
        tocMount.innerHTML = buildArticleToc(bodyEl);
        bindArticleToc(root);
      }
    } catch {
      root.innerHTML = `
        <div class="container" style="padding:3rem 0">
          <div class="news-empty">Không tải được bài viết. Thử lại sau.</div>
        </div>
      `;
    }
  }

  /* ——— Consult modal (form gọi lại) ——— */
  const CONSULT_FORM_URL = "https://jobs.clickon.vn/lead-forms/yeu-cau-goi-lai-chatplus";

  function consultButtonHtml() {
    return `<button type="button" class="consult-open-btn">Nhận tư vấn</button>`;
  }

  function injectConsultButtons() {
    ["buoc-tim", "buoc-tien-ich", "buoc-ket-qua"].forEach((id) => {
      const section = document.getElementById(id);
      if (!section || section.querySelector(".consult-open-btn")) return;
      const mediaCopy = section.querySelector(".media-copy");
      const target = mediaCopy || section.querySelector(".container");
      if (!target) return;
      const wrap = document.createElement("div");
      wrap.className = "consult-row";
      wrap.innerHTML = consultButtonHtml();
      target.appendChild(wrap);
    });
  }

  function initConsultModal() {
    injectConsultButtons();
    const modal = document.getElementById("consultModal");
    const frame = document.getElementById("consultFrame");
    if (!modal) return;

    function openModal() {
      if (frame && !frame.getAttribute("src")) {
        frame.setAttribute("src", frame.dataset.src || CONSULT_FORM_URL);
      }
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("consult-modal-open");
    }

    function closeModal() {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("consult-modal-open");
    }

    document.addEventListener("click", (e) => {
      const openBtn = e.target.closest(".consult-open-btn");
      if (openBtn) {
        e.preventDefault();
        openModal();
        return;
      }
      if (e.target.closest("[data-consult-close]")) {
        closeModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
    });
  }

  /* ——— Boot ——— */
  applySeoSite();

  if (document.body.classList.contains("page-home")) {
    loadHomeNews();
    initConsultModal();
  } else if (document.body.classList.contains("page-news")) {
    initNewsPage();
  } else if (document.body.classList.contains("page-article")) {
    loadArticle();
  }
})();
