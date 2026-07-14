(function () {
  const { api, escapeHtml, slugify } = window.CmsApi;
  const $ = (id) => document.getElementById(id);
  let categories = [];

  function render() {
    const body = $("catsBody");
    if (!body) return;
    if (!categories.length) {
      body.innerHTML = `<tr><td colspan="4" class="cms-empty">Chưa có danh mục</td></tr>`;
      return;
    }
    body.innerHTML = categories
      .map(
        (c) => `<tr>
        <td><strong>${escapeHtml(c.name)}</strong><div class="cms-muted">${escapeHtml(c.description || "")}</div></td>
        <td><code>${escapeHtml(c.slug)}</code></td>
        <td>${c.post_count || 0}</td>
        <td class="cms-row-actions">
          <button type="button" data-cat-edit="${c.id}">Sửa</button>
          <button type="button" data-cat-del="${c.id}">Xóa</button>
        </td>
      </tr>`
      )
      .join("");
  }

  async function load() {
    const data = await api("/api/admin/cms/categories");
    categories = data.categories || [];
    render();
  }

  async function init() {
    const user = await window.CmsShell.bootShell();
    if (!user) return;
    

    await load();

    $("newCatBtn")?.addEventListener("click", () => {
      $("catForm")?.classList.remove("hidden");
      $("catId").value = "";
      $("catName").value = "";
      $("catSlug").value = "";
      $("catDesc").value = "";
    });
    $("catCancelBtn")?.addEventListener("click", () => $("catForm")?.classList.add("hidden"));
    $("catForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = $("catId").value;
      const body = {
        name: $("catName").value.trim(),
        slug: $("catSlug").value.trim() || slugify($("catName").value),
        description: $("catDesc").value.trim()
      };
      try {
        if (id) await api(`/api/admin/cms/categories/${id}`, { method: "PUT", body: JSON.stringify(body) });
        else await api("/api/admin/cms/categories", { method: "POST", body: JSON.stringify(body) });
        $("catForm").classList.add("hidden");
        await load();
      } catch (err) {
        alert(err.message);
      }
    });
    $("catsBody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.dataset.catEdit) {
        const c = categories.find((x) => String(x.id) === String(btn.dataset.catEdit));
        if (!c) return;
        $("catForm").classList.remove("hidden");
        $("catId").value = c.id;
        $("catName").value = c.name;
        $("catSlug").value = c.slug;
        $("catDesc").value = c.description || "";
      }
      if (btn.dataset.catDel) {
        if (!confirm("Xóa danh mục?")) return;
        await api(`/api/admin/cms/categories/${btn.dataset.catDel}`, { method: "DELETE" });
        await load();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
