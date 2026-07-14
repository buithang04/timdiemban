/**
 * cms-media-ui.js — thư viện Media linh hoạt (chọn → cấu hình → chèn)
 */
(function (global) {
  const { api, escapeHtml } = global.CmsApi;

  let pickCallback = null;
  let preferredType = "all";
  /** insert = cấu hình rồi chèn; pick = chọn URL ngay (cover/OG) */
  let pickMode = "insert";
  let selected = null;
  let allItems = [];
  let searchQuery = "";

  function modal() {
    return document.getElementById("mediaModal");
  }

  function sizeStyle(size) {
    const map = { full: "100%", large: "75%", medium: "50%", small: "33%" };
    return map[size] || "100%";
  }

  function alignClass(align) {
    if (align === "left") return "alignleft";
    if (align === "center") return "aligncenter";
    if (align === "right") return "alignright";
    return "";
  }

  function buildMediaHtml(item, opts = {}) {
    const url = item.url;
    const kind = item.kind;
    const alt = String(opts.alt || "").trim();
    const caption = String(opts.caption || "").trim();
    const align = opts.align || "none";
    const size = opts.size || "full";
    const width = sizeStyle(size);
    const cls = alignClass(align);
    const clsAttr = cls ? ` class="${cls}"` : "";
    const style = `max-width:${width};height:auto`;

    if (kind === "video") {
      return `<p${clsAttr}><video controls src="${escapeHtml(url)}" style="${style}"></video></p>`;
    }

    const img = `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="${style}" />`;
    if (caption) {
      const figClass = ["wp-caption", cls].filter(Boolean).join(" ");
      return `<figure class="${figClass}" style="max-width:${width}"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto" /><figcaption class="wp-caption-text">${escapeHtml(caption)}</figcaption></figure>`;
    }
    if (cls === "aligncenter") {
      return `<p style="text-align:center">${img}</p>`;
    }
    if (cls) {
      return `<p><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" class="${cls}" style="${style}" /></p>`;
    }
    return `<p>${img}</p>`;
  }

  function getInsertOptions() {
    return {
      alt: document.getElementById("mediaPickerAlt")?.value || "",
      caption: document.getElementById("mediaPickerCaption")?.value || "",
      align: document.getElementById("mediaPickerAlign")?.value || "none",
      size: document.getElementById("mediaPickerSize")?.value || "full"
    };
  }

  function showDetail(item) {
    selected = item;
    const empty = document.getElementById("mediaPickerEmpty");
    const detail = document.getElementById("mediaPickerDetail");
    if (!detail) return;
    empty?.classList.add("hidden");
    detail.classList.remove("hidden");

    const preview = document.getElementById("mediaPickerPreview");
    if (preview) {
      preview.innerHTML =
        item.kind === "image"
          ? `<img src="${escapeHtml(item.url)}" alt="" />`
          : `<video src="${escapeHtml(item.url)}" controls playsinline></video>`;
    }
    const nameEl = document.getElementById("mediaPickerName");
    if (nameEl) nameEl.textContent = item.name || "";
    const urlEl = document.getElementById("mediaPickerUrl");
    if (urlEl) urlEl.value = item.url || "";

    const isImage = item.kind === "image";
    document.getElementById("mediaPickerAltField")?.classList.toggle("hidden", !isImage);
    document.getElementById("mediaPickerCaptionField")?.classList.toggle("hidden", !isImage);
    document.getElementById("mediaPickerAlignField")?.classList.toggle("hidden", false);
    document.getElementById("mediaPickerSizeField")?.classList.toggle("hidden", false);

    const insertBtn = document.getElementById("mediaPickerInsertBtn");
    if (insertBtn) {
      insertBtn.textContent = pickMode === "pick" ? "Chọn file này" : "Chèn vào bài";
    }

    document.querySelectorAll(".cms-media-card").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.url === item.url);
    });
  }

  function clearDetail() {
    selected = null;
    document.getElementById("mediaPickerEmpty")?.classList.remove("hidden");
    document.getElementById("mediaPickerDetail")?.classList.add("hidden");
    document.getElementById("mediaPickerPreview") && (document.getElementById("mediaPickerPreview").innerHTML = "");
    document.querySelectorAll(".cms-media-card.is-selected").forEach((el) => el.classList.remove("is-selected"));
  }

  function finishPick(item, opts) {
    if (!item || !pickCallback) return;
    const payload = {
      url: item.url,
      kind: item.kind,
      name: item.name,
      alt: opts?.alt || "",
      caption: opts?.caption || "",
      align: opts?.align || "none",
      size: opts?.size || "full",
      html: buildMediaHtml(item, opts || {})
    };
    const cb = pickCallback;
    closeMediaPicker();
    cb(payload);
  }

  function confirmInsert() {
    if (!selected) return;
    if (pickMode === "pick") {
      finishPick(selected, {});
      return;
    }
    finishPick(selected, getInsertOptions());
  }

  function openMediaPicker(opts = {}) {
    pickCallback = typeof opts.onPick === "function" ? opts.onPick : null;
    preferredType = opts.type || "all";
    pickMode = opts.mode === "pick" ? "pick" : "insert";
    searchQuery = "";
    selected = null;

    const el = modal();
    if (!el) {
      console.error("[CmsMediaUi] #mediaModal không tồn tại");
      return;
    }

    const title = document.getElementById("mediaModalTitle");
    if (title) {
      title.textContent =
        opts.title ||
        (pickMode === "pick"
          ? "Chọn từ thư viện Media"
          : preferredType === "video"
            ? "Chèn video từ Media"
            : preferredType === "image"
              ? "Chèn ảnh từ Media"
              : "Thư viện Media");
    }

    const filter = document.getElementById("mediaTypeFilter");
    if (filter) {
      if (preferredType === "image" || preferredType === "video") filter.value = preferredType;
      else filter.value = "all";
    }
    const search = document.getElementById("mediaSearchInput");
    if (search) search.value = "";

    const alt = document.getElementById("mediaPickerAlt");
    const caption = document.getElementById("mediaPickerCaption");
    const align = document.getElementById("mediaPickerAlign");
    const size = document.getElementById("mediaPickerSize");
    if (alt) alt.value = "";
    if (caption) caption.value = "";
    if (align) align.value = "none";
    if (size) size.value = "full";

    // Ẩn tùy chọn chèn khi chỉ pick URL
    const insertOnly = pickMode === "insert";
    document.getElementById("mediaPickerAltField")?.classList.toggle("cms-pick-hide", !insertOnly);
    document.getElementById("mediaPickerCaptionField")?.classList.toggle("cms-pick-hide", !insertOnly);
    document.getElementById("mediaPickerAlignField")?.classList.toggle("cms-pick-hide", !insertOnly);
    document.getElementById("mediaPickerSizeField")?.classList.toggle("cms-pick-hide", !insertOnly);

    clearDetail();
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("cms-modal-open");
    loadMediaGrid();
  }

  function closeMediaPicker() {
    const el = modal();
    if (!el) return;
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    document.body.classList.remove("cms-modal-open");
    pickCallback = null;
    selected = null;
    allItems = [];
  }

  function filteredItems() {
    const type = document.getElementById("mediaTypeFilter")?.value || preferredType || "all";
    const q = searchQuery.trim().toLowerCase();
    return allItems.filter((m) => {
      if (type === "image" || type === "video") {
        if (m.kind !== type) return false;
      }
      if (q && !String(m.name || "").toLowerCase().includes(q) && !String(m.url || "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }

  function renderGrid() {
    const grid = document.getElementById("mediaGrid");
    if (!grid) return;
    const items = filteredItems();
    if (!items.length) {
      grid.innerHTML = `<p class="cms-empty" style="grid-column:1/-1">${
        allItems.length ? "Không khớp bộ lọc / tìm kiếm." : "Chưa có file. Bấm «Tải lên» để thêm ảnh hoặc video."
      }</p>`;
      return;
    }
    grid.innerHTML = items
      .map((m) => {
        const preview =
          m.kind === "image"
            ? `<img src="${escapeHtml(m.url)}" alt="" loading="lazy" />`
            : `<div class="cms-media-video-thumb">▶ Video</div>`;
        const selectedCls = selected && selected.url === m.url ? " is-selected" : "";
        return `<button type="button" class="cms-media-card${selectedCls}" data-url="${escapeHtml(m.url)}" data-kind="${escapeHtml(m.kind)}" data-name="${escapeHtml(m.name)}" title="${escapeHtml(m.name)}">
          <div class="cms-media-thumb">${preview}</div>
          <span>${escapeHtml(m.name)}</span>
        </button>`;
      })
      .join("");
  }

  async function loadMediaGrid() {
    const grid = document.getElementById("mediaGrid");
    if (!grid) return;
    grid.innerHTML = `<p class="cms-muted" style="grid-column:1/-1">Đang tải…</p>`;
    try {
      const data = await api(`/api/admin/cms/media?type=all&limit=300`);
      allItems = data.media || [];
      renderGrid();
    } catch (err) {
      grid.innerHTML = `<p class="cms-msg err" style="grid-column:1/-1">${escapeHtml(err.message)}</p>`;
    }
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return [];
    const msg = document.getElementById("mediaUploadMsg");
    const uploaded = [];
    try {
      if (msg) {
        msg.textContent = files.length > 1 ? `Đang tải ${files.length} file…` : "Đang tải lên…";
        msg.className = "cms-msg";
      }
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const data = await api("/api/admin/cms/media", { method: "POST", body: fd });
        if (data.media) uploaded.push(data.media);
      }
      if (msg) {
        msg.textContent = uploaded.length > 1 ? `Đã tải ${uploaded.length} file` : "Đã tải lên";
        msg.className = "cms-msg ok";
      }
      await loadMediaGrid();
      if (uploaded[0]) showDetail(uploaded[0]);
      return uploaded;
    } catch (err) {
      if (msg) {
        msg.textContent = err.message || "Upload thất bại";
        msg.className = "cms-msg err";
      }
      throw err;
    }
  }

  function bindMediaModal() {
    const el = modal();
    if (!el || el.dataset.bound) return;
    el.dataset.bound = "1";

    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-media]")) {
        closeMediaPicker();
        return;
      }
      const card = e.target.closest(".cms-media-card");
      if (card) {
        const item = {
          url: card.dataset.url,
          kind: card.dataset.kind,
          name: card.dataset.name
        };
        showDetail(item);
        // Double-click = chèn ngay
        if (e.detail === 2) confirmInsert();
      }
    });

    document.getElementById("mediaTypeFilter")?.addEventListener("change", renderGrid);

    let searchTimer = null;
    document.getElementById("mediaSearchInput")?.addEventListener("input", (e) => {
      searchQuery = e.target.value || "";
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderGrid, 120);
    });

    document.getElementById("mediaUploadInput")?.addEventListener("change", async (e) => {
      const files = e.target.files;
      e.target.value = "";
      if (!files?.length) return;
      try {
        await uploadFiles(files);
        // Không tự chèn — để user chỉnh alt/căn rồi bấm Chèn
      } catch {
        /* msg */
      }
    });

    document.getElementById("mediaPickerInsertBtn")?.addEventListener("click", confirmInsert);
    document.getElementById("mediaPickerCopyUrl")?.addEventListener("click", async () => {
      if (!selected?.url) return;
      try {
        await navigator.clipboard.writeText(selected.url);
        const msg = document.getElementById("mediaUploadMsg");
        if (msg) {
          msg.textContent = "Đã copy URL";
          msg.className = "cms-msg ok";
        }
      } catch {
        prompt("Copy URL:", selected.url);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && el && !el.classList.contains("hidden")) closeMediaPicker();
      if (e.key === "Enter" && el && !el.classList.contains("hidden") && selected) {
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        confirmInsert();
      }
    });
  }

  global.CmsMediaUi = {
    openMediaPicker,
    closeMediaPicker,
    loadMediaGrid,
    uploadFile: (file) => uploadFiles([file]).then((arr) => arr[0] || null),
    uploadFiles,
    buildMediaHtml,
    bindMediaModal
  };
})(window);
