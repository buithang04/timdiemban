(function () {
  const { api, escapeHtml, slugify, normalizeWpHtml } = window.CmsApi;
  const $ = (id) => document.getElementById(id);
  let editingId = null;
  let editorReady = false;
  let editorMode = "visual"; // visual | text
  let tagStack = [];

  function countWords(html) {
    const text = String(html || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text ? text.split(" ").length : 0;
  }

  function syncWordCount(html) {
    const n = countWords(html);
    if ($("textWordCount")) $("textWordCount").textContent = `Số từ: ${n}`;
  }

  function getEditorHtml() {
    let html = "";
    if (editorMode === "text") html = $("textEditor")?.value || "";
    else if (window.tinymce?.get("tinymceEditor")) {
      html = window.tinymce.get("tinymceEditor").getContent() || "";
    } else html = $("tinymceEditor")?.value || "";
    return normalizeWpHtml(html);
  }

  function setEditorHtml(html) {
    const value = normalizeWpHtml(html || "");
    if ($("textEditor")) $("textEditor").value = value;
    if (window.tinymce?.get("tinymceEditor")) {
      window.tinymce.get("tinymceEditor").setContent(value);
    } else if ($("tinymceEditor")) {
      $("tinymceEditor").value = value;
    }
    syncWordCount(value);
  }

  function switchMode(mode) {
    if (mode === editorMode) return;
    const html = getEditorHtml();
    editorMode = mode;
    document.querySelectorAll(".cms-wp-tab").forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("visualPane")?.classList.toggle("hidden", mode !== "visual");
    $("textPane")?.classList.toggle("hidden", mode !== "text");
    if (mode === "visual") {
      if (window.tinymce?.get("tinymceEditor")) {
        window.tinymce.get("tinymceEditor").setContent(html);
      }
    } else if ($("textEditor")) {
      $("textEditor").value = html;
      syncWordCount(html);
    }
  }

  function insertAroundSelection(before, after = "") {
    const ta = $("textEditor");
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const selected = value.slice(start, end);
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    ta.value = next;
    const cursor = start + before.length + selected.length + after.length;
    ta.focus();
    ta.setSelectionRange(selected ? cursor : start + before.length, selected ? cursor : start + before.length);
    syncWordCount(next);
    scheduleSeoScore();
  }

  function handleQuicktag(tag) {
    if (tag === "close") {
      const last = tagStack.pop();
      if (last) insertAroundSelection(`</${last}>`, "");
      return;
    }
    if (tag === "link") {
      window.CmsLinkUi.openFromTextarea($("textEditor"), (html) => {
        const ta = $("textEditor");
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.slice(0, start) + html + ta.value.slice(end);
        const cursor = start + html.length;
        ta.focus();
        ta.setSelectionRange(cursor, cursor);
        syncWordCount(ta.value);
        scheduleSeoScore();
      });
      return;
    }
    if (tag === "img") {
      window.CmsMediaUi.openMediaPicker({
        type: "image",
        mode: "insert",
        onPick: (payload) => insertMediaHtml(payload)
      });
      return;
    }
    if (tag === "more") {
      insertAroundSelection("\n<!--more-->\n", "");
      return;
    }
    if (tag === "b-quote") {
      tagStack.push("blockquote");
      insertAroundSelection("<blockquote>", "</blockquote>");
      return;
    }
    const map = {
      b: ["strong", "strong"],
      i: ["em", "em"],
      del: ["del", "del"],
      ins: ["ins", "ins"],
      ul: ["ul", "ul"],
      ol: ["ol", "ol"],
      li: ["li", "li"],
      code: ["code", "code"]
    };
    const pair = map[tag];
    if (!pair) return;
    tagStack.push(pair[0]);
    insertAroundSelection(`<${pair[0]}>`, `</${pair[1]}>`);
  }

  function insertMediaHtml(payload) {
    const html =
      payload?.html ||
      (payload?.kind === "video"
        ? `<p><video controls src="${payload.url}" style="max-width:100%;height:auto"></video></p>`
        : `<p><img src="${payload.url}" alt="${payload.alt || ""}" style="max-width:100%;height:auto" /></p>`);
    if (editorMode === "text") {
      const ta = $("textEditor");
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + html + "\n" + ta.value.slice(end);
      syncWordCount(ta.value);
      scheduleSeoScore();
      return;
    }
    const ed = window.tinymce?.get("tinymceEditor");
    if (ed) {
      ed.insertContent(html);
      ed.focus();
      scheduleSeoScore();
    }
  }

  function openMediaIntoEditor(type) {
    window.CmsMediaUi.openMediaPicker({
      type: type || "all",
      mode: "insert",
      onPick: (payload) => insertMediaHtml(payload)
    });
  }

  function openMediaLibraryForTiny(editor, type) {
    window.CmsMediaUi.openMediaPicker({
      type: type || "image",
      mode: "insert",
      onPick: (payload) => {
        editor.insertContent(
          payload.html ||
            `<p><img src="${payload.url}" alt="" style="max-width:100%;height:auto" /></p>`
        );
        editor.focus();
        scheduleSeoScore();
      }
    });
  }

  async function uploadBlobToMedia(blob, filename) {
    const file =
      blob instanceof File
        ? blob
        : new File([blob], filename || `paste-${Date.now()}.png`, {
            type: blob.type || "image/png"
          });
    if (!window.CmsMediaUi?.uploadFile) {
      throw new Error("Media UI chưa sẵn sàng");
    }
    const item = await window.CmsMediaUi.uploadFile(file);
    if (!item?.url) throw new Error("Upload thất bại");
    return item;
  }

  function initTinyMCE() {
    if (!window.tinymce || editorReady) return Promise.resolve();
    return tinymce
      .init({
        selector: "#tinymceEditor",
        license_key: "gpl",
        language: "vi",
        language_url: "https://cdn.jsdelivr.net/npm/tinymce-i18n/langs7/vi.js",
        min_height: 480,
        max_height: 920,
        resize: true,
        menubar: "file edit view insert format tools table help",
        // Đủ bộ plugin open-source TinyMCE 7 (GPL) — không dùng premium
        plugins: [
          "accordion",
          "advlist",
          "anchor",
          "autolink",
          "autoresize",
          "autosave",
          "charmap",
          "code",
          "codesample",
          "directionality",
          "emoticons",
          "fullscreen",
          "help",
          "image",
          "insertdatetime",
          "link",
          "lists",
          "media",
          "nonbreaking",
          "pagebreak",
          "preview",
          "quickbars",
          "searchreplace",
          "table",
          "visualblocks",
          "visualchars",
          "wordcount"
        ].join(" "),
        toolbar_mode: "sliding",
        toolbar1:
          "undo redo | blocks styles | bold italic underline strikethrough | forecolor backcolor | removeformat",
        toolbar2:
          "alignleft aligncenter alignright alignjustify | bullist numlist outdent indent | wplink unlink anchor | wpimage wpvideo image media | table | blockquote codesample | searchreplace fullscreen",
        toolbar3:
          "fontfamily fontsize | subscript superscript | charmap emoticons hr nonbreaking pagebreak | accordion | ltr rtl | visualblocks visualchars | code preview | restoredraft help",
        quickbars_selection_toolbar: "bold italic underline | wplink | blocks | forecolor",
        quickbars_insert_toolbar: "wpimage wpvideo quicktable | bullist numlist | blockquote hr",
        contextmenu: "wplink link image table lists",
        font_family_formats:
          "Be Vietnam Pro=Be Vietnam Pro,sans-serif;Manrope=Manrope,sans-serif;Arial=arial,helvetica,sans-serif;Georgia=georgia,serif;Times New Roman=times new roman,times,serif;Courier New=courier new,courier,monospace",
        font_size_formats: "12px 14px 15px 16px 18px 20px 24px 28px 32px 36px",
        block_formats:
          "Đoạn văn=p; Tiêu đề 2=h2; Tiêu đề 3=h3; Tiêu đề 4=h4; Tiêu đề 5=h5; Trích dẫn=blockquote; Preformatted=pre",
        style_formats: [
          {
            title: "Đoạn & tiêu đề",
            items: [
              { title: "Đoạn văn", format: "p" },
              { title: "Tiêu đề 2", format: "h2" },
              { title: "Tiêu đề 3", format: "h3" },
              { title: "Tiêu đề 4", format: "h4" }
            ]
          },
          {
            title: "Khối nội dung",
            items: [
              { title: "Trích dẫn", block: "blockquote" },
              { title: "Code inline", inline: "code" },
              { title: "Highlight", inline: "mark" }
            ]
          },
          {
            title: "Ảnh",
            items: [
              { title: "Căn trái", selector: "img", classes: "alignleft" },
              { title: "Căn giữa", selector: "img", classes: "aligncenter" },
              { title: "Căn phải", selector: "img", classes: "alignright" }
            ]
          }
        ],
        formats: {
          mark: { inline: "mark" }
        },
        branding: false,
        promotion: false,
        elementpath: true,
        browser_spellcheck: true,
        paste_data_images: true,
        automatic_uploads: true,
        images_reuse_filename: true,
        images_upload_handler: async (blobInfo) => {
          const item = await uploadBlobToMedia(blobInfo.blob(), blobInfo.filename());
          return item.url;
        },
        convert_urls: false,
        relative_urls: false,
        remove_script_host: true,
        link_default_target: "",
        link_assume_external_targets: false,
        link_title: false,
        default_link_target: "",
        image_title: true,
        image_description: true,
        image_dimensions: true,
        image_caption: true,
        image_advtab: true,
        image_class_list: [
          { title: "Không", value: "" },
          { title: "Căn trái", value: "alignleft" },
          { title: "Căn giữa", value: "aligncenter" },
          { title: "Căn phải", value: "alignright" }
        ],
        table_toolbar:
          "tableprops tabledelete | tableinsertrowbefore tableinsertrowafter tabledeleterow | tableinsertcolbefore tableinsertcolafter tabledeletecol",
        table_appearance_options: true,
        table_advtab: true,
        table_cell_advtab: true,
        table_row_advtab: true,
        media_live_embeds: true,
        media_alt_source: false,
        media_poster: false,
        codesample_languages: [
          { text: "HTML/XML", value: "markup" },
          { text: "JavaScript", value: "javascript" },
          { text: "CSS", value: "css" },
          { text: "PHP", value: "php" },
          { text: "Python", value: "python" },
          { text: "JSON", value: "json" },
          { text: "SQL", value: "sql" },
          { text: "Bash", value: "bash" }
        ],
        insertdatetime_formats: ["%H:%M:%S", "%Y-%m-%d", "%d/%m/%Y", "%d/%m/%Y %H:%M"],
        autosave_ask_before_unload: true,
        autosave_interval: "30s",
        autosave_retention: "30m",
        autoresize_bottom_margin: 24,
        pagebreak_separator: "<!--more-->",
        file_picker_types: "image media file",
        file_picker_callback(callback, _value, meta) {
          const type = meta.filetype === "media" ? "video" : "image";
          window.CmsMediaUi.openMediaPicker({
            type,
            mode: "pick",
            title: type === "video" ? "Chọn video từ thư viện" : "Chọn ảnh từ thư viện",
            onPick: (payload) => {
              callback(payload.url, {
                alt: payload.alt || "",
                title: payload.name || "",
                source: payload.url,
                poster: ""
              });
            }
          });
        },
        content_style: `
          body { font-family: Be Vietnam Pro, Segoe UI, sans-serif; font-size: 15px; line-height: 1.65; color: #0f172a; }
          a { color: #1d4ed8; }
          img, video { max-width: 100%; height: auto; }
          img.alignleft, .alignleft { float: left; margin: 0.35rem 1rem 0.75rem 0; }
          img.alignright, .alignright { float: right; margin: 0.35rem 0 0.75rem 1rem; }
          img.aligncenter, .aligncenter { display: block; margin-left: auto; margin-right: auto; }
          figure.wp-caption, figure.image { margin: 1.25rem auto; max-width: 100%; text-align: center; }
          figure.wp-caption img, figure.image img { display: block; margin: 0 auto; border-radius: 8px; }
          figcaption.wp-caption-text, figcaption { margin-top: 0.45rem; font-size: 0.85rem; color: #64748b; font-style: italic; }
          mark { background: #fef08a; padding: 0 0.15em; }
          pre { background: #f1f5f9; padding: 0.75rem 1rem; border-radius: 8px; overflow: auto; }
          blockquote { border-left: 3px solid #2b59ff; margin: 1rem 0; padding: 0.25rem 0 0.25rem 1rem; color: #334155; }
          table { border-collapse: collapse; width: 100%; }
          table td, table th { border: 1px solid #cbd5e1; padding: 0.4rem 0.55rem; }
          hr.mce-pagebreak { border: 0; border-top: 2px dashed #94a3b8; margin: 1.5rem 0; }
        `,
        setup(editor) {
          editor.on("PastePreProcess", (e) => {
            e.content = normalizeWpHtml(e.content || "");
          });

          editor.ui.registry.addButton("wplink", {
            icon: "link",
            tooltip: "Chèn/sửa đường dẫn",
            onAction: () => window.CmsLinkUi.openFromTinyMCE(editor)
          });
          editor.ui.registry.addMenuItem("wplink", {
            icon: "link",
            text: "Đường dẫn…",
            onAction: () => window.CmsLinkUi.openFromTinyMCE(editor)
          });
          editor.ui.registry.addContextMenu("wplink", {
            update: () => ["wplink"]
          });

          editor.ui.registry.addButton("wpimage", {
            icon: "image",
            tooltip: "Chèn ảnh từ thư viện Media",
            onAction: () => openMediaLibraryForTiny(editor, "image")
          });
          editor.ui.registry.addIcon(
            "wpvideoicon",
            '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 5h12a2 2 0 0 1 2 2v1.5l3-2v9l-3-2V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm1 2v10h10V7H5z" fill="currentColor"/></svg>'
          );
          editor.ui.registry.addButton("wpvideo", {
            icon: "wpvideoicon",
            tooltip: "Chèn video từ thư viện Media",
            onAction: () => openMediaLibraryForTiny(editor, "video")
          });
          editor.ui.registry.addMenuItem("wpimage", {
            icon: "image",
            text: "Ảnh từ thư viện Media…",
            onAction: () => openMediaLibraryForTiny(editor, "image")
          });
          editor.ui.registry.addMenuItem("wpvideo", {
            icon: "wpvideoicon",
            text: "Video từ thư viện Media…",
            onAction: () => openMediaLibraryForTiny(editor, "video")
          });

          // Kéo thả ảnh/video vào editor → upload /media rồi chèn
          editor.on("drop", (e) => {
            const files = e.dataTransfer?.files;
            if (!files?.length) return;
            const mediaFiles = Array.from(files).filter(
              (f) => /^image\//.test(f.type) || /^video\//.test(f.type)
            );
            if (!mediaFiles.length) return;
            e.preventDefault();
            (async () => {
              for (const file of mediaFiles) {
                try {
                  const item = await uploadBlobToMedia(file, file.name);
                  const html =
                    item.kind === "video"
                      ? `<p><video controls src="${item.url}" style="max-width:100%;height:auto"></video></p>`
                      : `<p><img src="${item.url}" alt="" style="max-width:100%;height:auto" /></p>`;
                  editor.insertContent(html);
                } catch (err) {
                  console.error(err);
                  editor.notificationManager.open({
                    text: err.message || "Upload media thất bại",
                    type: "error",
                    timeout: 4000
                  });
                }
              }
              scheduleSeoScore();
            })();
          });

          editor.on("BeforeExecCommand", (e) => {
            if (e.command === "mceLink") {
              e.preventDefault();
              window.CmsLinkUi.openFromTinyMCE(editor);
            }
          });
          editor.on("keydown", (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
              e.preventDefault();
              window.CmsLinkUi.openFromTinyMCE(editor);
            }
          });
          editor.on("change keyup SetContent Undo Redo", () => {
            syncWordCount(editor.getContent());
            scheduleSeoScore();
          });
        }
      })
      .then(() => {
        editorReady = true;
      })
      .catch((err) => {
        console.warn("[TinyMCE] init with vi failed, retry en:", err?.message || err);
        if (editorReady) return null;
        return tinymce.init({
          selector: "#tinymceEditor",
          license_key: "gpl",
          language: "en",
          height: 520,
          plugins:
            "advlist autolink lists link image charmap preview anchor searchreplace visualblocks code fullscreen insertdatetime media table help wordcount quickbars autosave autoresize codesample emoticons nonbreaking pagebreak accordion directionality visualchars",
          toolbar:
            "undo redo | blocks | bold italic | alignleft aligncenter alignright | bullist numlist | wplink wpimage wpvideo | table | code fullscreen",
          menubar: "file edit view insert format tools table help",
          branding: false,
          promotion: false,
          file_picker_types: "image media",
          file_picker_callback(callback, _value, meta) {
            const type = meta.filetype === "media" ? "video" : "image";
            window.CmsMediaUi.openMediaPicker({
              type,
              mode: "pick",
              onPick: (payload) => callback(payload.url, { alt: payload.alt || "" })
            });
          },
          setup(editor) {
            editor.ui.registry.addButton("wplink", {
              icon: "link",
              onAction: () => window.CmsLinkUi.openFromTinyMCE(editor)
            });
            editor.ui.registry.addButton("wpimage", {
              icon: "image",
              onAction: () => openMediaLibraryForTiny(editor, "image")
            });
            editor.ui.registry.addButton("wpvideo", {
              icon: "embed",
              onAction: () => openMediaLibraryForTiny(editor, "video")
            });
            editor.on("change keyup SetContent", () => {
              syncWordCount(editor.getContent());
              scheduleSeoScore();
            });
          }
        }).then(() => {
          editorReady = true;
        });
      });
  }

  function normalizeUrlPath(raw) {
    let s = String(raw == null ? "tin-tuc" : raw).trim().toLowerCase();
    s = s.replace(/^\/+|\/+$/g, "");
    if (!s || s === "." || s === "root") return "";
    return s
      .split("/")
      .map((p) => slugify(p))
      .filter(Boolean)
      .join("/");
  }

  function getUrlPath() {
    const preset = $("urlPathPreset")?.value;
    if (preset === "__custom") return normalizeUrlPath($("urlPathCustom")?.value || "");
    return normalizeUrlPath(preset);
  }

  function setUrlPathUi(urlPath) {
    const path = normalizeUrlPath(urlPath != null ? urlPath : "tin-tuc");
    const preset = $("urlPathPreset");
    const custom = $("urlPathCustom");
    if (!preset) return;
    if (path === "tin-tuc" || path === "") {
      preset.value = path;
      custom?.classList.add("hidden");
      if (custom) custom.value = "";
    } else {
      preset.value = "__custom";
      custom?.classList.remove("hidden");
      if (custom) custom.value = path;
    }
    updateUrlPreview();
  }

  function publicPathPreview() {
    const slug = $("postSlug")?.value.trim() || "…";
    const prefix = getUrlPath();
    return prefix ? `/${prefix}/${slug}` : `/${slug}`;
  }

  function updateUrlPreview() {
    const el = $("urlPreview");
    if (el) el.textContent = `URL công khai: ${publicPathPreview()}`;
  }

  function extractFirstImageFromHtml(html) {
    const re = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
    let m;
    while ((m = re.exec(String(html || "")))) {
      const src = String(m[2] || "").trim();
      if (!src || /^data:/i.test(src)) continue;
      return src;
    }
    return "";
  }

  function updateCoverPreview() {
    const box = $("coverPreview");
    if (!box) return;
    const url = $("postCover")?.value.trim() || "";
    if (!url) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = `<img src="${escapeHtml(url)}" alt="Ảnh nổi bật" />`;
  }

  function applyFirstImageAsCover({ force = false } = {}) {
    const current = $("postCover")?.value.trim() || "";
    if (current && !force) return current;
    const first = extractFirstImageFromHtml(getEditorHtml());
    if (first && $("postCover")) {
      $("postCover").value = first;
      updateCoverPreview();
    }
    return first;
  }

  function collectPost() {
    const cover = $("postCover")?.value.trim() || "";
    const contentHtml = getEditorHtml();
    return {
      title: $("postTitle")?.value.trim() || "",
      slug: $("postSlug")?.value.trim() || "",
      url_path: getUrlPath(),
      excerpt: $("postExcerpt")?.value.trim() || "",
      content_html: contentHtml,
      cover_image: cover,
      og_image: $("postOg")?.value.trim() || "",
      category_id: $("postCategory")?.value || null,
      status: $("postStatus")?.value || "draft",
      focus_keyword: $("focusKeyword")?.value.trim() || "",
      secondary_keywords: $("secondaryKeywords")?.value.trim() || "",
      seo_title: $("seoTitle")?.value.trim() || "",
      seo_description: $("seoDesc")?.value.trim() || "",
      canonical_url: $("canonicalUrl")?.value.trim() || "",
      noindex: Boolean($("postNoindex")?.checked)
    };
  }

  function fillPost(post) {
    editingId = post?.id || null;
    $("postId").value = editingId || "";
    $("postTitle").value = post?.title || "";
    $("postSlug").value = post?.slug || "";
    setUrlPathUi(post?.url_path != null ? post.url_path : "tin-tuc");
    $("postExcerpt").value = post?.excerpt || "";
    $("postCover").value = post?.cover_image || "";
    $("postOg").value = post?.og_image || "";
    $("postStatus").value = post?.status === "trash" ? "draft" : post?.status || "draft";
    $("postCategory").value = post?.category_id || "";
    $("focusKeyword").value = post?.focus_keyword || "";
    $("secondaryKeywords").value = post?.secondary_keywords || "";
    $("seoTitle").value = post?.seo_title || "";
    $("seoDesc").value = post?.seo_description || "";
    $("canonicalUrl").value = post?.canonical_url || "";
    $("postNoindex").checked = Boolean(post?.noindex);
    setEditorHtml(post?.content_html || "");
    updateCharCounts();
    updateUrlPreview();
    updateCoverPreview();
    $("duplicatePostBtn")?.classList.toggle("hidden", !editingId);
    refreshSeoScore();
    renderGoogleScore(parseGoogleFromPost(post));
    syncPreviewButton(post);
  }

  function parseGoogleFromPost(post) {
    if (!post) return null;
    if (post.google_seo_score == null && !post.google_psi_checked_at) return null;
    let detail = {};
    if (post.google_psi_json) {
      try {
        detail = JSON.parse(post.google_psi_json) || {};
      } catch {
        detail = {};
      }
    }
    return {
      seo: post.google_seo_score,
      performance: post.google_performance_score,
      checkedAt: post.google_psi_checked_at,
      ...detail
    };
  }

  function updateCharCounts() {
    if ($("seoTitleCount")) $("seoTitleCount").textContent = `${($("seoTitle")?.value || "").length}/60`;
    if ($("seoDescCount")) $("seoDescCount").textContent = `${($("seoDesc")?.value || "").length}/160`;
  }

  let seoTimer = null;
  function scheduleSeoScore() {
    clearTimeout(seoTimer);
    seoTimer = setTimeout(refreshSeoScore, 400);
  }

  async function refreshSeoScore() {
    try {
      const seo = await api("/api/admin/cms/seo-score", {
        method: "POST",
        body: JSON.stringify(collectPost())
      });
      renderSeo(seo);
    } catch {
      /* ignore */
    }
  }

  function renderSeo(seo) {
    if (!seo) return;
    if ($("seoScoreValue")) $("seoScoreValue").textContent = `${seo.score}`;
    if ($("seoScoreGrade")) $("seoScoreGrade").textContent = seo.grade || "";
    if ($("seoWordCount")) {
      $("seoWordCount").textContent = seo.wordCount != null ? `${seo.wordCount} từ trong nội dung` : "";
    }
    const ul = $("seoChecks");
    if (!ul) return;
    ul.innerHTML = (seo.checks || [])
      .map((c) => {
        const cls = c.pass ? "ok" : c.partial ? "warn" : "fail";
        const mark = c.pass ? "✓" : c.partial ? "!" : "✗";
        return `<li><span class="${cls}">${mark}</span><span>${escapeHtml(c.label)}</span><span>${escapeHtml(c.detail)}</span></li>`;
      })
      .join("");
  }

  function renderGoogleScore(google, meta = {}) {
    const val = $("googleSeoValue");
    const hint = $("googleSeoHint");
    const perf = $("googlePerfLine");
    const ul = $("googleSeoAudits");
    const msg = $("googleSeoMsg");
    if (meta.error) {
      if (msg) {
        msg.textContent = meta.error;
        msg.className = "cms-msg err";
      }
    } else if (msg && !meta.keepMsg) {
      msg.textContent = "";
      msg.className = "cms-msg";
    }
    if (!google || google.seo == null) {
      if (val) val.textContent = "—";
      if (hint) hint.textContent = "Chưa chấm";
      if (perf) perf.textContent = "";
      if (ul) ul.innerHTML = "";
      return;
    }
    if (val) val.textContent = `${google.seo}`;
    if (hint) {
      const t = google.checkedAt || google.fetchedAt || "";
      hint.textContent = t ? `Mobile · ${String(t).slice(0, 19).replace("T", " ")}` : "Mobile";
    }
    if (perf) {
      const parts = [];
      if (google.performance != null) parts.push(`Performance ${google.performance}`);
      const m = google.metrics || {};
      if (m.lcpMs != null) parts.push(`LCP ${Math.round(m.lcpMs)}ms`);
      if (m.cls != null) parts.push(`CLS ${Number(m.cls).toFixed(3)}`);
      perf.textContent = parts.join(" · ");
    }
    if (ul) {
      const fails = google.seoAuditsFailed || [];
      ul.innerHTML = fails.length
        ? fails
            .map(
              (a) =>
                `<li><span class="fail">✗</span><span>${escapeHtml(a.title)}</span><span>${escapeHtml(a.description || "")}</span></li>`
            )
            .join("")
        : `<li><span class="ok">✓</span><span>Không có audit SEO lỗi rõ</span><span></span></li>`;
    }
  }

  async function refreshGoogleScore() {
    const msg = $("googleSeoMsg");
    if (!editingId) {
      if (msg) {
        msg.textContent = "Lưu / xuất bản bài trước khi chấm Google.";
        msg.className = "cms-msg err";
      }
      return;
    }
    if (msg) {
      msg.textContent = "Đang gọi PageSpeed Insights (có thể mất 15–60 giây)…";
      msg.className = "cms-msg";
    }
    try {
      const data = await api(`/api/admin/cms/posts/${encodeURIComponent(editingId)}/google-score`, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (data.post) {
        $("postStatus").value = data.post.status || $("postStatus").value;
        syncPreviewButton(data.post);
      }
      renderGoogleScore(data.google);
      if (msg) {
        msg.textContent = data.pageUrl ? `Đã chấm: ${data.pageUrl}` : "Đã cập nhật điểm Google";
        msg.className = "cms-msg ok";
      }
    } catch (err) {
      renderGoogleScore(null, { error: err.message || "Chấm Google thất bại" });
    }
  }

  async function loadCategories() {
    const data = await api("/api/admin/cms/categories");
    $("postCategory").innerHTML =
      `<option value="">— Không chọn —</option>` +
      (data.categories || []).map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  }

  async function savePost(e) {
    if (e) e.preventDefault();
    const body = collectPost();
    if (!body.title) {
      alert("Nhập tiêu đề trước khi lưu.");
      return null;
    }
    const msg = $("postSaveMsg");
    try {
      const path = editingId ? `/api/admin/cms/posts/${editingId}` : "/api/admin/cms/posts";
      const method = editingId ? "PUT" : "POST";
      const data = await api(path, { method, body: JSON.stringify(body) });
      editingId = data.post.id;
      $("postId").value = editingId;
      $("postSlug").value = data.post.slug;
      setUrlPathUi(data.post.url_path);
      if ($("postCover")) {
        $("postCover").value = data.post.cover_image || "";
        updateCoverPreview();
      }
      $("duplicatePostBtn")?.classList.remove("hidden");
      renderSeo(data.seo);
      renderGoogleScore(data.google || parseGoogleFromPost(data.post), {
        error: data.googleError || null
      });
      updateUrlPreview();
      syncPreviewButton(data.post);
      if (msg) {
        const g = data.post?.google_seo_score;
        const parts = [`Đã lưu — checklist ${data.seo.score}/100`];
        if (g != null) parts.push(`Google SEO ${g}`);
        if (data.googleError) parts.push(`(PSI: ${data.googleError})`);
        msg.textContent = parts.join(" · ");
        msg.className = data.googleError ? "cms-msg warn" : "cms-msg ok";
      }
      if (!location.search.includes("id=")) {
        history.replaceState(null, "", `/admin-post-editor?id=${encodeURIComponent(editingId)}`);
      }
      return data.post;
    } catch (err) {
      if (msg) {
        msg.textContent = err.message;
        msg.className = "cms-msg err";
      }
      return null;
    }
  }

  function publicPathOf(post) {
    if (post?.path) return post.path;
    const slug = post?.slug || $("postSlug")?.value.trim() || "";
    if (!slug) return "";
    const prefix = String(post?.url_path != null ? post.url_path : getUrlPath())
      .replace(/^\/+|\/+$/g, "");
    return prefix ? `/${prefix}/${encodeURIComponent(slug)}` : `/${encodeURIComponent(slug)}`;
  }

  function syncPreviewButton(post) {
    const btn = $("previewPostBtn");
    if (!btn) return;
    const status = post?.status || $("postStatus")?.value || "draft";
    const published = status === "published";
    btn.textContent = published ? "Xem bài viết" : "Xem trước";
    btn.title = published
      ? "Mở URL công khai của bài đã xuất bản"
      : "Lưu và xem trước bài chưa công khai";
    btn.dataset.mode = published ? "public" : "preview";
    const path = publicPathOf(post);
    if (path) btn.dataset.publicPath = path;
    else delete btn.dataset.publicPath;
  }

  async function previewPost() {
    const post = await savePost();
    if (!post?.id) return;
    syncPreviewButton(post);
    if (post.status === "published") {
      const url = publicPathOf(post);
      if (!url) {
        alert("Thiếu đường dẫn công khai của bài viết.");
        return;
      }
      window.open(url, "_blank", "noopener");
      return;
    }
    window.open(`/preview-bai-viet?id=${encodeURIComponent(post.id)}`, "_blank", "noopener");
  }

  async function init() {
    const user = await window.CmsShell.bootShell();
    if (!user) return;
    

    window.CmsMediaUi.bindMediaModal();
    window.CmsLinkUi.bindLinkModal();
    await initTinyMCE();
    await loadCategories();

    const id = new URLSearchParams(location.search).get("id");
    if (id) {
      const data = await api(`/api/admin/cms/posts/${id}`);
      fillPost(data.post);
      renderSeo(data.seo);
      renderGoogleScore(data.google || parseGoogleFromPost(data.post));
    } else {
      fillPost(null);
    }

    $("postForm")?.addEventListener("submit", savePost);
    $("genSlugBtn")?.addEventListener("click", () => {
      $("postSlug").value = slugify($("postTitle").value);
      updateUrlPreview();
      scheduleSeoScore();
    });
    $("urlPathPreset")?.addEventListener("change", () => {
      const custom = $("urlPathCustom");
      if ($("urlPathPreset").value === "__custom") {
        custom?.classList.remove("hidden");
        custom?.focus();
      } else custom?.classList.add("hidden");
      updateUrlPreview();
      scheduleSeoScore();
    });
    $("urlPathCustom")?.addEventListener("input", () => {
      updateUrlPreview();
      scheduleSeoScore();
    });
    $("refreshSeoBtn")?.addEventListener("click", refreshSeoScore);
    $("refreshGoogleSeoBtn")?.addEventListener("click", refreshGoogleScore);
    $("previewPostBtn")?.addEventListener("click", previewPost);
    $("postStatus")?.addEventListener("change", () => {
      syncPreviewButton({
        status: $("postStatus").value,
        slug: $("postSlug")?.value,
        url_path: getUrlPath(),
        path: $("previewPostBtn")?.dataset.publicPath || ""
      });
    });
    $("addMediaBtn")?.addEventListener("click", () => openMediaIntoEditor("all"));
    $("useFirstImageBtn")?.addEventListener("click", () => {
      const src = applyFirstImageAsCover({ force: true });
      if (!src) alert("Không tìm thấy ảnh trong nội dung bài viết.");
      else scheduleSeoScore();
    });
    $("postCover")?.addEventListener("input", updateCoverPreview);
    $("duplicatePostBtn")?.addEventListener("click", async () => {
      if (!editingId) return;
      if (!confirm("Tạo bản sao bài viết này (nháp mới)?")) return;
      try {
        const data = await api(`/api/admin/cms/posts/${editingId}/duplicate`, { method: "POST" });
        location.href = `/admin-post-editor?id=${encodeURIComponent(data.post.id)}`;
      } catch (err) {
        alert(err.message || "Nhân đôi thất bại");
      }
    });

    document.querySelectorAll(".cms-wp-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchMode(btn.dataset.mode));
    });
    $("quicktags")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tag]");
      if (!btn) return;
      handleQuicktag(btn.dataset.tag);
    });
    $("textEditor")?.addEventListener("input", () => {
      syncWordCount($("textEditor").value);
      scheduleSeoScore();
    });
    $("textEditor")?.addEventListener("paste", () => {
      setTimeout(() => {
        const ta = $("textEditor");
        if (!ta) return;
        const next = normalizeWpHtml(ta.value);
        if (next !== ta.value) {
          const pos = ta.selectionStart;
          ta.value = next;
          ta.setSelectionRange(pos, pos);
          syncWordCount(next);
          scheduleSeoScore();
        }
      }, 0);
    });

    document.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.pick;
        window.CmsMediaUi.openMediaPicker({
          type: "image",
          mode: "pick",
          title: target === "og" ? "Chọn ảnh OG" : "Chọn ảnh nổi bật",
          onPick: ({ url }) => {
            if (target === "cover") {
              $("postCover").value = url;
              updateCoverPreview();
            }
            if (target === "og") $("postOg").value = url;
            scheduleSeoScore();
          }
        });
      });
    });

    [
      "postTitle",
      "postSlug",
      "postExcerpt",
      "focusKeyword",
      "secondaryKeywords",
      "seoTitle",
      "seoDesc",
      "postCover",
      "postOg"
    ].forEach((id) => {
      $(id)?.addEventListener("input", () => {
        updateCharCounts();
        if (id === "postSlug") updateUrlPreview();
        scheduleSeoScore();
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
