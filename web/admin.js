const ADMIN_TOKEN_KEY = "timdiemban_admin_token";

const els = {
  adminGate: document.getElementById("adminGate"),
  adminPanel: document.getElementById("adminPanel"),
  adminNav: document.getElementById("adminNav"),
  adminPageTitle: document.getElementById("adminPageTitle"),
  adminGateForm: document.getElementById("adminGateForm"),
  adminEmail: document.getElementById("adminEmail"),
  adminPassword: document.getElementById("adminPassword"),
  adminGateError: document.getElementById("adminGateError"),
  adminUserBar: document.getElementById("adminUserBar"),
  adminUserEmail: document.getElementById("adminUserEmail"),
  adminLogoutBtn: document.getElementById("adminLogoutBtn"),
  createUserForm: document.getElementById("createUserForm"),
  createUserMsg: document.getElementById("createUserMsg"),
  adminResetForm: document.getElementById("adminResetForm"),
  adminResetMsg: document.getElementById("adminResetMsg"),
  addPointsForm: document.getElementById("addPointsForm"),
  addPointsMsg: document.getElementById("addPointsMsg"),
  assignPackageForm: document.getElementById("assignPackageForm"),
  assignPackageMsg: document.getElementById("assignPackageMsg"),
  usersBody: document.getElementById("usersBody"),
  newPackageId: document.getElementById("newPackageId"),
  assignPackageId: document.getElementById("assignPackageId"),
  ordersBody: document.getElementById("ordersBody"),
  adminNavPendingBadge: document.getElementById("adminNavPendingBadge")
};

let packages = [];
let currentOrderFilter = "pending";

const ADMIN_PANEL_TITLES = {
  users: "Quản lý tài khoản",
  orders: "Gói & lịch sử đơn hàng",
  vietqr: "Cấu hình VietQR"
};

function switchAdminPanel(panelId) {
  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.panel === panelId);
  });
  document.querySelectorAll(".admin-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `adminPanel${panelId.charAt(0).toUpperCase()}${panelId.slice(1)}`);
  });
  if (els.adminPageTitle) {
    els.adminPageTitle.textContent = ADMIN_PANEL_TITLES[panelId] || "Quản trị hệ thống";
  }
  if (panelId === "orders") loadPackageOrders().catch(() => {});
}

function switchToolTab(toolId) {
  document.querySelectorAll(".admin-tool-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === toolId);
  });
  document.querySelectorAll(".admin-tool-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.toolPanel === toolId);
  });
}

function orderStatusBadge(status) {
  const map = {
    pending: ["badge-pending", "Chờ duyệt"],
    approved: ["badge-approved", "Đã duyệt"],
    rejected: ["badge-rejected", "Từ chối"],
    cancelled: ["badge-cancelled", "Đã hủy"]
  };
  const [cls, label] = map[status] || ["badge-off", status || "—"];
  return `<span class="badge ${cls}">${label}</span>`;
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("vi-VN");
}

