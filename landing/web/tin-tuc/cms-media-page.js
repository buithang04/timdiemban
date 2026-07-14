(function () {
  const { api, escapeHtml } = window.CmsApi;

  let current = null;
  let rotateDeg = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function formatSize(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  function cacheBust(url) {
    const u = String(url || "");
    const sep = u.includes("?") ? "&" : "?";
    return `${u}${sep}t=${Date.now()}`;
  }

  async function loadGrid() {
    const grid = $("mediaPageGrid");
    if (!grid) return;
    const type = $("mediaTypeFilter")?.value || "all";
    grid.innerHTML = `<p class="cms-muted">Đang tải…</p>`;
    try {
      const data = await api(`/api/admin/cms/media?type=${encodeURIComponent(type)}&limit=300`);
      const items = data.media || [];
      if (!items.length) {
        grid.innerHTML = `<p class="cms-empty">Chưa có media. Tải ảnh hoặc video lên thư mục /media.</p>`;
        return;
      }
      grid.innerHTML = items
        .map((m) => {
          const preview =
            m.kind === "image"
              ? `<img src="${escapeHtml(m.url)}" alt="" loading="lazy" />`
              : `<div class="cms-media-video-thumb">▶ Video</div>`;
          return `<button type="button" class="cms-media-card cms-media-card-open"
            data-open-media
            data-name="${escapeHtml(m.name)}"
            data-url="${escapeHtml(m.url)}"
            data-kind="${escapeHtml(m.kind)}"
            data-size="${escapeHtml(String(m.size || 0))}"
            data-updated="${escapeHtml(m.updated_at || "")}"
            title="Xem / chỉnh sửa">
            <div class="cms-media-thumb">${preview}</div>
            <span title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
            <code class="cms-media-url">${escapeHtml(m.url)}</code>
          </button>`;
        })
        .join("");
    } catch (err) {
      grid.innerHTML = `<p class="cms-msg err">${escapeHtml(err.message)}</p>`;
    }
  }

  function setDetailMsg(text, ok) {
    const el = $("mediaDetailMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = `cms-msg${text ? (ok ? " ok" : " err") : ""}`;
  }

  function renderPreview() {
    const box = $("mediaDetailPreview");
    if (!box || !current) return;
    const url = cacheBust(current.url);
    if (current.kind === "video") {
      box.innerHTML = `<video src="${escapeHtml(url)}" controls playsinline></video>`;
      return;
    }
    const rot = rotateDeg ? ` style="transform:rotate(${rotateDeg}deg)"` : "";
    box.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(current.name)}"${rot} />`;
  }

  function openDetail(item) {
    current = { ...item };
    rotateDeg = 0;
    const modal = $("mediaDetailModal");
    if (!modal) return;
    $("mediaDetailName").value = current.name;
    $("mediaDetailUrl").value = current.url;
    $("mediaDetailMeta").textContent = `${current.kind === "image" ? "Ảnh" : "Video"} · ${formatSize(current.size)}${
      current.updated_at ? ` · ${new Date(current.updated_at).toLocaleString("vi-VN")}` : ""
    }`;
    const rotateRow = $("mediaRotateActions");
    if (rotateRow) rotateRow.classList.toggle("hidden", current.kind !== "image");
    setDetailMsg("");
    renderPreview();
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("cms-modal-open");
  }

  function closeDetail() {
    const modal = $("mediaDetailModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("cms-modal-open");
    current = null;
    rotateDeg = 0;
    const box = $("mediaDetailPreview");
    if (box) box.innerHTML = "";
  }

  async function saveRename() {
    if (!current) return;
    const newName = String($("mediaDetailName")?.value || "").trim();
    if (!newName) {
      setDetailMsg("Nhập tên file", false);
      return;
    }
    if (newName === current.name) {
      setDetailMsg("Không có thay đổi tên", true);
      return;
    }
    try {
      setDetailMsg("Đang đổi tên…", true);
      const data = await api(`/api/admin/cms/media/${encodeURIComponent(current.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName })
      });
      current = data.media;
      rotateDeg = 0;
      $("mediaDetailName").value = current.name;
      $("mediaDetailUrl").value = current.url;
      renderPreview();
      setDetailMsg("Đã đổi tên", true);
      await loadGrid();
    } catch (err) {
      setDetailMsg(err.message || "Đổi tên thất bại", false);
    }
  }

  async function replaceWithFile(file) {
    if (!current || !file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      setDetailMsg("Đang thay file…", true);
      const data = await api(`/api/admin/cms/media/${encodeURIComponent(current.name)}/replace`, {
        method: "POST",
        body: fd
      });
      current = data.media;
      rotateDeg = 0;
      $("mediaDetailMeta").textContent = `${current.kind === "image" ? "Ảnh" : "Video"} · ${formatSize(current.size)} · vừa cập nhật`;
      renderPreview();
      setDetailMsg("Đã thay file", true);
      await loadGrid();
    } catch (err) {
      setDetailMsg(err.message || "Thay file thất bại", false);
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Không tải được ảnh để chỉnh"));
      img.src = cacheBust(url);
    });
  }

  async function saveRotated() {
    if (!current || current.kind !== "image") return;
    if (!rotateDeg) {
      setDetailMsg("Xoay ảnh trước khi lưu", false);
      return;
    }
    try {
      setDetailMsg("Đang lưu ảnh đã xoay…", true);
      const img = await loadImage(current.url);
      const rad = ((rotateDeg % 360) + 360) % 360;
      const swap = rad === 90 || rad === 270;
      const canvas = document.createElement("canvas");
      canvas.width = swap ? img.naturalHeight : img.naturalWidth;
      canvas.height = swap ? img.naturalWidth : img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rad * Math.PI) / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      const mime = /\.png$/i.test(current.name)
        ? "image/png"
        : /\.webp$/i.test(current.name)
          ? "image/webp"
          : "image/jpeg";
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Không xuất được ảnh"))),
          mime,
          mime === "image/jpeg" ? 0.92 : undefined
        );
      });
      const file = new File([blob], current.name, { type: mime });
      await replaceWithFile(file);
      rotateDeg = 0;
      renderPreview();
    } catch (err) {
      setDetailMsg(err.message || "Lưu xoay thất bại", false);
    }
  }

  async function deleteCurrent() {
    if (!current) return;
    if (!confirm(`Xóa ${current.name}?`)) return;
    try {
      await api(`/api/admin/cms/media/${encodeURIComponent(current.name)}`, { method: "DELETE" });
      closeDetail();
      await loadGrid();
    } catch (err) {
      setDetailMsg(err.message || "Xóa thất bại", false);
    }
  }

  async function init() {
    const user = await window.CmsShell.bootShell();
    if (!user) return;

    await loadGrid();

    $("mediaTypeFilter")?.addEventListener("change", loadGrid);

    $("mediaUploadInput")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const msg = $("mediaUploadMsg");
      const fd = new FormData();
      fd.append("file", file);
      try {
        if (msg) {
          msg.textContent = "Đang tải lên…";
          msg.className = "cms-msg";
        }
        await api("/api/admin/cms/media", { method: "POST", body: fd });
        if (msg) {
          msg.textContent = "Đã tải lên";
          msg.className = "cms-msg ok";
        }
        await loadGrid();
      } catch (err) {
        if (msg) {
          msg.textContent = err.message;
          msg.className = "cms-msg err";
        }
      }
    });

    $("mediaPageGrid")?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-open-media]");
      if (!card) return;
      openDetail({
        name: card.dataset.name,
        url: card.dataset.url,
        kind: card.dataset.kind,
        size: Number(card.dataset.size) || 0,
        updated_at: card.dataset.updated || ""
      });
    });

    $("mediaDetailModal")?.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-detail]")) closeDetail();
    });

    document.addEventListener("keydown", (e) => {
      const modal = $("mediaDetailModal");
      if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) closeDetail();
    });

    $("mediaDetailSaveName")?.addEventListener("click", saveRename);
    $("mediaDetailCopyUrl")?.addEventListener("click", async () => {
      if (!current) return;
      try {
        await navigator.clipboard.writeText(current.url);
        setDetailMsg("Đã copy URL", true);
      } catch {
        prompt("Copy URL:", current.url);
      }
    });
    $("mediaDetailDelete")?.addEventListener("click", deleteCurrent);
    $("mediaDetailReplaceInput")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) await replaceWithFile(file);
    });
    $("mediaRotateLeft")?.addEventListener("click", () => {
      rotateDeg = (rotateDeg - 90) % 360;
      renderPreview();
    });
    $("mediaRotateRight")?.addEventListener("click", () => {
      rotateDeg = (rotateDeg + 90) % 360;
      renderPreview();
    });
    $("mediaRotateSave")?.addEventListener("click", saveRotated);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
