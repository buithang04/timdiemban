(function () {
  const AUTH_KEY = "timdiemban_token";
  let currentStatus = null;

  const $ = (id) => document.getElementById(id);

  function authToken() {
    return localStorage.getItem(AUTH_KEY) || "";
  }

  async function apiRequest(path, options = {}) {
    const token = authToken();
    if (!token) {
      window.location.replace("/login");
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
      window.location.replace("/login");
      throw new Error(data.error || "Phiên Findmap đã hết hạn.");
    }
    if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
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

  function renderStatus(status) {
    currentStatus = status || { linked: false };
    const linked = Boolean(currentStatus.linked);
    $("jobsStatusDot")?.classList.toggle("connected", linked);
    $("jobsStatusTitle").textContent = linked ? "Đã kết nối" : "Chưa kết nối";
    $("jobsStatusSubtitle").textContent = linked
      ? "Sẵn sàng nhận khách hàng từ Findmap."
      : "Tạo mã tại Jobs ClickOn để ghép tài khoản.";
    $("jobsConnectPanel")?.classList.toggle("hidden", linked);
    $("jobsDisconnectPanel")?.classList.toggle("hidden", !linked);
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
  }

  async function loadStatus(verify = false) {
    try {
      const status = await apiRequest(`/api/integrations/jobs/status${verify ? "?verify=1" : ""}`);
      renderStatus(status);
      if (status.error) showMessage(status.error, "error");
      else if (verify) showMessage("Kết nối Jobs ClickOn đang hoạt động.", "success");
    } catch (error) {
      if (!verify) renderStatus({ linked: false });
      showMessage(error.message, "error");
    }
  }

  async function connect(event) {
    event.preventDefault();
    const input = $("jobsPairingCode");
    const button = $("connectJobsBtn");
    const code = String(input?.value || "").trim().toUpperCase();
    if (!code) return;
    setBusy(button, true, "Đang kết nối...");
    showMessage("");
    try {
      const status = await apiRequest("/api/integrations/jobs/connect", {
        method: "POST",
        body: JSON.stringify({ pairing_code: code })
      });
      if (input) input.value = "";
      renderStatus(status);
      showMessage(status.message || "Đã kết nối Jobs ClickOn.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false);
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
    window.location.replace("/login");
  }

  function init() {
    $("jobsConnectForm")?.addEventListener("submit", connect);
    $("verifyJobsBtn")?.addEventListener("click", verify);
    $("disconnectJobsBtn")?.addEventListener("click", disconnect);
    $("sidebarLogoutBtn")?.addEventListener("click", logout);
    $("jobsPairingCode")?.addEventListener("input", (event) => {
      const raw = event.target.value.toUpperCase().replace(/[^A-F0-9]/g, "").slice(0, 16);
      event.target.value = raw.match(/.{1,4}/g)?.join("-") || "";
    });
    loadStatus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
