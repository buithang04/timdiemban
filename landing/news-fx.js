/**
 * news-fx.js — hiệu ứng tương tác nhẹ cho trang tin / bài viết
 * (scroll, pointer, đọc bài). Tôn trọng prefers-reduced-motion.
 */
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isNews = document.body.classList.contains("page-news");
  const isArticle = document.body.classList.contains("page-article");
  if (!isNews && !isArticle) return;

  /* ——— Topbar theo scroll ——— */
  const topbar = document.querySelector(".topbar");
  function onScrollTopbar() {
    if (!topbar) return;
    topbar.classList.toggle("is-scrolled", window.scrollY > 12);
  }
  onScrollTopbar();
  window.addEventListener("scroll", onScrollTopbar, { passive: true });

  /* ——— Reading progress (bài viết) ——— */
  let progressEl = null;
  if (isArticle && !reduce) {
    progressEl = document.createElement("div");
    progressEl.className = "read-progress";
    progressEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(progressEl);
  }

  function updateReadProgress() {
    if (!progressEl) return;
    const article = document.querySelector(".article-body");
    if (!article) {
      progressEl.style.transform = "scaleX(0)";
      return;
    }
    const rect = article.getBoundingClientRect();
    const start = window.scrollY + rect.top - window.innerHeight * 0.15;
    const end = window.scrollY + rect.bottom - window.innerHeight * 0.35;
    const span = Math.max(end - start, 1);
    const p = Math.min(1, Math.max(0, (window.scrollY - start) / span));
    progressEl.style.transform = `scaleX(${p})`;
  }

  /* ——— Spotlight theo con trỏ trên thẻ tin ——— */
  function bindCardPointer(card) {
    if (reduce || card.dataset.fxBound) return;
    card.dataset.fxBound = "1";
    card.classList.add("news-card-fx");

    card.addEventListener(
      "pointermove",
      (e) => {
        const r = card.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        const y = ((e.clientY - r.top) / r.height) * 100;
        card.style.setProperty("--spot-x", `${x}%`);
        card.style.setProperty("--spot-y", `${y}%`);
      },
      { passive: true }
    );

    card.addEventListener("pointerleave", () => {
      card.style.removeProperty("--spot-x");
      card.style.removeProperty("--spot-y");
    });
  }

  function staggerReveals(root) {
    const cards = (root || document).querySelectorAll(".news-card.reveal");
    cards.forEach((card, i) => {
      card.style.setProperty("--stagger", `${Math.min(i % 9, 8) * 60}ms`);
      bindCardPointer(card);
    });
  }

  /* ——— Parallax nhẹ hero trang tin ——— */
  const hero = document.querySelector(".page-news .page-hero");
  function onHeroParallax() {
    if (!hero || reduce) return;
    const y = Math.min(window.scrollY, 180);
    hero.style.setProperty("--hero-shift", `${y * 0.12}px`);
  }

  /* ——— Ảnh trong bài: hiện nhẹ khi vào viewport (không ẩn khối nội dung) ——— */
  const imgIo =
    !reduce &&
    new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            imgIo.unobserve(e.target);
          }
        });
      },
      { threshold: 0.01, rootMargin: "40px 0px 40px 0px" }
    );

  function bindArticleMedia(root) {
    const scope = root || document;
    // Không gắn .reveal lên .article-main — bài dài dễ kẹt opacity:0
    scope.querySelectorAll(".article-main.reveal, .article-body.reveal, .article-hero.reveal").forEach((el) => {
      el.classList.remove("reveal");
      el.classList.add("in");
    });

    const mediaNodes = scope.querySelectorAll(".article-body img, .article-cover");
    mediaNodes.forEach((el) => {
      if (el.dataset.mediaBound) return;
      el.dataset.mediaBound = "1";
      if (reduce || !imgIo) {
        el.classList.add("media-reveal", "in-view");
        return;
      }
      // Ảnh cover / ảnh gần đầu: hiện ngay, tránh trang trắng
      const isCover = el.classList.contains("article-cover") || el.closest(".article-cover");
      el.classList.add("media-reveal");
      if (isCover) {
        el.classList.add("in-view");
        return;
      }
      imgIo.observe(el);
    });
  }

  function onScroll() {
    updateReadProgress();
    onHeroParallax();
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  let refreshTimer = 0;
  function refresh(root) {
    staggerReveals(root || document);
    if (isArticle) {
      bindArticleMedia(root || document);
      updateReadProgress();
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(document), 40);
  }

  refresh();

  const mo = new MutationObserver(scheduleRefresh);
  const newsGrid = document.getElementById("newsGrid");
  const articleRoot = document.getElementById("articleRoot");
  if (newsGrid) mo.observe(newsGrid, { childList: true });
  if (articleRoot) mo.observe(articleRoot, { childList: true });

  window.NewsFx = { refresh };
})();
