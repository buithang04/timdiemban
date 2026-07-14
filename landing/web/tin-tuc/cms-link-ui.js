/**
 * cms-link-ui.js — dialog chèn/sửa link kiểu WordPress Classic
 */
(function (global) {
  const { api, escapeHtml } = global.CmsApi;

  let applyCallback = null;
  let searchTimer = null;
  let selectedPostId = null;

  function $(id) {
    return document.getElementById(id);
  }

  function modal() {
    return $("linkModal");
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function postPublicPath(p) {
    if (p.path) return p.path;
    const prefix = String(p.url_path != null ? p.url_path : "tin-tuc").replace(/^\/+|\/+$/g, "");
    return prefix ? `/${prefix}/${p.slug}` : `/${p.slug}`;
  }

  function setHint(q) {
    const hint = $("linkSearchHint");
    if (!hint) return;
    hint.textContent = q
      ? `Kết quả tìm kiếm cho “${q}”.`
      : "Thiếu từ khóa tìm kiếm. Hiển thị các bài viết mới nhất.";
  }

  async function loadPosts(q) {
    const list = $("linkPostList");
    if (!list) return;
    list.innerHTML = `<div class="cms-link-empty">Đang tải…</div>`;
    setHint(q);
    try {
      const params = new URLSearchParams({ status: "all", limit: "30" });
      if (q) params.set("q", q);
      const data = await api(`/api/admin/cms/posts?${params}`);
      const posts = data.posts || [];
      if (!posts.length) {
        list.innerHTML = `<div class="cms-link-empty">Không tìm thấy bài viết.</div>`;
        return;
      }
      list.innerHTML = posts
        .map((p) => {
          const meta = p.category_name
            ? escapeHtml(String(p.category_name).toUpperCase())
            : escapeHtml(formatDate(p.published_at || p.updated_at));
          const path = postPublicPath(p);
          return `<button type="button" class="cms-link-item${selectedPostId === p.id ? " selected" : ""}" data-id="${escapeHtml(p.id)}" data-url="${escapeHtml(path)}" data-title="${escapeHtml(p.title || "")}">
            <span class="cms-link-item-title">${escapeHtml(p.title || "Không tiêu đề")}</span>
            <span class="cms-link-item-meta">${meta}</span>
          </button>`;
        })
        .join("");
    } catch (err) {
      list.innerHTML = `<div class="cms-link-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function openLinkDialog(opts = {}) {
    applyCallback = typeof opts.onApply === "function" ? opts.onApply : null;
    selectedPostId = null;
    const el = modal();
    if (!el) return;

    $("linkUrl").value = opts.url || "";
    $("linkText").value = opts.text || "";
    $("linkNewTab").checked = Boolean(opts.newTab);
    $("linkSearch").value = "";
    $("linkSubmitBtn").textContent = opts.url ? "Cập nhật" : "Thêm liên kết";

    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("cms-modal-open");
    loadPosts("");
    setTimeout(() => $("linkUrl")?.focus(), 50);
  }

  function closeLinkDialog() {
    const el = modal();
    if (!el) return;
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    document.body.classList.remove("cms-modal-open");
    applyCallback = null;
    selectedPostId = null;
  }

  function submitLink() {
    const url = ($("linkUrl")?.value || "").trim();
    const text = ($("linkText")?.value || "").trim();
    const newTab = Boolean($("linkNewTab")?.checked);
    if (!url) {
      $("linkUrl")?.focus();
      return;
    }
    if (applyCallback) {
      applyCallback({ url, text: text || url, newTab });
    }
    closeLinkDialog();
  }

  function bindLinkModal() {
    const el = modal();
    if (!el || el.dataset.bound) return;
    el.dataset.bound = "1";

    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-link]")) closeLinkDialog();
      const item = e.target.closest(".cms-link-item");
      if (item) {
        selectedPostId = item.dataset.id;
        $("linkUrl").value = item.dataset.url || "";
        if (!$("linkText").value.trim()) $("linkText").value = item.dataset.title || "";
        el.querySelectorAll(".cms-link-item").forEach((n) => n.classList.toggle("selected", n === item));
        if (e.detail === 2) submitLink();
      }
    });

    $("linkSearch")?.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadPosts(($("linkSearch").value || "").trim()), 280);
    });

    $("linkSubmitBtn")?.addEventListener("click", submitLink);
    $("linkUrl")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitLink();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && el && !el.classList.contains("hidden")) closeLinkDialog();
    });
  }

  /**
   * Mở dialog từ TinyMCE — đọc selection / anchor đang chọn.
   */
  function openFromTinyMCE(editor) {
    if (!editor) return;
    const selectedText = editor.selection.getContent({ format: "text" });
    let url = "";
    let text = selectedText || "";
    let newTab = false;
    const node = editor.selection.getNode();
    const anchor = editor.dom.getParent(node, "a[href]");
    if (anchor) {
      url = anchor.getAttribute("href") || "";
      text = anchor.textContent || text;
      newTab = (anchor.getAttribute("target") || "") === "_blank";
      editor.selection.select(anchor);
    }
    openLinkDialog({
      url,
      text,
      newTab,
      onApply: ({ url: href, text: label, newTab: blank }) => {
        const attrs = { href };
        if (blank) {
          attrs.target = "_blank";
          attrs.rel = "noopener noreferrer";
        }
        if (anchor) {
          editor.dom.setAttribs(anchor, attrs);
          if (label) anchor.textContent = label;
          if (!blank) {
            editor.dom.setAttrib(anchor, "target", null);
            editor.dom.setAttrib(anchor, "rel", null);
          }
        } else {
          const selText = editor.selection.getContent({ format: "text" });
          if (selText) {
            editor.execCommand("mceInsertLink", false, attrs);
            const a = editor.dom.getParent(editor.selection.getNode(), "a[href]");
            if (a) {
              if (blank) {
                editor.dom.setAttrib(a, "target", "_blank");
                editor.dom.setAttrib(a, "rel", "noopener noreferrer");
              }
              if (label && label !== selText) a.textContent = label;
            }
          } else {
            const blankAttr = blank ? ` target="_blank" rel="noopener noreferrer"` : "";
            editor.insertContent(
              `<a href="${editor.dom.encode(href)}"${blankAttr}>${editor.dom.encode(label || href)}</a>`
            );
          }
        }
        editor.nodeChanged();
        editor.fire("change");
      }
    });
  }

  /**
   * Mở dialog từ chế độ Văn bản (textarea).
   */
  function openFromTextarea(textarea, onInsert) {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    openLinkDialog({
      url: "",
      text: selected || "",
      newTab: false,
      onApply: ({ url, text, newTab }) => {
        const blankAttr = newTab ? ` target="_blank" rel="noopener noreferrer"` : "";
        const html = `<a href="${url}"${blankAttr}>${text || url}</a>`;
        if (typeof onInsert === "function") onInsert(html, { start, end, selected });
      }
    });
  }

  global.CmsLinkUi = {
    bindLinkModal,
    openLinkDialog,
    closeLinkDialog,
    openFromTinyMCE,
    openFromTextarea
  };
})(window);
