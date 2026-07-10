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

  function buildSourceOptions(selected = "") {
    const opts = ['<option value="">— Chọn trường —</option>'];
    PC.SOURCE_FIELDS.forEach((field) => {
      const sel = field === selected ? " selected" : "";
      opts.push(`<option value="${field}"${sel}>${chipLabel(field)} (${field})</option>`);
    });
    return opts.join("");
  }

  function createMappingRow(mapping = { source: "", target: "" }) {
    const tr = document.createElement("tr");
    tr.className = "wm-mapping-row";

    const tdSource = document.createElement("td");
    const sourceSelect = document.createElement("select");
    sourceSelect.className = "wm-mapping-select";
    sourceSelect.innerHTML = buildSourceOptions(mapping.source || "");
    sourceSelect.addEventListener("change", () => {
      const targetInput = tr.querySelector(".wm-mapping-target");
      if (targetInput && !targetInput.value.trim() && sourceSelect.value) {
        targetInput.value = sourceSelect.value;
      }
      updateCurlPreview();
    });
    tdSource.appendChild(sourceSelect);

    const tdArrow = document.createElement("td");
    tdArrow.className = "col-arrow";
    tdArrow.textContent = "→";

    const tdTarget = document.createElement("td");
    const targetInput = document.createElement("input");
    targetInput.type = "text";
    targetInput.className = "wm-mapping-target";
    targetInput.placeholder = "Tên trường API đích";
    targetInput.value = mapping.target || "";
    targetInput.addEventListener("input", updateCurlPreview);
    tdTarget.appendChild(targetInput);

    const tdAction = document.createElement("td");
    tdAction.className = "col-action";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "wm-mapping-remove";
    removeBtn.title = "Xóa dòng";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      tr.remove();
      updateCurlPreview();
    });
    tdAction.appendChild(removeBtn);

    tr.appendChild(tdSource);
    tr.appendChild(tdArrow);
    tr.appendChild(tdTarget);
    tr.appendChild(tdAction);
    return tr;
  }

  function renderMappings() {
    const list = $("mappingList");
    if (!list) return;
    list.innerHTML = "";
    const rows = pushConfig.mappings.length ? pushConfig.mappings : [{ source: "", target: "" }];
    rows.forEach((m) => list.appendChild(createMappingRow(m)));
  }

  function getUrlMode() {
    return $("siteUrlMode")?.value === "custom" ? "custom" : "winmap";
  }

  function updateUrlModeUI() {
    const mode = getUrlMode();
    const input = $("winmapSite");
    const hint = $("urlModeHint");
    if (input) {
      input.placeholder =
        mode === "custom"
          ? "vd: https://api.example.com/v1/leads/import"
          : "vd: newcode.winmap.vn";
    }
    if (hint) {
      hint.innerHTML =
        mode === "custom"
          ? "API tùy chỉnh: nhập <strong>URL endpoint đầy đủ</strong> (path + query nếu có). Hệ thống gọi đúng URL này, không thêm <code>/api/points/import</code>."
          : "Winmap: nhập domain (vd <code>demo.winmap.vn</code>) — hệ thống tự gọi <code>…/api/points/import</code>.";
    }
    updateResolvedUrlHint();
    updateCurlPreview();
  }

  function updateResolvedUrlHint() {
    const el = $("resolvedUrlHint");
    if (!el) return;
    const raw = ($("winmapSite")?.value || siteState.url || "").trim();
    if (!raw) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    const resolved = PC.resolveImportUrl(raw, getUrlMode());
    if (getUrlMode() === "custom" || resolved === raw || resolved.replace(/\/+$/, "") === raw.replace(/\/+$/, "")) {
      el.innerHTML = `URL gửi thực tế: <code>${resolved}</code>`;
    } else {
      el.innerHTML = `URL gửi thực tế: <code>${resolved}</code> (từ <code>${raw}</code>)`;
    }
    el.classList.remove("hidden");
  }

  function collectPushConfig() {
    const rows = $("mappingList")?.querySelectorAll(".wm-mapping-row") || [];
    const mappings = [];
    rows.forEach((row) => {
      const target = row.querySelector(".wm-mapping-target")?.value?.trim();
      const source = row.querySelector(".wm-mapping-select")?.value || "";
      if (target && source) mappings.push({ source, target });
    });
    return {
      method: $("pushMethod")?.value === "PUT" ? "PUT" : "POST",
      sourceTag: ($("sourceTag")?.value || "timdiemban").trim() || "timdiemban",
      pointsKey: ($("pointsKey")?.value || "points").trim() || "points",
      urlMode: getUrlMode(),
      mappings
    };
  }

  function updateCurlPreview() {
    const preview = $("curlPreview");
    if (!preview) return;
    const url = ($("winmapSite")?.value || siteState.url || "").trim();
    const tokenInput = ($("winmapToken")?.value || "").trim();
    const tokenHint = tokenInput || (siteState.hasToken ? "***" : "");
    preview.textContent = PC.buildCurlPreview({
      url,
      token: tokenHint,
      pushConfig: collectPushConfig(),
      samplePoint: PC.SAMPLE_POINT
    });
    updateResolvedUrlHint();
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
      if ($("siteUrlMode")) $("siteUrlMode").value = pushConfig.urlMode === "custom" ? "custom" : "winmap";
      updateUrlModeUI();
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
      setStatus("Chọn ít nhất một dòng map trường dữ liệu.", "error");
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
      const params = new URLSearchParams({ url, urlMode: getUrlMode() });
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

  function bindAuth() {
    $("sidebarLogoutBtn")?.addEventListener("click", () => {
      apiReq("/api/logout", { method: "POST" }).catch(() => {});
      localStorage.removeItem(AUTH_KEY);
      window.location.replace("/login");
    });
  }

  function init() {
    renderMappings();
    bindAuth();
    updateUrlModeUI();

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

    $("siteUrlMode")?.addEventListener("change", updateUrlModeUI);

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
