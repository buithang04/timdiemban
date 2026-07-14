(function () {
  const { api, escapeHtml } = window.CmsApi;

  function statusLabel(s) {
    return { published: "Đã xuất bản", draft: "Nháp", hidden: "Đã ẩn" }[s] || s;
  }
  function seoClass(score) {
    if (score >= 85) return "good";
    if (score >= 65) return "ok";
    if (score >= 45) return "mid";
    return "bad";
  }

  async function loadCategories() {
    const data = await api("/api/admin/cms/categories");
    const sel = document.getElementById("postCategoryFilter");
    if (!sel) return;
    sel.innerHTML =
      `<option value="">Tất cả danh mục</option>` +
      (data.categories || [])
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
  }

  async function loadPosts() {
    const status = document.getElementById("postStatusFilter")?.value || "all";
    const category = document.getElementById("postCategoryFilter")?.value || "";
    const q = document.getElementById("postSearch")?.value.trim() || "";
    const params = new URLSearchParams({ status, limit: "100" });
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    const data = await api(`/api/admin/cms/posts?${params}`);
    const body = document.getElementById("postsBody");
    if (!body) return;
    const posts = data.posts || [];
    if (!posts.length) {
      body.innerHTML = `<tr><td colspan="6" class="cms-empty">Chưa có bài viết</td></tr>`;
      return;
    }
    body.innerHTML = posts
      .map((p) => {
        const date = (p.updated_at || "").slice(0, 16).replace("T", " ");
        return `<tr>
          <td><strong>${escapeHtml(p.title)}</strong><div class="cms-muted">${escapeHtml(p.path || `/${p.slug}`)}</div></td>
          <td>${escapeHtml(p.category_name || "—")}</td>
          <td>
            ${
              p.google_seo_score != null
                ? `<span class="cms-seo-pill ${seoClass(p.google_seo_score)}" title="Lighthouse SEO (PageSpeed)">${p.google_seo_score}</span>
                   <div class="cms-muted">Checklist ${p.seo_score ?? "—"}</div>`
                : `<span class="cms-seo-pill mid" title="Chưa chấm PageSpeed">—</span>
                   <div class="cms-muted">Checklist ${p.seo_score ?? "—"}</div>`
            }
          </td>
          <td><span class="cms-badge ${p.status}">${statusLabel(p.status)}</span></td>
          <td>${escapeHtml(date)}</td>
          <td class="cms-row-actions">
            <a href="/admin-post-editor?id=${encodeURIComponent(p.id)}">Sửa</a>
            ${
              p.status === "published" && p.path
                ? `<a href="${escapeHtml(p.path)}" target="_blank" rel="noopener">Xem bài viết</a>`
                : `<a href="/preview-bai-viet?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Xem trước</a>`
            }
            <button type="button" data-dup="${p.id}">Nhân đôi</button>
            ${p.status !== "published" ? `<button type="button" data-pub="${p.id}">Xuất bản</button>` : ""}
            ${p.status === "published" ? `<button type="button" data-hide="${p.id}">Ẩn</button>` : ""}
            <button type="button" data-trash="${p.id}">Đưa vào thùng rác</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  async function init() {
    const user = await window.CmsShell.bootShell();
    if (!user) return;
    

    await loadCategories();
    await loadPosts();

    document.getElementById("postSearch")?.addEventListener("input", () => {
      clearTimeout(document.getElementById("postSearch")._t);
      document.getElementById("postSearch")._t = setTimeout(loadPosts, 300);
    });
    document.getElementById("postStatusFilter")?.addEventListener("change", loadPosts);
    document.getElementById("postCategoryFilter")?.addEventListener("change", loadPosts);

    document.getElementById("postsBody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const id = btn.dataset.pub || btn.dataset.hide || btn.dataset.trash || btn.dataset.dup;
      if (!id) return;
      try {
        if (btn.dataset.dup) {
          if (!confirm("Tạo bản sao bài viết này (nháp mới)?")) return;
          const data = await api(`/api/admin/cms/posts/${id}/duplicate`, { method: "POST" });
          location.href = `/admin-post-editor?id=${encodeURIComponent(data.post.id)}`;
          return;
        }
        if (btn.dataset.pub) {
          const pub = await api(`/api/admin/cms/posts/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: "published" })
          });
          if (pub.googleError) {
            alert(
              `Đã xuất bản. PageSpeed chưa chấm được: ${pub.googleError}\n(Cần domain public + API key trong SEO & GSC.)`
            );
          }
        }
        if (btn.dataset.hide)
          await api(`/api/admin/cms/posts/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: "hidden" })
          });
        if (btn.dataset.trash) {
          if (!confirm("Đưa bài viết vào thùng rác? Có thể khôi phục trong 30 ngày.")) return;
          await api(`/api/admin/cms/posts/${id}/trash`, { method: "PATCH" });
        }
        await loadPosts();
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById("exportPostsBtn")?.addEventListener("click", async () => {
      const res = await api("/api/admin/cms/export", { raw: true });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `findmap-posts-${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