function formatPackageExpiry(iso) {
  if (!iso) return { html: "—", title: "" };
  const exp = new Date(iso);
  if (Number.isNaN(exp.getTime())) return { html: "—", title: "" };
  const dateStr = exp.toLocaleDateString("vi-VN");
  const daysLeft = Math.ceil((exp.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (daysLeft < 0) {
    return {
      html: `<span class="badge badge-off">Đã hết hạn</span><br><small>${escapeHtml(dateStr)}</small>`,
      title: `Hết hạn ${dateStr}`
    };
  }
  if (daysLeft === 0) {
    return {
      html: `<span class="badge badge-pending">Hết hôm nay</span><br><small>${escapeHtml(dateStr)}</small>`,
      title: `Hết hạn ${dateStr}`
    };
  }
  if (daysLeft <= 7) {
    return {
      html: `<span class="badge badge-pending">Còn ${daysLeft} ngày</span><br><small>${escapeHtml(dateStr)}</small>`,
      title: `Hết hạn ${dateStr}`
    };
  }
  return {
    html: `<strong>${daysLeft}</strong> ngày<br><small>${escapeHtml(dateStr)}</small>`,
    title: `Còn ${daysLeft} ngày — hết hạn ${dateStr}`
  };
}

function getAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function setAdminToken(token) {
  if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}

async function parseApiResponse(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(
      res.status === 404
        ? `API không tồn tại — hãy khởi động lại server (npm start) và mở trang qua ${(window.TIMDIEMBAN_CONFIG?.APP_ORIGIN || window.location.origin).replace(/\/$/, "")}`
        : "Máy chủ trả về HTML thay vì JSON — kiểm tra server đang chạy phiên bản mới"
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

async function adminFetch(path, options = {}) {
  const token = getAdminToken();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  return parseApiResponse(res);
}

function showMsg(el, text, ok = true) {
  el.textContent = text;
  el.className = `admin-msg ${ok ? "admin-msg-ok" : "admin-msg-err"}`;
  el.classList.remove("hidden");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

function fillPackageSelects(list) {
  packages = list || [];
  const opts = packages
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (+${p.points})</option>`)
    .join("");
  const empty = '<option value="">— Không chọn gói —</option>';
  if (els.newPackageId) els.newPackageId.innerHTML = empty + opts;
  if (els.assignPackageId) els.assignPackageId.innerHTML = opts;
}

async function loadPackageOrders() {
  const [filteredData, allData] = await Promise.all([
    adminFetch(`/api/admin/package/orders?status=${currentOrderFilter}`),
    adminFetch("/api/admin/package/orders?status=all")
  ]);
  const orders = filteredData.orders || [];
  const allOrders = allData.orders || [];

  const statPending = document.getElementById("statPendingOrders");
  const statConfirmed = document.getElementById("statConfirmedOrders");
  const pendingCount = allOrders.filter((o) => o.status === "pending").length;
  const confirmedCount = allOrders.filter((o) => o.status === "pending" && o.paymentConfirmed).length;
  if (statPending) statPending.textContent = pendingCount;
  if (statConfirmed) statConfirmed.textContent = confirmedCount;
  if (els.adminNavPendingBadge) {
    if (pendingCount > 0) {
      els.adminNavPendingBadge.textContent = String(pendingCount);
      els.adminNavPendingBadge.classList.remove("hidden");
    } else {
      els.adminNavPendingBadge.classList.add("hidden");
    }
  }

  if (!els.ordersBody) return;

  const emptyLabels = {
    pending: "Không có yêu cầu chờ duyệt",
    approved: "Chưa có đơn đã duyệt",
    rejected: "Chưa có đơn bị từ chối",
    cancelled: "Chưa có đơn đã hủy",
    all: "Chưa có yêu cầu mua gói nào"
  };

  if (!orders.length) {
    els.ordersBody.innerHTML = `
      <tr class="admin-table-empty">
        <td colspan="9">${emptyLabels[currentOrderFilter] || "Không có dữ liệu"}</td>
      </tr>`;
    return;
  }

  els.ordersBody.innerHTML = orders
    .map((o) => {
      const ttBadge = o.paymentConfirmed
        ? `<span class="badge badge-ok">✅ Đã xác nhận</span>`
        : `<span class="badge badge-off">Chưa TT</span>`;
      const amountStr = o.paymentAmount ? Number(o.paymentAmount).toLocaleString("vi-VN") + "đ" : "—";
      const canApprove = o.status === "pending";
      const canDelete = o.status !== "approved";
      const noteHint = o.adminNote ? `<br><small title="${escapeHtml(o.adminNote)}">Ghi chú: ${escapeHtml(o.adminNote.slice(0, 40))}${o.adminNote.length > 40 ? "…" : ""}</small>` : "";
      return `
    <tr data-order-id="${escapeHtml(o.id)}">
      <td>${escapeHtml(o.userEmail)}</td>
      <td>${escapeHtml(o.packageName || o.packageId)}</td>
      <td class="col-points"><strong>+${Number(o.points).toLocaleString("vi-VN")}</strong></td>
      <td style="white-space:nowrap">${amountStr}</td>
      <td>${orderStatusBadge(o.status)}${noteHint}</td>
      <td>${o.status === "pending" ? ttBadge : "—"}</td>
      <td><small>${escapeHtml(formatDateTime(o.createdAt))}</small></td>
      <td><small>${escapeHtml(formatDateTime(o.reviewedAt))}</small></td>
      <td class="col-actions">
        <div class="admin-row-actions">
        ${canApprove ? `<button type="button" class="admin-btn admin-btn-primary btn-sm" data-action="approve-order">Duyệt</button>` : ""}
        ${canApprove ? `<button type="button" class="admin-btn admin-btn-secondary btn-sm" data-action="reject-order">Từ chối</button>` : ""}
        ${canDelete ? `<button type="button" class="admin-btn btn-sm btn-danger" data-action="delete-order">Xóa</button>` : ""}
        </div>
      </td>
    </tr>`;
    })
    .join("");
}

async function loadUsers() {
  const data = await adminFetch("/api/admin/users");
  fillPackageSelects(data.packages);
  await loadPackageOrders();

  const users = data.users || [];
  const statUsers = document.getElementById("statUsers");
  const statPoints = document.getElementById("statPoints");
  if (statUsers) statUsers.textContent = users.length;
  if (statPoints) {
    statPoints.textContent = users.reduce((s, u) => s + (u.points || 0), 0);
  }

  if (!users.length) {
    els.usersBody.innerHTML = `
      <tr class="admin-table-empty">
        <td colspan="7">Chưa có tài khoản — tạo tài khoản ở form phía trên</td>
      </tr>`;
    return;
  }

  els.usersBody.innerHTML = users
    .map((u) => {
      const pkg = u.packageName ? escapeHtml(u.packageName) : "—";
      const expiry = formatPackageExpiry(u.packageExpiresAt);
      const status = u.isActive
        ? '<span class="badge badge-ok">Hoạt động</span>'
        : '<span class="badge badge-off">Khóa</span>';
      const toggleLabel = u.isActive ? "Khóa" : "Mở khóa";
      return `
    <tr data-email="${escapeHtml(u.email)}">
      <td>${escapeHtml(u.email)}</td>
      <td class="col-points"><strong>${Number(u.points).toLocaleString("vi-VN")}</strong></td>
      <td>${pkg}</td>
      <td title="${escapeHtml(expiry.title)}">${expiry.html}</td>
      <td><small>${formatDateTime(u.createdAt)}</small></td>
      <td>${status}</td>
      <td class="col-actions">
        <div class="admin-row-actions">
        <button type="button" class="admin-btn admin-btn-secondary btn-sm" data-action="reset-pw">Đặt MK</button>
        <button type="button" class="admin-btn admin-btn-secondary btn-sm" data-action="add-pts">+Điểm</button>
        <button type="button" class="admin-btn admin-btn-secondary btn-sm" data-action="toggle">${toggleLabel}</button>
        </div>
      </td>
    </tr>`;
    })
    .join("");
}

async function unlockAdmin(adminUser) {
  els.adminGate.classList.add("hidden");
  els.adminPanel.classList.remove("hidden");
  if (els.adminNav) els.adminNav.classList.remove("hidden");
  if (els.adminUserBar) els.adminUserBar.classList.remove("hidden");
  if (els.adminUserEmail) els.adminUserEmail.textContent = adminUser?.email || "";
  switchAdminPanel("users");
  await Promise.all([loadUsers(), loadVietqrConfig()]);
}

els.adminGateForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.adminGateError.classList.add("hidden");
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: els.adminEmail.value.trim(),
        password: els.adminPassword.value
      })
    });
    const data = await parseApiResponse(res);
    setAdminToken(data.token);
    await unlockAdmin(data.user);
  } catch (err) {
    setAdminToken("");
    els.adminGateError.textContent = err.message;
    els.adminGateError.classList.remove("hidden");
  }
});

els.adminLogoutBtn?.addEventListener("click", async () => {
  try {
    await adminFetch("/api/auth/logout", { method: "POST" });
  } catch {}
  setAdminToken("");
  location.reload();
});

els.createUserForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const body = {
      email: document.getElementById("newEmail").value.trim(),
      password: document.getElementById("newPassword").value,
      packageId: els.newPackageId?.value || null
    };
    if (!body.packageId) {
      body.points = Number(document.getElementById("newPoints").value) || 0;
    }
    const data = await adminFetch("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(body)
    });
    showMsg(els.createUserMsg, data.message, true);
    els.createUserForm.reset();
    if (document.getElementById("newPoints")) document.getElementById("newPoints").value = "0";
    await loadUsers();
  } catch (err) {
    showMsg(els.createUserMsg, err.message, false);
  }
});

els.newPackageId?.addEventListener("change", () => {
  const wrap = document.getElementById("newPointsWrap");
  if (!wrap) return;
  wrap.style.display = els.newPackageId.value ? "none" : "block";
});

els.adminResetForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await adminFetch("/api/admin/reset-password", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("resetEmail").value.trim(),
        password: document.getElementById("resetPassword").value
      })
    });
    showMsg(els.adminResetMsg, data.message, true);
    els.adminResetForm.reset();
  } catch (err) {
    showMsg(els.adminResetMsg, err.message, false);
  }
});

els.addPointsForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await adminFetch("/api/admin/points/add", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("pointsEmail").value.trim(),
        amount: Number(document.getElementById("pointsAmount").value)
      })
    });
    showMsg(els.addPointsMsg, data.message, true);
    els.addPointsForm.reset();
    await loadUsers();
  } catch (err) {
    showMsg(els.addPointsMsg, err.message, false);
  }
});

els.assignPackageForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await adminFetch("/api/admin/package/assign", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("packageEmail").value.trim(),
        packageId: els.assignPackageId.value
      })
    });
    showMsg(els.assignPackageMsg, data.message, true);
    els.assignPackageForm.reset();
    await loadUsers();
  } catch (err) {
    showMsg(els.assignPackageMsg, err.message, false);
  }
});

els.usersBody?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const row = btn.closest("tr[data-email]");
  const email = row?.dataset?.email;
  if (!email) return;

  if (btn.dataset.action === "reset-pw") {
    switchToolTab("reset");
    const resetEmail = document.getElementById("resetEmail");
    if (resetEmail) resetEmail.value = email;
    resetEmail?.focus();
    return;
  }

  if (btn.dataset.action === "add-pts") {
    switchToolTab("points");
    const pointsEmail = document.getElementById("pointsEmail");
    if (pointsEmail) pointsEmail.value = email;
    pointsEmail?.focus();
    return;
  }

  if (btn.dataset.action === "toggle") {
    const active = btn.textContent.trim() === "Mở khóa";
    if (!confirm(`${active ? "Mở khóa" : "Khóa"} tài khoản ${email}?`)) return;
    try {
      const data = await adminFetch("/api/admin/users/toggle-active", {
        method: "POST",
        body: JSON.stringify({ email, active })
      });
      await loadUsers();
      alert(data.message);
    } catch (err) {
      alert(err.message);
    }
  }
});

els.ordersBody?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const row = btn.closest("tr[data-order-id]");
  const orderId = row?.dataset?.orderId;
  if (!orderId) return;

  if (btn.dataset.action === "approve-order") {
    if (!confirm("Duyệt yêu cầu này và cộng điểm cho user?")) return;
    try {
      const data = await adminFetch(`/api/admin/package/orders/${orderId}/approve`, {
        method: "POST"
      });
      alert(data.message);
      await loadUsers();
    } catch (err) {
      alert(err.message);
    }
  }

  if (btn.dataset.action === "reject-order") {
    const note = prompt("Lý do từ chối (tùy chọn):");
    if (note === null) return;
    try {
      const data = await adminFetch(`/api/admin/package/orders/${orderId}/reject`, {
        method: "POST",
        body: JSON.stringify({ note: note || "" })
      });
      alert(data.message);
      await loadPackageOrders();
    } catch (err) {
      alert(err.message);
    }
  }

  if (btn.dataset.action === "delete-order") {
    if (!confirm("Xóa yêu cầu này? Hành động không thể hoàn tác.")) return;
    try {
      const data = await adminFetch(`/api/admin/package/orders/${orderId}/delete`, {
        method: "POST"
      });
      alert(data.message || "Đã xóa");
      await loadPackageOrders();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById("refreshOrdersBtn")?.addEventListener("click", () => {
  loadPackageOrders().catch((err) => alert(err.message));
});

document.querySelectorAll(".admin-order-filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentOrderFilter = btn.dataset.orderStatus || "pending";
    document.querySelectorAll(".admin-order-filter").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    loadPackageOrders().catch((err) => alert(err.message));
  });
});

document.querySelectorAll(".admin-nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.dataset.panel;
    if (panel) switchAdminPanel(panel);
  });
});

document.querySelectorAll(".admin-tool-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchToolTab(btn.dataset.tool || "create");
  });
});

// VietQR config
function applyVietqrForm(data) {
  if (!data) return;
  const f = document.getElementById("vietqrForm");
  if (!f) return;
  if (data.bankId != null) f.querySelector("#vqBankId").value = data.bankId || "";
  if (data.acqId != null) f.querySelector("#vqAcqId").value = data.acqId || "";
  if (data.accountNo != null) f.querySelector("#vqAccountNo").value = data.accountNo || "";
  if (data.accountName != null) f.querySelector("#vqAccountName").value = data.accountName || "";
  if (data.clientId != null) f.querySelector("#vqClientId").value = data.clientId || "";
  const keyEl = f.querySelector("#vqApiKey");
  if (keyEl && data.hasApiKey != null) {
    keyEl.placeholder = data.hasApiKey
      ? "•••••••• (đã lưu — để trống giữ nguyên)"
      : "API Key từ my.vietqr.io";
    keyEl.value = "";
  }
  const statusEl = document.getElementById("vietqrSavedStatus");
  if (statusEl) {
    const parts = [];
    if (data.acqId) parts.push(`BIN ${data.acqId}`);
    if (data.clientId) parts.push("Client ID đã lưu");
    if (data.hasApiKey) parts.push("API Key đã lưu");
    statusEl.textContent = parts.length ? parts.join(" · ") : "";
    statusEl.classList.toggle("hidden", !parts.length);
  }
}

async function loadVietqrConfig() {
  try {
    const data = await adminFetch("/api/admin/vietqr-config");
    applyVietqrForm(data);
  } catch {
    // ignore
  }
}

document.getElementById("vietqrForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("vietqrMsg");
  const bankId = document.getElementById("vqBankId").value.trim();
  const acqId = document.getElementById("vqAcqId").value.trim();
  const accountNo = document.getElementById("vqAccountNo").value.trim();
  const accountName = document.getElementById("vqAccountName").value.trim();
  const clientId = document.getElementById("vqClientId").value.trim();
  const apiKey = document.getElementById("vqApiKey").value;
  try {
    const data = await adminFetch("/api/admin/vietqr-config", {
      method: "POST",
      body: JSON.stringify({ bankId, acqId, accountNo, accountName, clientId, apiKey })
    });
    if (msg) {
      msg.textContent = data.message || "Đã lưu";
      msg.className = data.vietqrV2Ready ? "admin-msg admin-msg-ok" : "admin-msg admin-msg-warn";
      msg.classList.remove("hidden");
    }
    applyVietqrForm(data);
    if (data.vietqrV2Ready) {
      document.getElementById("vietqrTestBtn")?.click();
    }
    setTimeout(() => msg?.classList.add("hidden"), 6000);
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.className = "admin-msg admin-msg-err"; msg.classList.remove("hidden"); }
  }
});

document.getElementById("vietqrTestBtn")?.addEventListener("click", async () => {
  const msg = document.getElementById("vietqrMsg");
  const preview = document.getElementById("vietqrTestPreview");
  const img = document.getElementById("vietqrTestImg");
  const methodEl = document.getElementById("vietqrTestMethod");
  try {
    const data = await adminFetch("/api/admin/vietqr-test", {
      method: "POST",
      body: JSON.stringify({ amount: 99000 })
    });
    if (img && data.qrUrl) {
      img.src = data.qrUrl;
      preview?.classList.remove("hidden");
      if (methodEl) methodEl.textContent = data.message || data.qrMethod || "";
    }
    if (msg) {
      msg.textContent = data.message || "Tạo QR test OK";
      msg.className = "admin-msg admin-msg-ok";
      msg.classList.remove("hidden");
    }
  } catch (err) {
    preview?.classList.add("hidden");
    if (msg) { msg.textContent = err.message; msg.className = "admin-msg admin-msg-err"; msg.classList.remove("hidden"); }
  }
});

document.getElementById("refreshUsersBtn")?.addEventListener("click", () => {
  loadUsers().catch((err) => alert(err.message));
});

if (getAdminToken()) {
  adminFetch("/api/admin/me")
    .then((data) => unlockAdmin(data.user))
    .catch(() => setAdminToken(""));
}
