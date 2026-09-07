(function () {
  const AUTH_KEY = "timdiemban_token";
  const PENDING_REQUEST_KEY = "findmap_winmap_pending_request";
  let currentStatus = null;
  let currentRequest = null;

  const $ = (id) => document.getElementById(id);

  function authToken() {
    return localStorage.getItem(AUTH_KEY) || "";
  }

  function normalizePending(raw) {
    if (!raw || typeof raw !== "object") return null;
    const requestToken = String(raw.request_token || raw.requestToken || raw.request || "").trim().toUpperCase();
    const compact = requestToken.replace(/-/g, "");
    if (!/^[A-F0-9-]+$/.test(requestToken) || ![16, 32].includes(compact.length)) return null;
    const tenantUrl = String(raw.tenant_url || raw.tenantUrl || "").trim();
    const previewUrl = String(raw.preview_url || raw.previewUrl || "").trim();
    const exchangeUrl = String(raw.exchange_url || raw.exchangeUrl || "").trim();
    if (!tenantUrl || !previewUrl || !exchangeUrl) return null;
    return {
      request_token: requestToken,
      tenant_url: tenantUrl,
      preview_url: previewUrl,
      exchange_url: exchangeUrl
    };
  }

  function pendingRequest() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(PENDING_REQUEST_KEY) || "null");
      const normalized = normalizePending(parsed);
      if (!normalized) {
        sessionStorage.removeItem(PENDING_REQUEST_KEY);
        return null;
      }
      return normalized;
    } catch {
      return null;
    }
  }

  function clearPendingRequest() {
    try {
      sessionStorage.removeItem(PENDING_REQUEST_KEY);
    } catch {}
  }

  function loginUrl() {
    return pendingRequest() ? "/login?redirect=%2Fket-noi-winmap" : "/login";
  }

  async function apiRequest(path, options = {}) {
    const token = authToken();
    if (!token) {
      window.location.replace(loginUrl());
      throw new Error("Chưa đăng nhập Findmap.");
    }
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace(loginUrl());
      throw new Error(data.error || "Phiên Findmap đã hết hạn.");
    }
    if (!response.ok) {
      const error = new Error(data.error || `Lỗi ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function formatDate(value) {
    if (!value) return "Chưa có";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Chưa có";
    return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function showMessage(message, type = "") {
    const element = $("winmapMessage");
    if (!element) return;
    element.textContent = message || "";
    element.className = `jobs-message ${type} ${message ? "" : "hidden"}`.trim();
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyLabel : button.dataset.label;
  }

  function renderRequestPanels() {
    const hasRequest = Boolean(pendingRequest());
    const linked = Boolean(currentStatus?.linked);
    $("winmapApprovalPanel")?.classList.toggle("hidden", !hasRequest);
    $("winmapNoRequestPanel")?.classList.toggle("hidden", hasRequest || linked);
    $("winmapDisconnectPanel")?.classList.toggle("hidden", !linked);
  }

  function renderStatus(status) {
    currentStatus = status || { linked: false };
    const linked = Boolean(currentStatus.linked);
    window.FindmapWinmapNav?.setLinked(linked);
    $("winmapStatusDot")?.classList.toggle("connected", linked);
    $("winmapStatusTitle").textContent = linked ? "Đã kết nối" : "Chưa kết nối";
    $("winmapStatusSubtitle").textContent = linked
      ? "Findmap đã sẵn sàng gửi điểm bán sang Winmap tenant."
      : pendingRequest()
        ? "Có một yêu cầu kết nối từ Winmap tenant đang chờ xác nhận."
        : "Chưa có Winmap tenant được liên kết.";
    $("verifyWinmapBtn")?.classList.toggle("hidden", !linked);
    $("winmapAccountDetails")?.classList.toggle("hidden", !linked);

    if (linked) {
      $("winmapTenantName").textContent = currentStatus.tenant_label || currentStatus.host || "Winmap tenant";
      $("winmapTenantUrl").textContent = currentStatus.tenant_url || "Chưa cung cấp";
      $("winmapImportUrl").textContent = currentStatus.import_url || "Chưa cung cấp";
      $("winmapLinkedAt").textContent = formatDate(currentStatus.linked_at);
    }
    renderRequestPanels();
  }

  async function loadStatus(verify = false) {
    try {
      const status = await apiRequest(`/api/integrations/winmap/status${verify ? "?verify=1" : ""}`);
      renderStatus(status);
      if (status.error) showMessage(status.error, "error");
      else if (verify && status.linked) showMessage("Kết nối Winmap tenant đang hoạt động.", "success");
      return status;
    } catch (error) {
      if (!verify) renderStatus({ linked: false });
      showMessage(error.message, "error");
      return null;
    }
  }

  async function loadConnectionRequest() {
    const request = pendingRequest();
    renderRequestPanels();
    if (!request) return;

    $("winmapRequestLoading").textContent = "Đang kiểm tra yêu cầu.";
    $("winmapRequestLoading").classList.remove("hidden");
    $("winmapRequestDetails").classList.add("hidden");
    $("winmapRequestActions").classList.add("hidden");

    try {
      const response = await apiRequest("/api/integrations/winmap/request-preview", {
        method: "POST",
        body: JSON.stringify(request)
      });
      currentRequest = response.request;
      $("winmapRequestTenant").textContent = currentRequest.tenant_name || "Winmap tenant";
      $("winmapRequestUrl").textContent = currentRequest.tenant_url || request.tenant_url;
      $("winmapRequestExpiresAt").textContent = formatDate(currentRequest.expires_at);
      $("winmapRequestLoading").classList.add("hidden");
      $("winmapRequestDetails").classList.remove("hidden");
      $("winmapRequestActions").classList.remove("hidden");
      $("acceptWinmapBtn").disabled = Boolean(currentStatus?.linked);
      if (currentStatus?.linked) {
        showMessage("Tài khoản Findmap đã có Winmap tenant liên kết. Hãy ngắt liên kết cũ trước.", "error");
      }
    } catch (error) {
      currentRequest = null;
      $("winmapRequestLoading").textContent = error.message;
      if ([409, 410, 422].includes(error.status)) clearPendingRequest();
      renderRequestPanels();
      showMessage(error.message, "error");
    }
  }

  async function acceptConnection() {
    const request = pendingRequest();
    if (!request || !currentRequest || currentStatus?.linked) return;
    const button = $("acceptWinmapBtn");
    setBusy(button, true, "Đang kết nối...");
    $("declineWinmapBtn").disabled = true;
    showMessage("");
    try {
      const status = await apiRequest("/api/integrations/winmap/connect", {
        method: "POST",
        body: JSON.stringify(request)
      });
      clearPendingRequest();
      currentRequest = null;
      renderStatus(status);
      showMessage(status.message || "Đã kết nối Winmap tenant.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false);
      $("declineWinmapBtn").disabled = false;
    }
  }

  async function declineConnection() {
    const request = pendingRequest();
    if (!request) return;
    const button = $("declineWinmapBtn");
    setBusy(button, true, "Đang từ chối...");
    $("acceptWinmapBtn").disabled = true;
    showMessage("");
    try {
      const response = await apiRequest("/api/integrations/winmap/request-decline", {
        method: "POST",
        body: JSON.stringify(request)
      });
      clearPendingRequest();
      currentRequest = null;
      renderRequestPanels();
      showMessage(response.message || "Đã bỏ qua yêu cầu kết nối.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false);
      $("acceptWinmapBtn").disabled = Boolean(currentStatus?.linked);
    }
  }

  async function verify() {
    const button = $("verifyWinmapBtn");
    setBusy(button, true, "Đang kiểm tra...");
    showMessage("");
    await loadStatus(true);
    setBusy(button, false);
  }

  async function disconnect() {
    if (!window.confirm("Ngắt kết nối Winmap tenant? Phiên Findmap hiện tại vẫn được giữ nguyên.")) return;
    const button = $("disconnectWinmapBtn");
    setBusy(button, true, "Đang ngắt...");
    showMessage("");
    try {
      const response = await apiRequest("/api/integrations/winmap/disconnect", { method: "DELETE" });
      renderStatus({ linked: false });
      showMessage(response.message || "Đã ngắt kết nối Winmap tenant.", "success");
      await loadConnectionRequest();
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function logout() {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {}
    localStorage.removeItem(AUTH_KEY);
    window.FindmapSessionCookie?.clearSessionCookie?.();
    window.location.replace(loginUrl());
  }

  async function init() {
    $("acceptWinmapBtn")?.addEventListener("click", acceptConnection);
    $("declineWinmapBtn")?.addEventListener("click", declineConnection);
    $("verifyWinmapBtn")?.addEventListener("click", verify);
    $("disconnectWinmapBtn")?.addEventListener("click", disconnect);
    $("sidebarLogoutBtn")?.addEventListener("click", logout);
    await loadStatus(true);
    await loadConnectionRequest();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
