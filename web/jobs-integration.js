(function () {
  const AUTH_KEY = "timdiemban_token";
  const PENDING_REQUEST_KEY = "findmap_jobs_pending_request";
  let currentStatus = null;
  let currentRequest = null;

  const $ = (id) => document.getElementById(id);

  function authToken() {
    return localStorage.getItem(AUTH_KEY) || "";
  }

  function pendingRequestToken() {
    try {
      const token = String(sessionStorage.getItem(PENDING_REQUEST_KEY) || "").trim().toUpperCase();
      const compact = token.replace(/-/g, "");
      if (!/^[A-F0-9-]+$/.test(token) || ![16, 32].includes(compact.length)) {
        sessionStorage.removeItem(PENDING_REQUEST_KEY);
        return "";
      }
      return token;
    } catch {
      return "";
    }
  }

  function clearPendingRequest() {
    try {
      sessionStorage.removeItem(PENDING_REQUEST_KEY);
    } catch {}
  }

  function loginUrl() {
    return pendingRequestToken() ? "/login?redirect=%2Fket-noi-jobs" : "/login";
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
    const element = $("jobsMessage");
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
    const hasRequest = Boolean(pendingRequestToken());
    const linked = Boolean(currentStatus?.linked);
    $("jobsApprovalPanel")?.classList.toggle("hidden", !hasRequest);
    $("jobsNoRequestPanel")?.classList.toggle("hidden", hasRequest || linked);
    $("jobsDisconnectPanel")?.classList.toggle("hidden", !linked);
  }

  function renderStatus(status) {
    currentStatus = status || { linked: false };
    const linked = Boolean(currentStatus.linked);
    window.FindmapJobsNav?.setLinked(linked);
    $("jobsStatusDot")?.classList.toggle("connected", linked);
    $("jobsStatusTitle").textContent = linked ? "Đã kết nối" : "Chưa kết nối";
    $("jobsStatusSubtitle").textContent = linked
      ? "Sẵn sàng nhận khách hàng từ Findmap."
      : pendingRequestToken()
        ? "Có một yêu cầu kết nối đang chờ xác nhận."
        : "Chưa có tài khoản Jobs ClickOn được liên kết.";
    $("verifyJobsBtn")?.classList.toggle("hidden", !linked);
    $("jobsAccountDetails")?.classList.toggle("hidden", !linked);

    if (linked) {
      $("jobsUserName").textContent = currentStatus.name || `Jobs #${currentStatus.jobs_user_id}`;
      $("jobsUserEmail").textContent = currentStatus.email || "Chưa cung cấp";
      $("jobsDepartment").textContent = currentStatus.department_id
        ? `Phòng ban #${currentStatus.department_id}`
        : "Chưa gán";
      $("jobsLinkedAt").textContent = formatDate(currentStatus.linked_at);
      $("jobsLastSyncAt").textContent = formatDate(currentStatus.last_sync_at);
    }
    renderRequestPanels();
  }

  async function loadStatus(verify = false) {
    try {
      const status = await apiRequest(`/api/integrations/jobs/status${verify ? "?verify=1" : ""}`);
      renderStatus(status);
      if (status.error) showMessage(status.error, "error");
      else if (verify) showMessage("Kết nối Jobs ClickOn đang hoạt động.", "success");
      return status;
    } catch (error) {
      if (!verify) renderStatus({ linked: false });
      showMessage(error.message, "error");
      return null;
    }
  }

  async function loadConnectionRequest() {
    const requestToken = pendingRequestToken();
    renderRequestPanels();
    if (!requestToken) return;

    $("jobsRequestLoading").textContent = "Đang kiểm tra yêu cầu.";
    $("jobsRequestLoading").classList.remove("hidden");
    $("jobsRequestDetails").classList.add("hidden");
    $("jobsRequestActions").classList.add("hidden");

    try {
      const response = await apiRequest("/api/integrations/jobs/request-preview", {
        method: "POST",
        body: JSON.stringify({ request_token: requestToken })
      });
      currentRequest = response.request;
      $("jobsRequestName").textContent = currentRequest.name || `Jobs #${currentRequest.jobs_user_id}`;
      $("jobsRequestEmail").textContent = currentRequest.email || "Chưa cung cấp";
      $("jobsRequestDepartment").textContent = currentRequest.department_name
        || (currentRequest.department_id ? `Phòng ban #${currentRequest.department_id}` : "Chưa gán");
      $("jobsRequestExpiresAt").textContent = formatDate(currentRequest.expires_at);
      $("jobsRequestLoading").classList.add("hidden");
      $("jobsRequestDetails").classList.remove("hidden");
      $("jobsRequestActions").classList.remove("hidden");
      $("acceptJobsBtn").disabled = Boolean(currentStatus?.linked);
      if (currentStatus?.linked) {
        showMessage("Tài khoản Findmap đã có liên kết. Hãy ngắt liên kết cũ trước.", "error");
      }
    } catch (error) {
      currentRequest = null;
      $("jobsRequestLoading").textContent = error.message;
      if ([409, 410, 422].includes(error.status)) clearPendingRequest();
      renderRequestPanels();
      showMessage(error.message, "error");
    }
  }

  async function acceptConnection() {
    const requestToken = pendingRequestToken();
    if (!requestToken || !currentRequest || currentStatus?.linked) return;
    const button = $("acceptJobsBtn");
    setBusy(button, true, "Đang kết nối...");
    $("declineJobsBtn").disabled = true;
    showMessage("");
    try {
      const status = await apiRequest("/api/integrations/jobs/connect", {
        method: "POST",
        body: JSON.stringify({ request_token: requestToken })
      });
      clearPendingRequest();
      currentRequest = null;
      renderStatus(status);
      showMessage(status.message || "Đã kết nối Jobs ClickOn.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false);
      $("declineJobsBtn").disabled = false;
    }
  }

  async function declineConnection() {
    const requestToken = pendingRequestToken();
    if (!requestToken) return;
    const button = $("declineJobsBtn");
    setBusy(button, true, "Đang từ chối...");
    $("acceptJobsBtn").disabled = true;
    showMessage("");
    try {
      const response = await apiRequest("/api/integrations/jobs/request-decline", {
        method: "POST",
        body: JSON.stringify({ request_token: requestToken })
      });
      clearPendingRequest();
      currentRequest = null;
      renderRequestPanels();
      showMessage(response.message || "Đã từ chối yêu cầu kết nối.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false);
      $("acceptJobsBtn").disabled = Boolean(currentStatus?.linked);
    }
  }

  async function verify() {
    const button = $("verifyJobsBtn");
    setBusy(button, true, "Đang kiểm tra...");
    showMessage("");
    await loadStatus(true);
    setBusy(button, false);
  }

  async function disconnect() {
    if (!window.confirm("Ngắt kết nối Jobs ClickOn? Phiên Findmap hiện tại vẫn được giữ nguyên.")) return;
    const button = $("disconnectJobsBtn");
    setBusy(button, true, "Đang ngắt...");
    showMessage("");
    try {
      const response = await apiRequest("/api/integrations/jobs/disconnect", { method: "DELETE" });
      renderStatus({ linked: false });
      showMessage(response.message || "Đã ngắt kết nối Jobs ClickOn.", "success");
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
    $("acceptJobsBtn")?.addEventListener("click", acceptConnection);
    $("declineJobsBtn")?.addEventListener("click", declineConnection);
    $("verifyJobsBtn")?.addEventListener("click", verify);
    $("disconnectJobsBtn")?.addEventListener("click", disconnect);
    $("sidebarLogoutBtn")?.addEventListener("click", logout);
    await loadStatus(true);
    await loadConnectionRequest();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
