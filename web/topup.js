/**
 * topup.js — trang Nạp Credit (/nap-diem)
 */
(function () {
  const AUTH_KEY = "timdiemban_token";

  let currentUser = null;
  let availablePackages = [];
  let pendingOrders = [];
  let vietqrConfigured = false;
  let activeOrder = null;
  let activePaymentInfo = null;
  let purchasing = false;
  let gridBound = false;

  const BANK_LABELS = {
    MB: "Ngân hàng MB (Quân đội)",
    VCB: "Ngân hàng Vietcombank",
    TCB: "Ngân hàng Techcombank",
    BIDV: "Ngân hàng BIDV",
    VPB: "Ngân hàng VPBank",
    ACB: "Ngân hàng ACB",
    STB: "Ngân hàng Sacombank",
    HDB: "Ngân hàng HDBank",
    VIB: "Ngân hàng VIB",
    SHB: "Ngân hàng SHB",
    OCB: "Ngân hàng OCB",
    MSB: "Ngân hàng MSB",
    ICB: "Ngân hàng VietinBank"
  };

  function bankLabel(code) {
    if (!code) return "—";
    const key = String(code).trim().toUpperCase();
    return BANK_LABELS[key] || `Ngân hàng ${key}`;
  }

  function formatMoney(n) {
    return `${Number(n).toLocaleString("vi-VN")} đ`;
  }

  function setCheckoutVisible(show) {
    $("paymentPanel")?.classList.toggle("hidden", !show);
    $("packagesSection")?.classList.toggle("hidden", show);
    $("ordersSection")?.classList.toggle("hidden", show);
  }

  const $ = (id) => document.getElementById(id);

  function getToken() {
    return localStorage.getItem(AUTH_KEY) || "";
  }

  function clearSessionInExtension() {
    window.postMessage({ source: "timdiemban-web", type: "LOGOUT", payload: {} }, window.location.origin);
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

  function showAuthModal() {
    $("authModal")?.classList.remove("hidden");
  }
  function hideAuthModal() {
    $("authModal")?.classList.add("hidden");
  }

  function updateHeaderUI() {
    const loginBtn = $("loginBtn");
    const userBlock = $("headerUserBlock");
    const logoutLabel = $("sidebarLogoutLabel");

    if (currentUser) {
      loginBtn?.classList.add("hidden");
      userBlock?.classList.remove("hidden");
      const name = $("headerUserName");
      const role = $("headerUserRole");
      const avatar = $("headerUserAvatar");
      if (name) name.textContent = (currentUser.email || "").split("@")[0];
      if (role) role.textContent = currentUser.role === "admin" ? "Super Administrator" : "Thành viên";
      if (avatar) avatar.textContent = (currentUser.email || "U")[0].toUpperCase();
      if (logoutLabel) logoutLabel.textContent = "Đăng xuất";

      const pts = $("currentPointsHdr");
      const pkg = $("currentPackageHdr");
      if (pts) pts.textContent = (currentUser.points ?? "-").toLocaleString("vi-VN");
      if (pkg) pkg.textContent = currentUser.packageName || "Chưa có gói";
    } else {
      loginBtn?.classList.remove("hidden");
      userBlock?.classList.add("hidden");
      if (logoutLabel) logoutLabel.textContent = "Đăng nhập";
    }
  }

  function showLoginGate() {
    $("loginGate")?.classList.remove("hidden");
    $("packagesSection")?.classList.add("hidden");
    closePaymentPanel();
  }

  function showMainSections() {
    $("loginGate")?.classList.add("hidden");
    $("packagesSection")?.classList.remove("hidden");
  }

  function formatPts(n) {
    return Number(n).toLocaleString("vi-VN");
  }

  async function loadPackages() {
    const grid = $("packagesGrid");
    if (!grid) return;
    try {
      const { packages } = await apiReq("/api/packages");
      availablePackages = packages || [];
      renderPackages();
    } catch (err) {
      grid.innerHTML = `<p style="color:#991b1b;padding:16px">${err.message}</p>`;
    }
  }

  function formatExpire(days) {
    const n = Number(days);
    if (n >= 365) return "1 năm";
    if (n >= 30) return `${Math.round(n / 30)} tháng`;
    if (n > 0) return `${n} ngày`;
    return "1 năm";
  }

  function bindPackageGrid() {
    const grid = $("packagesGrid");
    if (!grid || gridBound) return;
    gridBound = true;
    grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".topup-pkg-btn");
      if (!btn || btn.disabled || purchasing) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.pkgId;
      if (id) onSelectPackage(id);
    });
  }

  function renderPackages() {
    bindPackageGrid();
    const grid = $("packagesGrid");
    if (!grid || !availablePackages.length) {
      if (grid) grid.innerHTML = "<p style='color:#6b7280;padding:16px'>Hiện chưa có gói credit nào.</p>";
      return;
    }

    const hasPending = pendingOrders.some((o) => o.status === "pending");
    const midIdx = Math.floor((availablePackages.length - 1) / 2);

    grid.innerHTML = availablePackages
      .map((pkg, i) => {
        const isPopular = availablePackages.length > 1 && i === midIdx;
        const priceStr = pkg.price ? `${Number(pkg.price).toLocaleString("vi-VN")}đ` : "Liên hệ";
        const expStr = formatExpire(pkg.expireDays ?? pkg.expire_days ?? 365);
        return `
        <div class="topup-pkg-card${isPopular ? " topup-pkg-popular" : ""}${hasPending ? " disabled" : ""}">
          ${isPopular ? '<span class="topup-pkg-popular-badge">Phổ biến nhất</span>' : ""}
          <div class="topup-pkg-name">${pkg.name}</div>
          <div class="topup-pkg-points">${formatPts(pkg.points)}</div>
          <div class="topup-pkg-points-label">credit tìm kiếm</div>
          <div class="topup-pkg-price">${priceStr}</div>
          <div class="topup-pkg-expire">Thời hạn: ${expStr}</div>
          <button type="button" class="topup-pkg-btn" ${hasPending ? "disabled" : ""} data-pkg-id="${pkg.id}">
            ${hasPending ? "Đang chờ duyệt" : "Chọn gói này"}
          </button>
        </div>`;
      })
      .join("");
  }

  function renderPendingNotice() {
    const el = $("pendingNotice");
    if (!el) return;
    const pending = pendingOrders.filter((o) => o.status === "pending");
    if (!pending.length) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.innerHTML = pending
      .map((o) => {
        const label = o.paymentConfirmed
          ? "Đã xác nhận thanh toán — chờ admin duyệt"
          : vietqrConfigured
            ? "Chờ thanh toán — xem QR bên dưới"
            : "Chờ admin cấu hình VietQR để thanh toán";
        const date = new Date(o.createdAt).toLocaleString("vi-VN");
        return `<div class="topup-pending-row">
          <span><strong>${o.packageName || "Gói credit"}</strong> (+${formatPts(o.points)} credit) — ${label} · ${date}</span>
          <button type="button" class="topup-order-cancel" data-order-id="${o.id}">Hủy đơn</button>
        </div>`;
      })
      .join("");

    el.querySelectorAll(".topup-order-cancel").forEach((btn) => {
      btn.addEventListener("click", () => cancelOrder(btn.dataset.orderId));
    });
  }

  async function cancelOrder(orderId) {
    if (!orderId) return;
    if (!window.confirm("Hủy đơn này và chọn gói khác?")) return;
    try {
      const data = await apiReq(`/api/packages/orders/${orderId}/cancel`, { method: "POST" });
      if (activeOrder?.id === orderId) closePaymentPanel();
      await loadOrders();
      if (data.message) alert(data.message);
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadOrders(options = {}) {
    const { syncPayment = false } = options;
    try {
      const data = await apiReq("/api/packages/orders");
      pendingOrders = data.orders || [];
      vietqrConfigured = !!data.vietqrConfigured;
    } catch {
      pendingOrders = [];
      vietqrConfigured = false;
    }
    renderPendingNotice();
    renderPackages();
    renderOrdersSection();
    if (syncPayment) {
      await syncPendingPaymentPanel();
    }
  }

  function renderOrdersSection() {
    const section = $("ordersSection");
    const list = $("ordersList");
    if (!section || !list) return;

    if (!pendingOrders.length) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");

    list.innerHTML = pendingOrders
      .map((o) => {
        const date = new Date(o.createdAt).toLocaleString("vi-VN");
        const statusMap = {
          pending: o.paymentConfirmed ? ["badge-confirmed", "Đã xác nhận TT"] : ["badge-pending", "Chờ thanh toán"],
          approved: ["badge-approved", "Đã duyệt"],
          rejected: ["badge-rejected", "Từ chối"],
          cancelled: ["badge-cancelled", "Đã hủy"]
        };
        const [badgeClass, badgeLabel] = statusMap[o.status] || ["badge-pending", o.status];
        const showQrBtn = o.status === "pending" && !o.paymentConfirmed && vietqrConfigured;
        const showCancelBtn = o.status === "pending";
        return `
        <div class="topup-order-row">
          <div class="topup-order-info">
            <div class="topup-order-name">${o.packageName || "Gói credit"} — +${formatPts(o.points)} credit</div>
            <div class="topup-order-meta">
              ${o.paymentAmount ? `${Number(o.paymentAmount).toLocaleString("vi-VN")}đ · ` : ""}
              Đặt lúc ${date}
            </div>
          </div>
          <div class="topup-order-status">
            <span class="topup-order-badge ${badgeClass}">${badgeLabel}</span>
            ${showQrBtn ? `<button type="button" class="topup-order-repay" data-order-id="${o.id}">Xem QR</button>` : ""}
            ${showCancelBtn ? `<button type="button" class="topup-order-cancel" data-order-id="${o.id}">Hủy</button>` : ""}
          </div>
        </div>`;
      })
      .join("");

    list.querySelectorAll(".topup-order-repay").forEach((btn) => {
      btn.addEventListener("click", () => openOrderPayment(btn.dataset.orderId));
    });
    list.querySelectorAll(".topup-order-cancel").forEach((btn) => {
      btn.addEventListener("click", () => cancelOrder(btn.dataset.orderId));
    });
  }

  async function openOrderPayment(orderId) {
    if (!orderId) return;
    try {
      const data = await apiReq(`/api/packages/orders/${orderId}/payment`);
      activeOrder = data.order;
      activePaymentInfo = data.paymentInfo || null;
      vietqrConfigured = !!data.vietqrConfigured;
      if (data.qrUrl && data.paymentInfo) {
        showPaymentPanel(data.order, data.qrUrl, data.paymentInfo);
      } else {
        showPaymentPanelNoQr(data.order);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function syncPendingPaymentPanel() {
    const pending = pendingOrders.find((o) => o.status === "pending" && !o.paymentConfirmed);
    if (!pending) return;
    await openOrderPayment(pending.id);
  }

  async function onSelectPackage(pkgId) {
    if (purchasing) return;
    if (!currentUser) {
      showAuthModal();
      return;
    }

    const pkg = availablePackages.find((p) => p.id === pkgId);
    if (!pkg) return;

    if (pendingOrders.some((o) => o.status === "pending")) {
      return;
    }

    purchasing = true;
    const grid = $("packagesGrid");
    grid?.querySelectorAll(".topup-pkg-btn").forEach((b) => {
      b.disabled = true;
      if (b.dataset.pkgId === pkgId) b.textContent = "Đang xử lý…";
    });

    try {
      const data = await apiReq("/api/packages/purchase", {
        method: "POST",
        body: JSON.stringify({ packageId: pkgId })
      });

      if (data.order) {
        activeOrder = data.order;
        activePaymentInfo = data.paymentInfo || null;
        vietqrConfigured = !!data.vietqrConfigured;
        await loadOrders({ syncPayment: false });

        if (data.qrUrl && data.paymentInfo) {
          showPaymentPanel(data.order, data.qrUrl, data.paymentInfo);
        } else {
          showPaymentPanelNoQr(data.order);
        }
      }
    } catch (err) {
      alert(err.message);
      renderPackages();
    } finally {
      purchasing = false;
    }
  }

  function setConfirmBtnVisible(visible) {
    const btn = $("topupConfirmBtn");
    if (!btn) return;
    btn.classList.toggle("hidden", !visible);
    btn.disabled = !visible;
  }

  function fillPaymentUI(order, paymentInfo, qrUrl) {
    const amount = paymentInfo?.amount ?? order.paymentAmount ?? 0;
    const note = paymentInfo?.note || order.id || "—";

    $("topupPkgName").textContent = order.packageName || "Gói credit";
    $("topupPkgDesc").textContent = `Gói ${formatPts(order.points)} credit · Thời hạn 1 năm`;
    $("topupLinePrice").textContent = formatMoney(amount);
    $("topupTotal").textContent = formatMoney(amount);
    $("topupOrderId").textContent = order.id || "—";

    if (paymentInfo?.bankId) {
      $("topupBankName").textContent = bankLabel(paymentInfo.bankId);
      $("topupAccountNo").textContent = paymentInfo.accountNo || "—";
      $("topupAccountName").textContent = paymentInfo.accountName || "—";
    } else {
      $("topupBankName").textContent = "Chưa cấu hình";
      $("topupAccountNo").textContent = "—";
      $("topupAccountName").textContent = "—";
    }

    const noteEl = $("topupNote");
    if (noteEl) noteEl.value = note;

    const qrImg = $("topupQrImg");
    const qrPh = $("payQrPlaceholder");
    if (qrUrl && qrImg) {
      qrImg.src = qrUrl;
      qrImg.classList.remove("hidden");
      qrPh?.classList.add("hidden");
    } else {
      if (qrImg) {
        qrImg.src = "";
        qrImg.classList.add("hidden");
      }
      qrPh?.classList.remove("hidden");
    }
  }

  function showPaymentPanel(order, qrUrl, paymentInfo) {
    fillPaymentUI(order, paymentInfo, qrUrl);

    const msg = $("topupMsg");
    if (msg) {
      msg.textContent = "";
      msg.className = "topup-msg hidden";
    }

    setConfirmBtnVisible(!order.paymentConfirmed && !!paymentInfo);
    setCheckoutVisible(true);
    $("paymentPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showPaymentPanelNoQr(order) {
    fillPaymentUI(order, null, null);

    const msg = $("topupMsg");
    if (msg) {
      msg.textContent =
        "Admin chưa cấu hình VietQR tại trang Quản trị. Vui lòng chuyển khoản thủ công theo thông tin admin cung cấp.";
      msg.className = "topup-msg topup-msg-ok";
    }

    setConfirmBtnVisible(false);
    setCheckoutVisible(true);
    $("paymentPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closePaymentPanel() {
    setCheckoutVisible(false);
    activeOrder = null;
    activePaymentInfo = null;
    const qrImg = $("topupQrImg");
    if (qrImg) {
      qrImg.src = "";
      qrImg.classList.remove("hidden");
    }
    $("payQrPlaceholder")?.classList.add("hidden");
  }

  async function confirmPaymentDone() {
    if (!activeOrder || !activePaymentInfo) {
      alert("Chưa có thông tin thanh toán — admin cần cấu hình VietQR trước.");
      return;
    }
    if (!window.confirm("Xác nhận bạn đã hoàn tất chuyển khoản cho đơn hàng này?")) {
      return;
    }
    const btn = $("topupConfirmBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang gửi…";
    }

    try {
      const data = await apiReq(`/api/packages/orders/${activeOrder.id}/confirm-payment`, { method: "POST" });
      const msg = $("topupMsg");
      if (msg) {
        msg.textContent =
          (data.message || "Đã xác nhận — admin sẽ duyệt sớm!") + " Tự quay về trang tìm kiếm sau 3 giây…";
        msg.className = "topup-msg topup-msg-ok";
      }
      setConfirmBtnVisible(false);
      await loadOrders();
      setTimeout(() => {
        window.location.replace("/");
      }, 3000);
    } catch (err) {
      const msg = $("topupMsg");
      if (msg) {
        msg.textContent = err.message;
        msg.className = "topup-msg topup-msg-err";
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Tôi đã chuyển khoản";
      }
    }
  }

  async function loadCurrentUser() {
    const token = getToken();
    if (!token) {
      currentUser = null;
      updateHeaderUI();
      showLoginGate();
      return;
    }
    try {
      const data = await apiReq("/api/auth/me");
      currentUser = data.user || null;
      if (currentUser && !currentUser.termsAccepted) {
        window.location.replace("/login");
        return;
      }
    } catch {
      localStorage.removeItem(AUTH_KEY);
      window.FindmapSessionCookie?.clearSessionCookie?.();
      currentUser = null;
    }
    updateHeaderUI();
    if (currentUser) {
      showMainSections();
      await loadPackages();
      await loadOrders({ syncPayment: true });
    } else {
      showLoginGate();
    }
  }

  $("authForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("authError");
    if (errEl) errEl.classList.add("hidden");
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    try {
      const data = await apiReq("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      localStorage.setItem(AUTH_KEY, data.token);
      currentUser = data.user;
      hideAuthModal();
      updateHeaderUI();
      showMainSections();
      await loadPackages();
      await loadOrders({ syncPayment: true });
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  $("authModal")?.addEventListener("click", (e) => {
    if (e.target === $("authModal")) hideAuthModal();
  });

  function handleLogout() {
    if (currentUser) {
      apiReq("/api/logout", { method: "POST" }).catch(() => {});
      localStorage.removeItem(AUTH_KEY);
      window.FindmapSessionCookie?.clearSessionCookie?.();
      clearSessionInExtension();
      currentUser = null;
      updateHeaderUI();
      showLoginGate();
      window.location.replace("/");
    } else {
      window.location.replace("/login");
    }
  }

  $("sidebarLogoutBtn")?.addEventListener("click", handleLogout);
  $("loginBtn")?.addEventListener("click", handleLogout);
  $("gateLoginBtn")?.addEventListener("click", showAuthModal);
  $("closePaymentPanel")?.addEventListener("click", closePaymentPanel);
  $("cancelPaymentOrderBtn")?.addEventListener("click", () => {
    if (activeOrder?.id) cancelOrder(activeOrder.id);
  });
  $("topupConfirmBtn")?.addEventListener("click", confirmPaymentDone);
  $("copyNoteBtn")?.addEventListener("click", () => {
    const noteEl = $("topupNote");
    if (!noteEl?.value) return;
    navigator.clipboard?.writeText(noteEl.value).then(() => {
      const btn = $("copyNoteBtn");
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Đã copy!";
        setTimeout(() => { btn.textContent = prev; }, 1500);
      }
    }).catch(() => {
      noteEl.select();
      document.execCommand("copy");
    });
  });

  loadCurrentUser();
})();
