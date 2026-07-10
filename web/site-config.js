/**
 * site-config.js — trang Cấu hình site nhận dữ liệu (/cau-hinh-site)
 */
(function () {
  const AUTH_KEY = "timdiemban_token";
  const PC = window.TimDiemBanPushConfig;

  let siteState = {
    url: "",
    host: "",
    hasToken: false,
    configured: false
  };
  let pushConfig = PC.parsePushConfig(null);
  let dragSource = null;

  const $ = (id) => document.getElementById(id);

  function getToken() {
    return localStorage.getItem(AUTH_KEY) || "";
  }

  async function apiReq(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...opts, headers });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json().catch(() => ({})) : {};
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    return data;
  }

  function setStatus(text, type = "") {
    const el = $("configStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = `wm-config-status ${type}`;
  }

  function chipLabel(field) {
    return PC.FIELD_LABELS[field] || field;
  }

  function renderPalette() {
    const box = $("fieldPalette");
    if (!box) return;
    box.innerHTML = "";
    PC.SOURCE_FIELDS.forEach((field) => {
      const chip = document.createElement("span");
      chip.className = "wm-field-chip";
      chip.draggable = true;
      chip.dataset.field = field;
      chip.innerHTML = `${chipLabel(field)} <code>${field}</code>`;
      chip.addEventListener("dragstart", (e) => {
        dragSource = field;
        e.dataTransfer?.setData("text/plain", field);
        e.dataTransfer.effectAllowed = "copy";
      });
      chip.addEventListener("dragend", () => {
        dragSource = null;
      });
      box.appendChild(chip);
    });
  }

  function createMappingRow(mapping = { source: "", target: "" }) {
    const row = document.createElement("div");
    row.className = "wm-mapping-row";

    const targetInput = document.createElement("input");
    targetInput.type = "text";
    targetInput.placeholder = "Tên trường API đích";
    targetInput.value = mapping.target || "";
    targetInput.addEventListener("input", updateCurlPreview);

    const arrow = document.createElement("div");
    arrow.className = "wm-mapping-arrow";
    arrow.textContent = "←";

    const drop = document.createElement("div");
    drop.className = "wm-mapping-drop";
    drop.dataset.role = "drop";
    if (mapping.source) {
      drop.classList.add("has-value");
      drop.textContent = `${chipLabel(mapping.source)} (${mapping.source})`;
      drop.dataset.source = mapping.source;
    } else {
      drop.textContent = "Kéo trường Findmap vào đây";
    }

    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drag-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      const field = e.dataTransfer?.getData("text/plain") || dragSource;
      if (!field) return;
      drop.dataset.source = field;
      drop.classList.add("has-value");
      drop.textContent = `${chipLabel(field)} (${field})`;
      if (!targetInput.value.trim()) targetInput.value = field;
      updateCurlPreview();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "wm-mapping-remove";
    removeBtn.title = "Xóa dòng";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      row.remove();
      updateCurlPreview();
    });

    row.appendChild(targetInput);
    row.appendChild(arrow);
    row.appendChild(drop);
    row.appendChild(removeBtn);
    return row;
  }

  function renderMappings() {
    const list = $("mappingList");
    if (!list) return;
    list.innerHTML = "";
    pushConfig.mappings.forEach((m) => list.appendChild(createMappingRow(m)));
    if (!pushConfig.mappings.length) list.appendChild(createMappingRow());
  }

  function collectPushConfig() {
    const rows = $("mappingList")?.querySelectorAll(".wm-mapping-row") || [];
    const mappings = [];
    rows.forEach((row) => {
      const target = row.querySelector("input")?.value?.trim();
      const source = row.querySelector("[data-role=drop]")?.dataset.source || "";
      if (target && source) mappings.push({ source, target });
    });
    return {
      method: $("pushMethod")?.value === "PUT" ? "PUT" : "POST",
      sourceTag: ($("sourceTag")?.value || "timdiemban").trim() || "timdiemban",
      pointsKey: ($("pointsKey")?.value || "points").trim() || "points",
      mappings
    };
  }

  function updateCurlPreview() {
    const preview = $("curlPreview");
    if (!preview) return;
    const url = ($("winmapSite")?.value || siteState.url || "").trim();
    const tokenInput = ($("winmapToken")?.value || "").trim();
    const tokenHint = tokenInput || (siteState.hasToken ? "***" : "");
    preview.value = PC.buildCurlPreview({
      url,
      token: tokenHint,
      pushConfig: collectPushConfig(),
      samplePoint: PC.SAMPLE_POINT
    });
  }

  async function loadSite() {
    try {
      const data = await apiReq("/api/points/site");
      siteState = {
        url: data.url || "",
        host: data.host || "",
        hasToken: Boolean(data.hasToken),
        configured: Boolean(data.configured)
      };
      pushConfig = PC.parsePushConfig(data.pushConfig);
      if ($("winmapSite")) $("winmapSite").value = siteState.url;
      if ($("pushMethod")) $("pushMethod").value = pushConfig.method || "POST";
      if ($("sourceTag")) $("sourceTag").value = pushConfig.sourceTag || "timdiemban";
      if ($("pointsKey")) $("pointsKey").value = pushConfig.pointsKey || "points";
      renderMappings();
      if (siteState.configured) {
        setStatus(`Site: ${siteState.host} (đã có token)`, "connected");
      } else if (siteState.url && !siteState.hasToken) {
        setStatus("Đã lưu site nhưng thiếu token — nhập token rồi Lưu.", "error");
      } else {
        setStatus("Chưa cấu hình site nhận dữ liệu.", "");
      }
      updateCurlPreview();
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  async function saveSite() {
    const url = ($("winmapSite")?.value || "").trim();
    const token = ($("winmapToken")?.value || "").trim();
    const cfg = collectPushConfig();
    if (!url) {
      setStatus("Nhập địa chỉ site (vd: demo.winmap.vn).", "error");
      return;
    }
    if (!cfg.mappings.length) {
      setStatus("Thêm ít nhất một dòng map trường dữ liệu.", "error");
      return;
    }
    const btn = $("saveSiteBtn");
    if (btn) btn.disabled = true;
    try {
      const data = await apiReq("/api/points/site", {
        method: "POST",
        body: JSON.stringify({ url, token, pushConfig: cfg })
      });
      siteState = {
        url: data.url || "",
        host: data.host || "",
        hasToken: Boolean(data.hasToken),
        configured: Boolean(data.configured)
      };
      pushConfig = PC.parsePushConfig(data.pushConfig);
      if ($("winmapToken")) $("winmapToken").value = "";
      setStatus(
        siteState.hasToken
          ? `${data.message} — sẵn sàng gửi từ trang kết quả.`
          : `${data.message} — còn thiếu token.`,
        siteState.hasToken ? "connected" : "error"
      );
      updateCurlPreview();
    } catch (err) {
      setStatus(err.message, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function pingSite() {
    const url = ($("winmapSite")?.value || "").trim() || siteState.url;
    if (!url) {
      setStatus("Nhập địa chỉ site trước khi test.", "error");
      return;
    }
    const btn = $("pingSiteBtn");
    if (btn) btn.disabled = true;
    setStatus("Đang test kết nối…", "");
    try {
      const params = new URLSearchParams({ url });
      const data = await apiReq(`/api/points/ping?${params}`);
      if (data.ok) {
        setStatus(`✓ Kết nối OK — ${data.usedUrl || data.importUrl}`, "connected");
      } else {
        setStatus(`✗ ${data.message}`, "error");
      }
    } catch (err) {
      setStatus(`✗ ${err.message}`, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindMappingListDnD() {
    const list = $("mappingList");
    if (!list) return;
    list.addEventListener("dragover", (e) => e.preventDefault());
    list.addEventListener("drop", (e) => {
      if (e.target.closest(".wm-mapping-drop")) return;
      e.preventDefault();
      const field = e.dataTransfer?.getData("text/plain") || dragSource;
      if (!field) return;
      const row = createMappingRow({ source: field, target: field });
      list.appendChild(row);
      updateCurlPreview();
    });
  }

  function bindAuth() {
    $("sidebarLogoutBtn")?.addEventListener("click", () => {
      apiReq("/api/logout", { method: "POST" }).catch(() => {});
      localStorage.removeItem(AUTH_KEY);
      window.location.replace("/login");
    });
  }

  function init() {
    renderPalette();
    renderMappings();
    bindMappingListDnD();
    bindAuth();

    $("saveSiteBtn")?.addEventListener("click", saveSite);
    $("pingSiteBtn")?.addEventListener("click", pingSite);
    $("addMappingBtn")?.addEventListener("click", () => {
      $("mappingList")?.appendChild(createMappingRow());
      updateCurlPreview();
    });
    $("resetMappingBtn")?.addEventListener("click", () => {
      pushConfig = PC.parsePushConfig(null);
      renderMappings();
      updateCurlPreview();
    });

    ["winmapSite", "winmapToken", "sourceTag", "pointsKey", "pushMethod"].forEach((id) => {
      $(id)?.addEventListener("input", updateCurlPreview);
      $(id)?.addEventListener("change", updateCurlPreview);
    });

    loadSite();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
