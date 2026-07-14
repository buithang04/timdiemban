(function () {
  const { api, escapeHtml } = window.CmsApi;

  async function loadTrash() {
    const data = await api("/api/admin/cms/posts?status=trash&limit=100");
    const body = document.getElementById("trashBody");
    if (!body) return;
    const posts = data.posts || [];
    const hint = document.getElementById("trashHint");
    if (hint) hint.textContent = posts.length
      ? `${posts.length} bài trong thùng rác — tự xóa sau 30 ngày.`
      : "Thùng rác trống.";
    if (!posts.length) {
      body.innerHTML = `<tr><td colspan="5" class="cms-empty">Thùng rác trống</td></tr>`;
      return;
    }
    body.innerHTML = posts
      .map((p) => {
        const trashed = (p.trashed_at || "").slice(0, 16).replace("T", " ");
        const days =
          p.daysLeft != null ? `${p.daysLeft} ngày` : "—";
        return `<tr>
          <td><strong>${escapeHtml(p.title)}</strong><div class="cms-muted">${escapeHtml(p.path || `/${p.slug}`)}</div></td>
          <td>${escapeHtml(p.category_name || "—")}</td>
          <td>${escapeHtml(trashed || "—")}</td>
          <td><span class="cms-badge trash">${escapeHtml(days)}</span></td>
          <td class="cms-row-actions">
            <button type="button" data-restore="${p.id}">Khôi phục</button>
            <button type="button" class="danger" data-purge="${p.id}">Xóa vĩnh viễn</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  async function init() {
    const user = await window.CmsShell.bootShell();
    if (!user) return;
    

    await loadTrash();

    document.getElementById("trashBody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const id = btn.dataset.restore || btn.dataset.purge;
      if (!id) return;
      try {
        if (btn.dataset.restore) {
          await api(`/api/admin/cms/posts/${id}/restore`, { method: "PATCH" });
        }
        if (btn.dataset.purge) {
          if (!confirm("Xóa vĩnh viễn? Không thể hoàn tác.")) return;
          await api(`/api/admin/cms/posts/${id}`, { method: "DELETE" });
        }
        await loadTrash();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
