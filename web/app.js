let currentData = [];
let filteredData = [];
let currentSearch = null;
let currentUser = null;
let rowKeyMap = new Map();
let liveProgressText = "";
let sentKeys = new Set(); // key của các dòng đã gửi thành công về site — chỉ để hiển thị, không xóa dữ liệu
let jobsSyncResults = new Map();
let jobsIntegrationStatus = { linked: false };
let jobsSyncBusy = false;
const TABLE_PAGE_SIZE = 50;
let currentPage = 1;

const AUTH_TOKEN_KEY = "timdiemban_token";
const STORAGE_RESULTS_KEY = "timdiemban_results_v1";
const EXT_QUEUE_KEY = "timdiemban_ext_queue";

// ——— Lưu / khôi phục kết quả vào localStorage ———
let _storageSaveTimer = null;
function saveResultsToStorage(immediate = false) {
  const write = () => {
    _storageSaveTimer = null;
    try {
      if (!currentData.length) {
        localStorage.removeItem(STORAGE_RESULTS_KEY);
        return;
      }
      localStorage.setItem(
        STORAGE_RESULTS_KEY,
        JSON.stringify({
          data: currentData,
          search: currentSearch,
          sentKeys: Array.from(sentKeys),
          jobsSyncResults: Array.from(jobsSyncResults.entries()),
          savedAt: Date.now()
        })
      );
    } catch (e) {
      console.warn("TimDiemBan: lưu storage thất bại", e);
    }
  };
  if (immediate || document.visibilityState === "hidden") {
    if (_storageSaveTimer) clearTimeout(_storageSaveTimer);
    write();
    return;
  }
  if (_storageSaveTimer) clearTimeout(_storageSaveTimer);
  _storageSaveTimer = setTimeout(write, 200);
}

function loadResultsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_RESULTS_KEY);
    if (!raw) return false;
    const { data, search, sentKeys: sk, jobsSyncResults: jsr } = JSON.parse(raw);
    if (!Array.isArray(data) || !data.length) return false;
    currentData = data;
    currentSearch = search || null;
    currentData.forEach((r) => ensureStableKey(r));
    if (Array.isArray(sk)) sk.forEach((k) => sentKeys.add(k));
    jobsSyncResults = new Map(Array.isArray(jsr) ? jsr : []);
    dedupeCurrentDataKeepFirst();
    return true;
  } catch {
    return false;
  }
}

// ——— Trạng thái quét lại ———
let rescanRunning = false;
let rescanSessionId = 0;
let rescanProgress = { done: 0, total: 0 };
let rescanAckTimer = null;

function clearRescanAckTimer() {
  if (rescanAckTimer) {
    clearTimeout(rescanAckTimer);
    rescanAckTimer = null;
  }
}

function resetRescanUiState() {
  rescanRunning = false;
  rescanProgress = { done: 0, total: 0 };
  clearRescanAckTimer();
  if (els.rescanBtn) delete els.rescanBtn.dataset.rescanBusy;
  updateRescanBtn();
}

function armRescanAckTimeout(sessionId) {
  clearRescanAckTimer();
  rescanAckTimer = setTimeout(() => {
    if (rescanRunning && rescanSessionId === sessionId) {
      resetRescanUiState();
      setConnStatus("Extension không phản hồi — reload extension rồi thử lại", "error");
    }
  }, 12000);
}

function queryRescanStatus() {
  window.postMessage(
    { source: "timdiemban-web", type: "GET_RESCAN_STATUS", payload: {} },
    window.location.origin
  );
}
// Giữ kết quả cũ khi bấm Tìm — chỉ xóa khi có dữ liệu mới từ lượt quét này
let awaitingNewSearchResults = false;

const els = {
  errorBanner: document.getElementById("errorBanner"),
  errorBannerTitle: document.getElementById("errorBannerTitle"),
  errorBannerText: document.getElementById("errorBannerText"),
  searchInfo: document.getElementById("searchInfo"),
  emptyState: document.getElementById("emptyState"),
  loadingState: document.getElementById("loadingState"),
  tableSection: document.getElementById("tableSection"),
  liveProgress: document.getElementById("liveProgress"),
  liveProgressTextEl: document.getElementById("liveProgressText"),
  liveProgressBar: document.getElementById("liveProgressBar"),
  resultsBody: document.getElementById("resultsBody"),
  exportBtn: document.getElementById("exportBtn"),
  exportBtnFooter: document.getElementById("exportBtnFooter"),
  clearBtn: document.getElementById("clearBtn"),
  resetBtn: document.getElementById("resetBtn"),
  rescanBtn: document.getElementById("rescanBtn"),
  sendSiteBtn: document.getElementById("sendSiteBtn"),
  syncJobsBtn: document.getElementById("syncJobsBtn"),
  syncJobsHint: document.getElementById("syncJobsHint"),
  jobsSyncSummary: document.getElementById("jobsSyncSummary"),
  jobsSyncRequestId: document.getElementById("jobsSyncRequestId"),
  jobsSyncTotal: document.getElementById("jobsSyncTotal"),
  jobsSyncCreated: document.getElementById("jobsSyncCreated"),
  jobsSyncDuplicate: document.getElementById("jobsSyncDuplicate"),
  jobsSyncInvalid: document.getElementById("jobsSyncInvalid"),
  jobsSyncFailed: document.getElementById("jobsSyncFailed"),
  jobsSyncMessage: document.getElementById("jobsSyncMessage"),
  searchFilter: document.getElementById("searchFilter"),
  filterCount: document.getElementById("filterCount"),
  resultsBadge: document.getElementById("resultsBadge"),
  searchResultText: document.getElementById("searchResultText"),
  searchResultBox: document.getElementById("searchResultBox"),
  tablePagination: document.getElementById("tablePagination"),
  tablePaginationControls: document.getElementById("tablePaginationControls"),
  pagePrevBtn: document.getElementById("pagePrevBtn"),
  pageNextBtn: document.getElementById("pageNextBtn"),
  pageInfo: document.getElementById("pageInfo"),
  headerUserBlock: document.getElementById("headerUserBlock"),
  headerUserName: document.getElementById("headerUserName"),
  headerUserRole: document.getElementById("headerUserRole"),
  headerUserAvatar: document.getElementById("headerUserAvatar"),
  headerUserMenu: document.getElementById("headerUserMenu"),
  openProfileBtn: document.getElementById("openProfileBtn"),
  headerLogoutBtn: document.getElementById("headerLogoutBtn"),
  profileModal: document.getElementById("profileModal"),
  profileForm: document.getElementById("profileForm"),
  profileEmail: document.getElementById("profileEmail"),
  profileFullName: document.getElementById("profileFullName"),
  profilePhone: document.getElementById("profilePhone"),
  profileCurrentPassword: document.getElementById("profileCurrentPassword"),
  profileNewPassword: document.getElementById("profileNewPassword"),
  profileConfirmPassword: document.getElementById("profileConfirmPassword"),
  profileMsg: document.getElementById("profileMsg"),
  sidebarLogoutBtn: document.getElementById("sidebarLogoutBtn"),
  sidebarLogoutLabel: document.getElementById("sidebarLogoutLabel"),
  pkgPointsHdr: document.getElementById("pkgPointsHdr"),
  statUsedHdr: document.getElementById("statUsedHdr"),
  infoPointsHdr: document.getElementById("infoPointsHdr"),
  sidebarNewSearchBtn: document.getElementById("sidebarNewSearchBtn"),
  connStatus: document.getElementById("connStatus"),
  infoKeyword: document.getElementById("infoKeyword"),
  infoRadius: document.getElementById("infoRadius"),
  infoCoords: document.getElementById("infoCoords"),
  infoStatus: document.getElementById("infoStatus"),
  infoTotal: document.getElementById("infoTotal"),
  infoPoints: document.getElementById("infoPoints"),
  pkgPoints: document.getElementById("pkgPoints"),
  pkgName: document.getElementById("pkgName"),
  statUsed: document.getElementById("statUsed"),
  packageBuyRow: document.getElementById("packageBuyRow"),
  packagePendingRow: document.getElementById("packagePendingRow"),
  infoGridCells: document.getElementById("infoGridCells"),
  checkAllRows: document.getElementById("checkAllRows"),
  infoRegions: document.getElementById("infoRegions"),
  infoTime: document.getElementById("infoTime"),
  gridPlan: document.getElementById("gridPlan"),
  pointsBadge: document.getElementById("pointsBadge"),
  loginBtn: document.getElementById("loginBtn"),
  authModal: document.getElementById("authModal"),
  authModalTitle: document.getElementById("authModalTitle"),
  authForm: document.getElementById("authForm"),
  authEmail: document.getElementById("authEmail"),
  authPassword: document.getElementById("authPassword"),
  authError: document.getElementById("authError")
};

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    window.FindmapSessionCookie?.setSessionCookie?.();
  } else {
    jobsIntegrationStatus = { linked: false };
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.FindmapSessionCookie?.clearSessionCookie?.();
  }
}

async function parseApiResponse(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(
      "Máy chủ không phản hồi JSON — hãy mở trang qua URL cấu hình (app-config.js) và chạy npm start trong thư mục server"
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Lỗi ${res.status}`);
    error.status = res.status;
    error.code = data.code || "";
    throw error;
  }
  return data;
}

async function apiRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  return parseApiResponse(res);
}

let availablePackages = [];
let pendingPackageOrders = [];

function formatPoints(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("vi-VN") : "-";
}

function updateAuthUI() {
  if (currentUser) {
    if (els.pointsBadge) {
      els.pointsBadge.textContent = `${formatPoints(currentUser.points)} credit`;
      els.pointsBadge.classList.remove("hidden");
    }
    els.loginBtn.textContent = "Đăng xuất";
    els.loginBtn.classList.add("hidden");
    if (els.headerUserBlock) els.headerUserBlock.classList.remove("hidden");
    if (els.headerUserName) {
      const fallback = (currentUser.email || "User").split("@")[0];
      els.headerUserName.textContent = currentUser.fullName || fallback;
    }
    if (els.headerUserRole) {
      els.headerUserRole.textContent =
        currentUser.role === "admin" ? "Super Administrator" : "Thành viên";
    }
    const adminNav = document.getElementById("navAdminLink");
    if (adminNav) {
      adminNav.classList.toggle("hidden", currentUser.role !== "admin");
    }
    if (els.headerUserAvatar) {
      const seed = currentUser.fullName || currentUser.email || "U";
      const initial = seed[0].toUpperCase();
      els.headerUserAvatar.textContent = initial;
    }
    if (els.sidebarLogoutLabel) els.sidebarLogoutLabel.textContent = "Đăng xuất";
    if (els.infoPoints) els.infoPoints.textContent = formatPoints(currentUser.points);
    if (els.pkgPoints) els.pkgPoints.textContent = formatPoints(currentUser.points);
    if (els.pkgPointsHdr) els.pkgPointsHdr.textContent = formatPoints(currentUser.points);
    if (els.pkgName) {
      els.pkgName.textContent = currentUser.packageName ? `(${currentUser.packageName})` : "";
    }
  } else {
    if (els.pointsBadge) els.pointsBadge.classList.add("hidden");
    els.loginBtn.textContent = "Đăng nhập";
    els.loginBtn.classList.remove("hidden");
    if (els.headerUserBlock) els.headerUserBlock.classList.add("hidden");
    if (els.sidebarLogoutLabel) els.sidebarLogoutLabel.textContent = "Đăng nhập";
    if (els.infoPoints) els.infoPoints.textContent = "-";
    if (els.pkgPoints) els.pkgPoints.textContent = "-";
    if (els.pkgPointsHdr) els.pkgPointsHdr.textContent = "-";
    if (els.infoPointsHdr) els.infoPointsHdr.textContent = "-";
    if (els.pkgName) els.pkgName.textContent = "";
    const adminNav = document.getElementById("navAdminLink");
    if (adminNav) adminNav.classList.add("hidden");
  }
  updateStatUsed();
  updateSyncJobsButton();
  renderPackageButtons();
  renderPendingPackageNotice();
}

function renderPendingPackageNotice() {
  if (!els.packagePendingRow) return;
  const pending = pendingPackageOrders.filter((o) => o.status === "pending");
  if (!currentUser || !pending.length) {
    els.packagePendingRow.classList.add("hidden");
    els.packagePendingRow.innerHTML = "";
    return;
  }
  const lines = pending.map((o) => {
    const label = o.paymentConfirmed ? "Đã xác nhận TT — chờ admin duyệt" : "Chờ thanh toán";
    return `${o.packageName || "Gói credit"} (+${formatPoints(o.points)} credit) — ${label}`;
  });
  els.packagePendingRow.classList.remove("hidden");
  els.packagePendingRow.innerHTML = lines.join("<br>");
}

async function loadPendingPackageOrders() {
  if (!currentUser) {
    pendingPackageOrders = [];
    renderPendingPackageNotice();
    return;
  }
  try {
    const { orders } = await apiRequest("/api/packages/orders");
    pendingPackageOrders = orders || [];
  } catch {
    pendingPackageOrders = [];
  }
  renderPendingPackageNotice();
  renderPackageButtons();
}

async function loadAvailablePackages() {
  try {
    const { packages } = await apiRequest("/api/packages");
    availablePackages = packages || [];
  } catch {
    availablePackages = [];
  }
  renderPackageButtons();
}

function renderPackageButtons() {
  if (!els.packageBuyRow) return;
  // Trang chính chỉ hiển thị link đến trang Nạp điểm khi user cần mua thêm
  if (!currentUser || currentUser.role === "admin") {
    els.packageBuyRow.classList.add("hidden");
    return;
  }
  const hasLowPoints = currentUser.points !== undefined && currentUser.points < 10;
  const hasPending = pendingPackageOrders.some((o) => o.status === "pending");
  if (hasLowPoints || hasPending) {
    els.packageBuyRow.classList.remove("hidden");
  } else {
    els.packageBuyRow.classList.add("hidden");
  }
}

async function purchasePackage(packageId, btn) {
  if (!currentUser) {
    showAuthModal();
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const data = await apiRequest("/api/packages/purchase", {
      method: "POST",
      body: JSON.stringify({ packageId })
    });
    if (data.order) pendingPackageOrders = [data.order, ...pendingPackageOrders.filter((o) => o.id !== data.order.id)];
    await loadPendingPackageOrders();
    setConnStatus(data.message || "Đã gửi yêu cầu mua gói", "connected");

    // Nếu có QR thanh toán → hiển thị modal
    if (data.qrUrl && data.order) {
      showPaymentModal(data.order, data.qrUrl, data.paymentInfo);
    } else {
      alert(data.message || "Đã gửi yêu cầu — admin sẽ duyệt sớm");
    }
  } catch (err) {
    setConnStatus(err.message, "error");
    alert(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

let _paymentOrder = null;

function showPaymentModal(order, qrUrl, paymentInfo) {
  _paymentOrder = order;
  const modal = document.getElementById("paymentModal");
  if (!modal) return;
  const qrImg = document.getElementById("paymentQrImg");
  const amountEl = document.getElementById("paymentAmount");
  const noteEl = document.getElementById("paymentNote");
  const bankEl = document.getElementById("paymentBankInfo");
  if (qrImg) qrImg.src = qrUrl;
  if (amountEl && paymentInfo?.amount) {
    amountEl.textContent = paymentInfo.amount.toLocaleString("vi-VN") + " đ";
  }
  if (noteEl && paymentInfo?.note) noteEl.textContent = paymentInfo.note;
  if (bankEl && paymentInfo?.accountNo) {
    bankEl.textContent = `${paymentInfo.bankId} — ${paymentInfo.accountNo} (${paymentInfo.accountName || ""})`;
  }
  modal.classList.remove("hidden");
}

function hidePaymentModal() {
  document.getElementById("paymentModal")?.classList.add("hidden");
  _paymentOrder = null;
}

async function confirmPaymentDone() {
  if (!_paymentOrder) return;
  const btn = document.getElementById("confirmPaymentBtn");
  if (btn) btn.disabled = true;
  try {
    const data = await apiRequest(`/api/packages/orders/${_paymentOrder.id}/confirm-payment`, {
      method: "POST"
    });
    hidePaymentModal();
    alert(data.message || "Đã xác nhận — admin sẽ duyệt sớm");
    await loadPendingPackageOrders();
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function countRowsWithPhone(rows) {
  return (rows || []).filter((r) => normalizePhone(r.phone).length >= 9).length;
}

function updateStatUsed() {
  const uniquePhones = countUniquePhonesInRows(currentData);
  const uncharged = getNewPhonesInRows(currentData).length;

  if (els.statUsed) els.statUsed.textContent = String(uniquePhones);
  if (els.statUsedHdr) els.statUsedHdr.textContent = String(uniquePhones);

  const balance = currentUser?.points ?? null;
  if (balance === null) {
    if (els.pkgPointsHdr) els.pkgPointsHdr.textContent = "-";
    if (els.infoPointsHdr) els.infoPointsHdr.textContent = "-";
    return;
  }

  // Tổng điểm trong tài khoản (sau các lần trừ đã ghi nhận)
  if (els.pkgPointsHdr) els.pkgPointsHdr.textContent = formatPoints(balance);
  // Còn lại = điểm khả dụng sau khi trừ các SĐT chưa thanh toán trong bảng
  const previewRemaining = Math.max(0, balance - uncharged);
  if (els.infoPointsHdr) els.infoPointsHdr.textContent = formatPoints(previewRemaining);
}

function syncSessionToExtension() {
  const token = getAuthToken();
  if (!token || !currentUser) return;
  window.postMessage(
    { source: "timdiemban-web", type: "LOGIN", payload: { token, user: currentUser } },
    window.location.origin
  );
}

function clearSessionInExtension() {
  window.postMessage({ source: "timdiemban-web", type: "LOGOUT", payload: {} }, window.location.origin);
}

async function refreshUserPoints() {
  const user = await loadCurrentUser();
  updateStatUsed();
  return user;
}

async function loadCurrentUser() {
  const token = getAuthToken();
  if (!token) {
    currentUser = null;
    updateAuthUI();
    if (window.location.pathname === "/") {
      window.location.replace("/");
    }
    return null;
  }
  try {
    const { user } = await apiRequest("/api/auth/me");
    // Admin được dùng trang tìm kiếm như user thường (vào /admin qua menu riêng)
    if (user && user.role !== "admin" && !user.termsAccepted) {
      window.location.replace("/login");
      return null;
    }
    currentUser = user;
    updateAuthUI();
    await loadPendingPackageOrders();
    return user;
  } catch {
    setAuthToken("");
    currentUser = null;
    updateAuthUI();
    clearSessionInExtension();
    if (window.location.pathname === "/") {
      window.location.replace("/");
    }
    return null;
  }
}

function showAuthModal() {
  els.authError.classList.add("hidden");
  els.authModal.classList.remove("hidden");
}

function hideAuthModal() {
  els.authModal.classList.add("hidden");
}

function toggleHeaderUserMenu(force) {
  if (!els.headerUserMenu) return;
  const nextOpen = typeof force === "boolean" ? force : els.headerUserMenu.classList.contains("hidden");
  els.headerUserMenu.classList.toggle("hidden", !nextOpen);
}

function openProfileModal() {
  if (!currentUser || !els.profileModal) return;
  if (els.profileEmail) els.profileEmail.value = currentUser.email || "";
  if (els.profileFullName) els.profileFullName.value = currentUser.fullName || "";
  if (els.profilePhone) els.profilePhone.value = currentUser.phone || "";
  if (els.profileCurrentPassword) els.profileCurrentPassword.value = "";
  if (els.profileNewPassword) els.profileNewPassword.value = "";
  if (els.profileConfirmPassword) els.profileConfirmPassword.value = "";
  if (els.profileMsg) els.profileMsg.classList.add("hidden");
  els.profileModal.classList.remove("hidden");
}

function markResultsRadiusFlags(rows, search) {
  const withDist = applyDistancesFromCenter(rows, search);
  return withDist.map((r) => ({
    ...r,
    outOfRadius: search?.lat && search?.lng && search?.radius ? !isResultInRadius(r, search) : false
  }));
}

function processResults(rows, search) {
  const cleaned = (rows || [])
    .filter((r) => isValidRowName(r.name))
    .map((r) => normalizeRowCoords({ ...r }));
  const deduped = dedupeResultRows(cleaned);
  const marked = markResultsRadiusFlags(deduped, search);
  marked.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  return marked;
}

function mergeApplyResults(rows, search) {
  const processed = processResults(rows, search);
  for (const row of processed) {
    upsertResult(row);
  }
  renderFullTable();
  els.infoTotal.textContent = currentData.length;
  updateStatUsed();
  window.TimDiemBanMap?.refreshMarkers(currentData);
  window.TimDiemBanMap?.countInOut(currentData);
  saveResultsToStorage();
}

function applyResults(rows, search, replace = false) {
  if (replace) {
    // Snapshot từ extension đã dedupe theo địa điểm — chỉ lọc tên lỗi + trùng place id/slug
    // (không gộp theo SĐT để tránh mất quán khác nhau cùng số tổng đài)
    const cleaned = (rows || [])
      .filter((r) => isValidRowName(r.name))
      .map((r) => normalizeRowCoords({ ...r }));
    const marked = markResultsRadiusFlags(cleaned, search);
    const out = [];
    for (const row of marked) {
      if (out.some((e) => isSamePlaceRow(e, row))) continue;
      out.push(row);
    }
    out.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
    currentData = out;
    renderFullTable();
    els.infoTotal.textContent = currentData.length;
    updateStatUsed();
    window.TimDiemBanMap?.refreshMarkers(currentData);
    window.TimDiemBanMap?.countInOut(currentData);
    saveResultsToStorage();
    return;
  }
  mergeApplyResults(rows, search);
}

function setConnStatus(text, type = "") {
  els.connStatus.textContent = text;
  els.connStatus.className = `conn-status ${type}`;
}

function showErrorBanner(title, text) {
  els.errorBannerTitle.textContent = title;
  els.errorBannerText.textContent = text;
  els.errorBanner.classList.remove("hidden");
}

function setInfoStatus(html) {
  if (els.infoStatus) els.infoStatus.innerHTML = html;
}

function hideErrorBanner() {
  els.errorBanner.classList.add("hidden");
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("vi-VN");
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getCanonicalPlaceId(url) {
  if (!url) return "";
  try {
    const decoded = decodeURIComponent(url);
    const chij = decoded.match(/!1s(ChIJ[a-zA-Z0-9_-]+)/);
    if (chij) return chij[1];
    const chijQ = decoded.match(/[?&]query_place_id=(ChIJ[a-zA-Z0-9_-]+)/);
    if (chijQ) return chijQ[1];
    const slugM = decoded.match(/\/maps\/place\/([^/@?]+)/);
    if (slugM && slugM[1].length > 1) {
      const slug = slugM[1].toLowerCase().replace(/\+/g, " ").slice(0, 120);
      const coords = extractCoordsFromUrl(url);
      if (coords && !isNaN(coords.lat) && !isNaN(coords.lng)) {
        return `slug:${slug}@${Number(coords.lat).toFixed(4)},${Number(coords.lng).toFixed(4)}`;
      }
      return "";
    }
  } catch {}
  return "";
}

function extractCoordsFromUrl(url) {
  if (!url) return null;
  const decoded = decodeURIComponent(url);
  const matches = [...decoded.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    return { lat: parseFloat(last[1]), lng: parseFloat(last[2]) };
  }
  return null;
}

function resolveRowCoords(row) {
  for (const url of [row.mapsUrl, row.href]) {
    const c = extractCoordsFromUrl(url);
    if (c) return c;
  }
  if (row.lat != null && row.lng != null) return { lat: row.lat, lng: row.lng };
  return null;
}

function normalizeRowCoords(row) {
  row.address = sanitizeDisplayAddress(row.address);
  const c = resolveRowCoords(row);
  if (c) {
    row.lat = c.lat;
    row.lng = c.lng;
  }
  const cid = getCanonicalPlaceId(row.mapsUrl || row.href || "") || row.googlePlaceId;
  if (cid) {
    row.googlePlaceId = cid;
    row.placeId = cid;
  }
  return row;
}

function isResultInRadius(row, search) {
  if (!search?.lat || !search?.lng || !search?.radius) return true;
  if (row.distanceKm != null && row.distanceKm <= search.radius + 0.2) return true;
  const c = resolveRowCoords(row);
  if (!c) return row.distanceKm != null && row.distanceKm <= search.radius + 0.2;
  return haversineKm(search.lat, search.lng, c.lat, c.lng) <= search.radius + 0.2;
}

function filterResultsByRadius(rows, search) {
  return markResultsRadiusFlags(
    rows.filter((r) => isValidRowName(r.name)),
    search
  );
}

function isValidRowName(name) {
  const n = (name || "").replace(/[\uFFFD\u200B-\u200D\uFEFF]/g, "").trim();
  if (n.length < 2) return false;
  const lower = n.toLowerCase();
  if (lower.includes("được tài trợ") || lower === "sponsored") return false;
  return /[\p{L}\p{N}]/u.test(n);
}

function applyDistancesFromCenter(rows, search) {
  if (!search?.lat || !search?.lng) return rows;
  return rows.map((r) => {
    const c = resolveRowCoords(r);
    if (!c) return r;
    const distanceKm =
      Math.round(haversineKm(search.lat, search.lng, c.lat, c.lng) * 100) / 100;
    return { ...r, lat: c.lat, lng: c.lng, distanceKm };
  });
}

function clearResultsForNewSearch() {
  // Không còn dùng để xóa khi tìm mới — giữ hàm trống/an toàn nếu còn chỗ gọi cũ
  awaitingNewSearchResults = false;
}

/** Bắt đầu lượt tìm mới — giữ nguyên kết quả đã lưu; chỉ cập nhật phiên + bản đồ. */
function beginFreshSearchUi(searchParams) {
  if (searchParams) {
    currentSearch = {
      ...searchParams,
      status: "running",
      startedAt: new Date().toISOString()
    };
  }
  awaitingNewSearchResults = false;
  extensionMergedCount = 0;
  if (currentData.length) {
    els.tableSection?.classList.remove("hidden");
    els.loadingState?.classList.add("hidden");
    els.emptyState?.classList.add("hidden");
  } else {
    els.loadingState?.classList.remove("hidden");
    els.emptyState?.classList.add("hidden");
  }
  // Lưu meta phiên hiện tại; KHÔNG xóa data cũ
  saveResultsToStorage(true);
  updateView();
}

function ensureSearchSession(search) {
  // Đổi searchId không xóa kết quả cũ — chỉ «Làm mới» mới xóa
  if (!search?.searchId) return;
}

function dedupeResultRows(rows) {
  const out = [];
  for (const raw of rows) {
    const row = normalizeRowCoords({ ...raw });
    if (out.some((e) => isDuplicateRow(e, row))) continue;
    out.push(row);
  }
  return out;
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d") // "đ" không có decomposition NFD — phải thay tay
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "");
}

function getChargedPhonesStorageKey() {
  const email = (currentUser?.email || "guest").trim().toLowerCase();
  return `timdiemban_charged_phones_${email}`;
}

function getChargedPhonesSet() {
  try {
    const raw = localStorage.getItem(getChargedPhonesStorageKey());
    return new Set(JSON.parse(raw || "[]"));
  } catch {
    return new Set();
  }
}

function saveChargedPhonesSet(set) {
  const arr = Array.from(set);
  if (arr.length > 50000) arr.splice(0, arr.length - 50000);
  localStorage.setItem(getChargedPhonesStorageKey(), JSON.stringify(arr));
}

function clearChargedPhonesForUser() {
  localStorage.removeItem(getChargedPhonesStorageKey());
}

/** Phiên cũ trừ theo searchId — đánh dấu SĐT hiện có là đã trừ, tránh trừ lại */
function migrateLegacyChargedSearchIds() {
  const legacyKey = "timdiemban_charged_searches";
  let legacy = [];
  try {
    legacy = JSON.parse(localStorage.getItem(legacyKey) || "[]");
  } catch {
    legacy = [];
  }
  if (!legacy.length || !currentData.length) return;

  const charged = getChargedPhonesSet();
  let added = 0;
  for (const row of currentData) {
    const phone = normalizePhone(row?.phone);
    if (phone.length >= 9 && !charged.has(phone)) {
      charged.add(phone);
      added++;
    }
  }
  if (added) saveChargedPhonesSet(charged);
  localStorage.removeItem(legacyKey);
}

/** SĐT unique trong bảng chưa trừ điểm */
function getNewPhonesInRows(rows) {
  const charged = getChargedPhonesSet();
  const seen = new Set();
  const list = [];
  for (const row of rows || []) {
    const phone = normalizePhone(row?.phone);
    if (phone.length >= 9 && !seen.has(phone)) {
      seen.add(phone);
      if (!charged.has(phone)) list.push(phone);
    }
  }
  return list;
}

function countUnchargedPhonesInRows(rows) {
  return getNewPhonesInRows(rows).length;
}

function countUniquePhonesInRows(rows) {
  const seen = new Set();
  let count = 0;
  for (const row of rows || []) {
    const phone = normalizePhone(row?.phone);
    if (phone.length >= 9 && !seen.has(phone)) {
      seen.add(phone);
      count++;
    }
  }
  return count;
}

function limitRowsByPaidPhones(rows) {
  const charged = getChargedPhonesSet();
  return (rows || []).filter((row) => {
    const phone = normalizePhone(row?.phone);
    if (phone.length < 9) return true;
    return charged.has(phone);
  });
}

let chargeFlushTimer = null;

function scheduleChargeNewPhones() {
  if (!getAuthToken() || !currentData.length) return;
  if (chargeFlushTimer) clearTimeout(chargeFlushTimer);
  chargeFlushTimer = setTimeout(() => {
    chargeFlushTimer = null;
    flushChargeNewPhones().catch((err) => {
      console.warn("flushChargeNewPhones:", err.message);
      setConnStatus(`Chưa cập nhật được số dư: ${err.message}`, "error");
    });
  }, 450);
}

async function flushChargeNewPhones() {
  if (!getAuthToken()) return null;
  const newPhones = getNewPhonesInRows(currentData);
  if (!newPhones.length) return null;

  const pointsInfo = await apiRequest("/api/search/charge", {
    method: "POST",
    body: JSON.stringify({ phoneCount: newPhones.length })
  });

  const paid = Math.max(0, Math.min(newPhones.length, Number(pointsInfo.charged) || 0));
  if (paid > 0) {
    const charged = getChargedPhonesSet();
    for (let i = 0; i < paid; i++) charged.add(newPhones[i]);
    saveChargedPhonesSet(charged);
  }

  if (pointsInfo?.user) {
    currentUser = pointsInfo.user;
  }
  await loadCurrentUser();
  syncSessionToExtension();

  if (paid < newPhones.length && currentSearch?.status !== "running") {
    // Không xóa hàng khỏi bảng khi hết credit — trước đây cắt SĐT chưa trừ điểm
    // khiến người dùng tưởng "không bắt được kết quả về".
    const unpaid = newPhones.length - paid;
    showErrorBanner(
      "Hết credit",
      `Đã trừ ${paid}/${newPhones.length} SĐT mới — còn ${unpaid} SĐT chưa trừ điểm. Dữ liệu vẫn giữ đủ trên bảng; nạp thêm điểm để tiếp tục trừ credit.`
    );
  }

  return pointsInfo;
}

async function tryChargePendingSearch() {
  if (!getAuthToken()) return null;
  if (countUnchargedPhonesInRows(currentData) <= 0) return null;

  try {
    const pointsInfo = await flushChargeNewPhones();
    if (pointsInfo && pointsInfo.charged > 0) {
      const { charged, remaining } = pointsInfo;
      const total = countUniquePhonesInRows(currentData);
      showErrorBanner(
        "Cập nhật credit",
        `${total} SĐT unique — dùng ${charged} điểm (quy đổi credit) — còn ${remaining} điểm`
      );
    }
    return pointsInfo;
  } catch (err) {
    console.warn("tryChargePendingSearch:", err.message);
    setConnStatus(`Chưa cập nhật được số dư: ${err.message}`, "error");
    return null;
  }
}

async function reconcileStaleSearchState(extStatus = {}) {
  const extRunning = !!(extStatus.running || extStatus.stalled);
  let changed = false;

  if (currentSearch?.status === "running" && !extRunning) {
    currentSearch = {
      ...currentSearch,
      status: currentData.length ? "completed" : "error",
      completedAt: currentSearch.completedAt || new Date().toISOString()
    };
    awaitingNewSearchResults = false;
    hideLiveProgress();
    saveResultsToStorage();
    changed = true;
    window.dispatchEvent(new CustomEvent("timdiemban:search-finished"));
  }

  if (currentSearch && currentSearch.status !== "running" && currentData.length) {
    await tryChargePendingSearch();
  }

  if (changed) updateView();
  return changed;
}

function normalizeAddress(address) {
  return normalizeName(address).replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}

function isVisitedLinkAddress(address) {
  const folded = (address || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d") // "đ" không có decomposition NFD — phải thay tay
    .toLowerCase()
    .trim();
  if (!folded) return false;
  return (
    /duong\s+lien\s+ket(\s+da)?\s+truy\s*c?ap/.test(folded) ||
    /visited\s+link/.test(folded)
  );
}

function sanitizeDisplayAddress(address) {
  const a = String(address || "").trim();
  if (!a || isVisitedLinkAddress(a)) return "";
  return a;
}

function pickBetterDisplayAddress(a, b) {
  const sa = sanitizeDisplayAddress(a);
  const sb = sanitizeDisplayAddress(b);
  if (sa && sb) return sa.length >= sb.length ? sa : sb;
  return sa || sb;
}

function getRowSlug(row) {
  for (const url of [row.href, row.mapsUrl]) {
    if (!url) continue;
    try {
      const m = decodeURIComponent(url).match(/\/maps\/place\/([^/@?]+)/);
      if (m) return decodeURIComponent(m[1]).toLowerCase().replace(/\+/g, " ").trim();
    } catch {}
  }
  return "";
}

function getResultKey(row) {
  const cid =
    row.googlePlaceId ||
    getCanonicalPlaceId(row.mapsUrl || row.href || "");
  if (cid) return `cid:${cid}`;
  const name = normalizeName(row.name);
  const phone = normalizePhone(row.phone);
  if (name && phone.length >= 9) return `np:${name}|${phone}`;
  const addr = normalizeAddress(row.address);
  if (name && addr.length > 8) return `na:${name}|${addr.slice(0, 60)}`;
  const c = resolveRowCoords(row);
  if (name && c) {
    return `coord:${name}|${Number(c.lat).toFixed(4)}|${Number(c.lng).toFixed(4)}`;
  }
  const slug = getRowSlug(row);
  if (slug && c) {
    return `place:${slug}@${Number(c.lat).toFixed(4)},${Number(c.lng).toFixed(4)}`;
  }
  return `fb:${name}|${(row.address || "").slice(0, 50)}`;
}

/** Khóa cố định cho DOM — không đổi khi quét lại bổ sung SĐT/địa chỉ */
function ensureStableKey(row) {
  if (!row._stableKey) row._stableKey = getResultKey(row);
  return row._stableKey;
}

function getDomKey(row) {
  return row?._stableKey || getResultKey(row);
}

function findRowIndexByStableKey(stableKey) {
  if (!stableKey) return -1;
  return currentData.findIndex(
    (r) => r._stableKey === stableKey || getDomKey(r) === stableKey || getResultKey(r) === stableKey
  );
}

function buildRescanHref(row) {
  const raw = (row.mapsUrl || row.href || "").split("#")[0];
  if (raw.includes("/maps/place") || raw.includes("query_place_id")) return raw;
  const pid = row.googlePlaceId || getCanonicalPlaceId(raw);
  const c = resolveRowCoords(row);
  const name = (row.name || "").trim();
  if (pid && String(pid).startsWith("ChIJ")) {
    const label = name ? encodeURIComponent(name) : c ? `${c.lat},${c.lng}` : "place";
    return `https://www.google.com/maps/search/?api=1&query=${label}&query_place_id=${pid}`;
  }
  if (c && name) {
    return `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${c.lat},${c.lng},17z`;
  }
  if (c) return `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`;
  if (name) return `https://www.google.com/maps/search/${encodeURIComponent(name)}`;
  return "";
}

function isDuplicateRow(a, b) {
  const pa = normalizePhone(a.phone);
  const pb = normalizePhone(b.phone);
  // Cùng SĐT không đủ — tránh mất chuỗi cửa hàng / tổng đài chung
  if (pa.length < 9 || pb.length < 9 || pa !== pb) return false;
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (na && nb && na === nb) return true;
  const ca = resolveRowCoords(a);
  const cb = resolveRowCoords(b);
  if (ca && cb) {
    return haversineKm(ca.lat, ca.lng, cb.lat, cb.lng) < 0.12;
  }
  return false;
}

function dedupeCurrentDataKeepFirst() {
  const kept = [];
  const seenPhones = new Set();
  // Duyệt từ cuối mảng → giữ bản cũ (thêm trước), bỏ bản mới trùng SĐT
  for (let i = currentData.length - 1; i >= 0; i--) {
    const row = currentData[i];
    const phone = normalizePhone(row.phone);
    if (phone.length >= 9) {
      if (seenPhones.has(phone)) continue;
      seenPhones.add(phone);
    }
    kept.unshift(row);
  }
  if (kept.length !== currentData.length) {
    currentData = kept;
    saveResultsToStorage();
  }
}

function isSamePlaceRow(a, b) {
  const idA = (a.googlePlaceId || getCanonicalPlaceId(a.mapsUrl || a.href || "")).toLowerCase();
  const idB = (b.googlePlaceId || getCanonicalPlaceId(b.mapsUrl || b.href || "")).toLowerCase();
  if (idA && idB && idA === idB) return true;
  const sa = getRowSlug(a);
  const sb = getRowSlug(b);
  const ca = resolveRowCoords(a);
  const cb = resolveRowCoords(b);
  // Cùng slug Maps chỉ coi trùng khi pin gần nhau (không gộp mọi quán cùng tên)
  if (sa && sb && sa === sb) {
    if (ca && cb) {
      return haversineKm(ca.lat, ca.lng, cb.lat, cb.lng) <= 0.12;
    }
  }
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (!na || !nb || na !== nb) return false;
  if (ca && cb) {
    return haversineKm(ca.lat, ca.lng, cb.lat, cb.lng) <= 0.12;
  }
  return normalizeAddress(a.address) === normalizeAddress(b.address);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isRowInRadius(row) {
  if (!currentSearch?.lat || currentSearch.radius == null) return true;
  const c = resolveRowCoords(row);
  if (!c) return true;
  return haversineKm(currentSearch.lat, currentSearch.lng, c.lat, c.lng) <= Number(currentSearch.radius) + 0.05;
}

function formatCoords(row) {
  const c = resolveRowCoords(row);
  if (!c) return "-";
  return `${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}`;
}

function getMapsViewUrl(row) {
  const raw = row.mapsUrl || row.href || "";
  if (raw && /google\.com\/maps/i.test(raw)) {
    return raw.split("#")[0];
  }
  const c = resolveRowCoords(row);
  if (c) {
    return `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`;
  }
  return "";
}

function getRowStt(key) {
  const idx = filteredData.findIndex((r) => getDomKey(r) === key);
  return idx >= 0 ? idx + 1 : "";
}

const MAP_PIN_ICON =
  '<svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" /></svg>';

const TRASH_ICON =
  '<svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>';

function jobsStatusBadge(row) {
  const result = jobsSyncResults.get(getDomKey(row));
  if (!result) return "";
  const labels = {
    created: "JOBS: ĐÃ TẠO",
    duplicate: "JOBS: TRÙNG SỐ",
    invalid: "JOBS: KHÔNG HỢP LỆ",
    failed: "JOBS: LỖI TẠM THỜI",
    forbidden: "JOBS: KHÔNG CÓ QUYỀN"
  };
  const label = labels[result.status] || "JOBS: LỖI TẠM THỜI";
  const statusClass = ["created", "duplicate", "invalid", "failed"].includes(result.status)
    ? result.status
    : "failed";
  return `<div class="wm-jobs-status"><span class="wm-status-badge wm-status-jobs-${statusClass}" title="${escapeAttr(result.message || "")}">${label}</span></div>`;
}

function buildRowHtml(row, stt) {
  const key = escapeAttr(getDomKey(row));
  const displayStt = stt != null ? stt : getRowStt(key);
  const coords = formatCoords(row);
  const hasView = Boolean(getMapsViewUrl(row));
  const viewBtn = hasView
    ? `<button type="button" class="wm-icon-btn wm-icon-btn-map" data-action="view" data-key="${key}" title="Xem trên Maps">${MAP_PIN_ICON}</button>`
    : `<button type="button" class="wm-icon-btn wm-icon-btn-map" disabled title="Chưa có tọa độ">${MAP_PIN_ICON}</button>`;

  const statusBadge = sentKeys.has(getResultKey(row))
    ? '<span class="wm-status-badge wm-status-sent">ĐÃ GỬI</span>'
    : '<span class="wm-status-badge wm-status-draft">NHÁP</span>';
  const radiusBadge = !isRowInRadius(row)
    ? '<span class="wm-radius-badge" title="Ngoài bán kính đã chọn">Ngoài vùng</span>'
    : "";

  return `
    <td class="col-check"><input type="checkbox" class="row-check" data-key="${key}" /></td>
    <td class="col-stt">${displayStt !== "" ? displayStt : ""}</td>
    <td class="col-name"><span title="${escapeAttr(row.name || "")}">${escapeHtml(row.name || "")}</span>${radiusBadge}</td>
    <td class="col-addr" title="${escapeAttr(row.address || "")}">${escapeHtml(row.address || "-")}</td>
    <td class="col-phone">${escapeHtml(row.phone || "-")}</td>
    <td class="col-website">${formatWebsiteCell(row)}</td>
    <td class="col-rating">${formatRatingCell(row)}</td>
    <td class="col-coords" title="${escapeAttr(coords)}">${escapeHtml(coords)}</td>
    <td class="col-status">${statusBadge}${jobsStatusBadge(row)}</td>
    <td class="col-actions">
      ${viewBtn}
      <button type="button" class="wm-icon-btn wm-icon-btn-danger" data-action="delete" data-key="${key}" title="Xóa">${TRASH_ICON}</button>
    </td>`;
}

function matchesFilter(row, q) {
  if (!q) return true;
  return (
    (row.name || "").toLowerCase().includes(q) ||
    (row.address || "").toLowerCase().includes(q) ||
    (row.phone || "").toLowerCase().includes(q) ||
    (row.website || "").toLowerCase().includes(q) ||
    (row.category || "").toLowerCase().includes(q)
  );
}

function upsertResult(result) {
  if (!isValidRowName(result.name)) return { isNew: false, index: -1, key: "", skipped: true };
  const incoming = normalizeRowCoords({ ...result });
  if (currentSearch?.lat) {
    const c = resolveRowCoords(incoming);
    if (c) {
      incoming.distanceKm =
        Math.round(haversineKm(currentSearch.lat, currentSearch.lng, c.lat, c.lng) * 100) / 100;
    }
  }

  const sourceKey = incoming._sourceKey || incoming.sourceKey;
  if (sourceKey) {
    const srcIdx = findRowIndexByStableKey(sourceKey);
    if (srcIdx >= 0) {
      const prev = currentData[srcIdx];
      const merged = normalizeRowCoords({
        ...prev,
        ...incoming,
        href: incoming.href || prev.href,
        mapsUrl: incoming.mapsUrl || incoming.href || prev.mapsUrl || prev.href,
        phone: incoming.phone || prev.phone,
        address: pickBetterDisplayAddress(incoming.address, prev.address),
        website: incoming.website || prev.website,
        rating: incoming.rating || prev.rating,
        reviews: incoming.reviews || prev.reviews,
        category: incoming.category || prev.category,
        hours: incoming.hours || prev.hours,
        lat: incoming.lat ?? prev.lat,
        lng: incoming.lng ?? prev.lng,
        distanceKm: incoming.distanceKm ?? prev.distanceKm,
        googlePlaceId: incoming.googlePlaceId || prev.googlePlaceId,
        _phase: incoming._phase || prev._phase,
        _stableKey: prev._stableKey || sourceKey
      });
      delete merged._sourceKey;
      delete merged.sourceKey;
      if (currentSearch?.lat) {
        const c = resolveRowCoords(merged);
        if (c) {
          merged.distanceKm =
            Math.round(haversineKm(currentSearch.lat, currentSearch.lng, c.lat, c.lng) * 100) / 100;
        }
      }
      currentData[srcIdx] = merged;
      return {
        isNew: false,
        index: srcIdx,
        key: getDomKey(merged),
        skipped: false,
        updated: true
      };
    }
  }

  // Trùng SĐT — cập nhật bản cũ thay vì bỏ im lặng (tránh lệch số ext vs web)
  const dupIdx = currentData.findIndex((r) => isDuplicateRow(r, incoming));
  if (dupIdx >= 0) {
    const prev = currentData[dupIdx];
    const merged = normalizeRowCoords({
      ...prev,
      ...incoming,
      href: incoming.href || prev.href,
      mapsUrl: incoming.mapsUrl || incoming.href || prev.mapsUrl || prev.href,
      phone: incoming.phone || prev.phone,
      address: pickBetterDisplayAddress(incoming.address, prev.address),
      website: incoming.website || prev.website,
      rating: incoming.rating || prev.rating,
      reviews: incoming.reviews || prev.reviews,
      category: incoming.category || prev.category,
      hours: incoming.hours || prev.hours,
      lat: incoming.lat ?? prev.lat,
      lng: incoming.lng ?? prev.lng,
      distanceKm: incoming.distanceKm ?? prev.distanceKm,
      googlePlaceId: incoming.googlePlaceId || prev.googlePlaceId,
      _phase: incoming._phase || prev._phase,
      _stableKey: prev._stableKey || ensureStableKey(prev)
    });
    if (currentSearch?.lat) {
      const c = resolveRowCoords(merged);
      if (c) {
        merged.distanceKm =
          Math.round(haversineKm(currentSearch.lat, currentSearch.lng, c.lat, c.lng) * 100) / 100;
      }
    }
    currentData[dupIdx] = merged;
    return { isNew: false, index: dupIdx, key: getDomKey(merged), skipped: false, updated: true };
  }

  // Cùng địa điểm (slug/place id) — cập nhật tại chỗ, không đổi thứ tự (quét lại)
  const sameIdx = currentData.findIndex((r) => isSamePlaceRow(r, incoming));
  if (sameIdx >= 0) {
    const prev = currentData[sameIdx];
    const merged = normalizeRowCoords({
      ...prev,
      ...incoming,
      href: incoming.href || prev.href,
      mapsUrl: incoming.mapsUrl || incoming.href || prev.mapsUrl || prev.href,
      phone: incoming.phone || prev.phone,
      address: pickBetterDisplayAddress(incoming.address, prev.address),
      website: incoming.website || prev.website,
      rating: incoming.rating || prev.rating,
      reviews: incoming.reviews || prev.reviews,
      category: incoming.category || prev.category,
      hours: incoming.hours || prev.hours,
      lat: incoming.lat ?? prev.lat,
      lng: incoming.lng ?? prev.lng,
      distanceKm: incoming.distanceKm ?? prev.distanceKm,
      googlePlaceId: incoming.googlePlaceId || prev.googlePlaceId,
      _phase: incoming._phase || prev._phase,
      _stableKey: prev._stableKey || ensureStableKey(prev)
    });
    if (currentSearch?.lat) {
      const c = resolveRowCoords(merged);
      if (c) {
        merged.distanceKm =
          Math.round(haversineKm(currentSearch.lat, currentSearch.lng, c.lat, c.lng) * 100) / 100;
      }
    }
    currentData[sameIdx] = merged;
    return { isNew: false, index: sameIdx, key: getDomKey(merged), skipped: false, updated: true };
  }

  // Mới → thêm lên đầu danh sách
  ensureStableKey(incoming);
  currentData.unshift(incoming);
  return { isNew: true, index: 0, key: getDomKey(incoming), skipped: false };
}

function formatWebsiteCell(row) {
  const raw = String(row.website || "").trim();
  if (!raw) return "-";
  let href = raw;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  let label = raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  try {
    label = new URL(href).hostname.replace(/^www\./i, "") || label;
  } catch {
    /* keep label */
  }
  return `<a class="wm-website-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(raw)}">${escapeHtml(label)}</a>`;
}

function formatRatingCell(row) {
  const rating = String(row.rating || "").trim();
  if (!rating) return "-";
  const reviews = String(row.reviews || "").trim();
  if (reviews) {
    return `${escapeHtml(rating)} <span class="wm-reviews-count">(${escapeHtml(reviews)})</span>`;
  }
  return escapeHtml(rating);
}

function buildFilteredData() {
  const q = els.searchFilter?.value.trim().toLowerCase() || "";
  return q ? currentData.filter((r) => matchesFilter(r, q)) : currentData;
}

function getTotalPages(count) {
  return Math.max(1, Math.ceil(count / TABLE_PAGE_SIZE));
}

function updatePaginationControls(visibleCount) {
  const totalPages = getTotalPages(visibleCount);
  if (currentPage > totalPages) currentPage = totalPages;
  if (els.pageInfo) els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  if (els.pagePrevBtn) els.pagePrevBtn.disabled = currentPage <= 1;
  if (els.pageNextBtn) els.pageNextBtn.disabled = currentPage >= totalPages;
  if (els.tablePaginationControls) {
    els.tablePaginationControls.classList.toggle("hidden", visibleCount <= TABLE_PAGE_SIZE);
  }
}

function updateFilterCount() {
  const q = els.searchFilter?.value.trim().toLowerCase() || "";
  const visible = q
    ? currentData.filter((r) => matchesFilter(r, q)).length
    : currentData.length;
  const total = currentData.length;
  if (els.filterCount) {
    els.filterCount.textContent = `Hiển thị ${visible} / ${total} kết quả`;
  }
  if (els.resultsBadge) {
    els.resultsBadge.textContent = total
      ? `${visible} KẾT QUẢ PHÙ HỢP`
      : "0 KẾT QUẢ";
  }
  if (els.tablePagination) {
    if (!visible) {
      els.tablePagination.textContent = "Hiển thị 0 điểm bán";
    } else {
      const start = (currentPage - 1) * TABLE_PAGE_SIZE + 1;
      const end = Math.min(currentPage * TABLE_PAGE_SIZE, visible);
      els.tablePagination.textContent = `Hiển thị ${start} – ${end} của ${visible} điểm bán`;
    }
  }
  updatePaginationControls(visible);
  updateSearchResultBox();
}

function updateSearchResultBox() {
  if (!els.searchResultText) return;
  const total = currentData.length;
  const q = els.searchFilter?.value.trim().toLowerCase() || "";
  const keyword = currentSearch?.keyword || document.getElementById("searchKeyword")?.value || "";
  const radius = currentSearch?.radius || document.getElementById("searchRadius")?.value || "";

  if (liveProgressText) {
    els.searchResultText.textContent = liveProgressText;
    return;
  }

  if (!total && !currentSearch) {
    els.searchResultText.textContent = "Hiện chưa có dữ liệu — nhập từ khóa và bấm Tìm kiếm ngay.";
    return;
  }

  const visible = q ? currentData.filter((r) => matchesFilter(r, q)).length : total;
  const kw = keyword ? `"${keyword}"` : "từ khóa hiện tại";
  const r = radius ? `${radius}km` : "vùng đã chọn";

  if (currentSearch?.status === "running") {
    els.searchResultText.textContent = `Đang quét ${kw} trong phạm vi ${r}…`;
  } else if (total) {
    els.searchResultText.textContent = `Đang hiển thị ${visible}/${total} kết quả phù hợp nhất cho ${kw} trong phạm vi ${r}.`;
  } else {
    els.searchResultText.textContent = `Chưa tìm thấy kết quả cho ${kw} trong phạm vi ${r}.`;
  }
}

function setLiveProgress(text, percent) {
  liveProgressText = text || "";
  if (els.liveProgress) {
    els.liveProgress.classList.remove("hidden");
    els.liveProgressTextEl.textContent = text || "";
    if (els.liveProgressBar) {
      els.liveProgressBar.style.width = `${Math.min(100, percent || 0)}%`;
    }
  }
  updateSearchResultBox();
}

function hideLiveProgress() {
  liveProgressText = "";
  if (els.liveProgress) els.liveProgress.classList.add("hidden");
  updateSearchResultBox();
}

function renderSearchInfo(search) {
  if (els.infoKeyword) els.infoKeyword.textContent = search.keyword || "-";
  if (els.infoRadius) {
    const rKm = search.radius;
    els.infoRadius.textContent = rKm
      ? search.gridCells
        ? `${rKm} km / ${search.gridCells} ô`
        : `${rKm} km`
      : "-";
  }
  if (els.infoCoords && search.lat != null && search.lng != null) {
    els.infoCoords.textContent = `${Number(search.lat).toFixed(5)}, ${Number(search.lng).toFixed(5)}`;
  }
  const regions = (search.gridPoints || []).map((p) => p.cellLabel || p.cellId).filter(Boolean);
  if (els.infoRegions) {
    els.infoRegions.textContent = regions.length ? `${regions.length} ô` : search.gridCells ? `${search.gridCells} ô` : "-";
  }
  if (els.infoTime) {
    els.infoTime.textContent = formatTime(search.completedAt || search.startedAt);
  }
  if (search.status === "running") {
    setInfoStatus('<span class="status-badge status-running">Đang tìm</span>');
  } else if (search.status === "error") {
    setInfoStatus('<span class="status-badge status-error">Lỗi</span>');
  } else if (search.status === "completed") {
    setInfoStatus('<span class="status-badge status-completed">Xong</span>');
  }
  if (els.infoTotal) els.infoTotal.textContent = String(currentData.length);
  if (els.infoPoints) els.infoPoints.textContent = currentUser ? formatPoints(currentUser.points) : "-";
  updateStatUsed();
  if (search.gridCells && els.infoGridCells) {
    els.infoGridCells.textContent = String(search.gridCells);
  }
}

function renderEmptyTableRow() {
  els.resultsBody.innerHTML = `
    <tr class="row-empty">
      <td class="col-check"><input type="checkbox" disabled /></td>
      <td colspan="9" class="empty-cell-msg">Hiện chưa có dữ liệu, hãy bắt đầu tìm kiếm</td>
    </tr>`;
  if (els.checkAllRows) els.checkAllRows.checked = false;
  currentPage = 1;
  updateFilterCount();
  updateSyncJobsButton();
}

function renderFullTable() {
  filteredData = buildFilteredData();
  rowKeyMap.clear();

  if (!filteredData.length) {
    renderEmptyTableRow();
    updateStatUsed();
    return;
  }

  const totalPages = getTotalPages(filteredData.length);
  if (currentPage > totalPages) currentPage = totalPages;
  const startIdx = (currentPage - 1) * TABLE_PAGE_SIZE;
  const pageRows = filteredData.slice(startIdx, startIdx + TABLE_PAGE_SIZE);

  els.resultsBody.innerHTML = pageRows
    .map((row, i) => {
      const key = getDomKey(row);
      rowKeyMap.set(key, row);
      const rowClass = isRowInRadius(row) ? "row-in-radius" : "row-out-radius";
      const stt = startIdx + i + 1;
      return `<tr data-key="${escapeAttr(key)}" class="row-live ${rowClass}">${buildRowHtml(row, stt)}</tr>`;
    })
    .join("");

  if (els.checkAllRows) els.checkAllRows.checked = false;
  updateFilterCount();
  updateStatUsed();
  updateSyncJobsButton();
}

let lastRowScrollAt = 0;

function upsertTableRow(result) {
  const q = els.searchFilter?.value.trim().toLowerCase() || "";
  const { isNew, index, key, skipped, updated } = upsertResult(result);
  if (index < 0 || skipped) return;
  const row = currentData[index];

  els.infoTotal.textContent = currentData.length;
  updateStatUsed();

  if (!row) {
    renderFullTable();
    return;
  }

  filteredData = buildFilteredData();
  const domKey = getDomKey(row);

  if (q && !matchesFilter(row, q)) {
    if (updated) renderFullTable();
    else updateFilterCount();
    saveResultsToStorage();
    return;
  }

  const tr = els.resultsBody.querySelector(`tr[data-key="${CSS.escape(domKey)}"]`);

  if (tr && (updated || !isNew)) {
    tr.className = `row-live row-updated ${isRowInRadius(row) ? "row-in-radius" : "row-out-radius"}`;
    tr.innerHTML = buildRowHtml(row);
    setTimeout(() => tr.classList.remove("row-updated"), 1200);
    updateFilterCount();
    window.TimDiemBanMap?.upsertMarker(row);
    window.TimDiemBanMap?.countInOut(currentData);
    saveResultsToStorage();
    return;
  }

  const useFastPath =
    !q &&
    currentPage === 1 &&
    filteredData.length <= TABLE_PAGE_SIZE;

  if (!useFastPath) {
    renderFullTable();
    window.TimDiemBanMap?.upsertMarker(row);
    window.TimDiemBanMap?.countInOut(currentData);
    saveResultsToStorage();
    return;
  }

  if (isNew) {
    const emptyRow = els.resultsBody.querySelector(".row-empty");
    if (emptyRow) emptyRow.remove();
    const newTr = document.createElement("tr");
    newTr.dataset.key = domKey;
    newTr.className = `row-live row-new ${isRowInRadius(row) ? "row-in-radius" : "row-out-radius"}`;
    newTr.innerHTML = buildRowHtml(row, 1);
    els.resultsBody.insertBefore(newTr, els.resultsBody.firstChild);
    const dataRows = els.resultsBody.querySelectorAll("tr[data-key]");
    if (dataRows.length > TABLE_PAGE_SIZE) {
      dataRows[dataRows.length - 1].remove();
    }
    setTimeout(() => newTr.classList.remove("row-new"), 1200);
    newTr.scrollIntoView({ behavior: "auto", block: "nearest" });
  } else {
    renderFullTable();
    window.TimDiemBanMap?.upsertMarker(row);
    window.TimDiemBanMap?.countInOut(currentData);
    saveResultsToStorage();
    return;
  }

  updateFilterCount();
  window.TimDiemBanMap?.upsertMarker(row);
  window.TimDiemBanMap?.countInOut(currentData);
  saveResultsToStorage();
  reorderAllStt();
}

function reorderAllStt() {
  const startIdx = (currentPage - 1) * TABLE_PAGE_SIZE;
  els.resultsBody.querySelectorAll("tr[data-key]").forEach((tr, i) => {
    const sttCell = tr.querySelector(".col-stt");
    if (sttCell) sttCell.textContent = String(startIdx + i + 1);
  });
}

function viewRowOnMaps(key) {
  const row = getRowByKey(key);
  if (!row) return;
  const url = getMapsViewUrl(row);
  if (!url) {
    setConnStatus("Không có tọa độ để mở Maps", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  const c = resolveRowCoords(row);
  if (c) window.TimDiemBanMap?.focusPoint?.(c.lat, c.lng);
}

function applyFilter() {
  currentPage = 1;
  renderFullTable();
}

function syncExportButtons() {
  const disabled = currentData.length === 0;
  if (els.exportBtn) els.exportBtn.disabled = disabled;
  if (els.exportBtnFooter) els.exportBtnFooter.disabled = disabled;
  updateSendSiteButton();
  updateRescanBtn();
}

function getRowByKey(key) {
  return currentData.find((r) => getDomKey(r) === key);
}

function deleteRowByKey(key) {
  currentData = currentData.filter((r) => getDomKey(r) !== key);
  renderFullTable();
  window.TimDiemBanMap?.refreshMarkers(currentData);
  window.TimDiemBanMap?.countInOut(currentData);
  els.infoTotal.textContent = String(currentData.length);
  syncExportButtons();
  saveResultsToStorage();
}

function deleteRowsByKeys(keys) {
  const set = new Set(keys);
  currentData = currentData.filter((r) => !set.has(getDomKey(r)));
  renderFullTable();
  window.TimDiemBanMap?.refreshMarkers(currentData);
  window.TimDiemBanMap?.countInOut(currentData);
  els.infoTotal.textContent = String(currentData.length);
  syncExportButtons();
  saveResultsToStorage();
}

function rowToPushPayload(row) {
  return {
    name: row.name || "",
    address: row.address || "",
    phone: row.phone || "",
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    rating: row.rating || "",
    reviews: row.reviews || "",
    mapsUrl: row.mapsUrl || row.href || "",
    googlePlaceId: row.googlePlaceId || row.placeId || "",
    category: row.category || "",
    website: row.website || "",
    distanceKm: row.distanceKm ?? null
  };
}

const PUSH_BATCH_SIZE = 50;

async function pushPointsToServer(points, { silent = false } = {}) {
  if (!getAuthToken()) {
    showAuthModal();
    throw new Error("Vui lòng đăng nhập");
  }
  if (!points.length) throw new Error("Không có điểm để gửi");

  if (!silent) setConnStatus(`Đang gửi ${points.length} điểm…`, "");

  const data = await apiRequest("/api/points/push", {
    method: "POST",
    body: JSON.stringify({ points: points.map(rowToPushPayload) })
  });

  return data;
}

async function pushPointsToServerBatched(points, { silent = false, onProgress, batchSize = PUSH_BATCH_SIZE } = {}) {
  if (!getAuthToken()) {
    showAuthModal();
    throw new Error("Vui lòng đăng nhập");
  }
  const total = points.length;
  if (!total) throw new Error("Không có điểm để gửi");

  let totalPushed = 0;
  let totalFailed = 0;
  let lastHost = winmapSite.host || "";
  let lastMode = "";

  for (let i = 0; i < total; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    const processed = Math.min(i + batch.length, total);

    if (onProgress) {
      onProgress({ sent: totalPushed, failed: totalFailed, processed, total });
    }
    if (!silent) {
      setConnStatus(
        `Đang gửi ${processed}/${total} điểm… (đã gửi OK: ${totalPushed})`,
        ""
      );
    }

    const data = await apiRequest("/api/points/push", {
      method: "POST",
      body: JSON.stringify({ points: batch.map(rowToPushPayload) })
    });

    totalPushed += Number(data.pushed) || 0;
    totalFailed += Number(data.failed) || 0;
    if (data.host) lastHost = data.host;
    if (data.mode) lastMode = data.mode;
  }

  return {
    ok: true,
    pushed: totalPushed,
    failed: totalFailed,
    total,
    host: lastHost,
    mode: lastMode,
    message:
      totalFailed > 0
        ? `Gửi ${totalPushed}/${total} điểm (${totalFailed} lỗi/trùng)`
        : `Đã gửi ${totalPushed} điểm`
  };
}

function getCheckedKeys() {
  if (!els.resultsBody) return [];
  return Array.from(els.resultsBody.querySelectorAll(".row-check:checked")).map((cb) => cb.dataset.key);
}

function getRowsToSend() {
  const checkedKeys = getCheckedKeys();
  if (checkedKeys.length) {
    const set = new Set(checkedKeys);
    return currentData.filter((r) => set.has(getDomKey(r)));
  }
  return currentData;
}

function normalizeJobsPhone(phone) {
  let digits = String(phone || "").replace(/\D+/g, "");
  if (digits.startsWith("84") && digits.length >= 11) digits = `0${digits.slice(2)}`;
  return digits.length >= 9 && digits.length <= 11 ? digits : "";
}

function getSelectedJobsRows() {
  const checked = new Set(getCheckedKeys());
  if (!checked.size) return [];
  return currentData.filter((row) => checked.has(getDomKey(row)));
}

function updateSyncJobsButton() {
  if (!els.syncJobsBtn) return;
  const selected = getSelectedJobsRows();
  const validCount = selected.filter((row) => normalizeJobsPhone(row.phone)).length;
  const linked = Boolean(currentUser && jobsIntegrationStatus?.linked);

  els.syncJobsBtn.disabled = jobsSyncBusy || !linked || validCount < 1;
  els.syncJobsBtn.textContent = jobsSyncBusy
    ? "Đang đồng bộ..."
    : validCount > 0
      ? `Đồng bộ Jobs (${validCount})`
      : "Đồng bộ Jobs";
  els.syncJobsBtn.title = !currentUser
    ? "Đăng nhập Findmap để đồng bộ"
    : !jobsIntegrationStatus?.linked
      ? "Chưa kết nối Jobs ClickOn"
      : validCount < 1
        ? "Chọn ít nhất một dòng có số điện thoại hợp lệ"
        : `Đồng bộ ${validCount} dòng có số điện thoại sang Jobs ClickOn`;

  if (els.syncJobsHint) {
    els.syncJobsHint.innerHTML = linked
      ? `Đang gán cho <strong>${escapeHtml(jobsIntegrationStatus.name || jobsIntegrationStatus.email || "tài khoản Jobs")}</strong>`
      : 'Kết nối tài khoản tại <a href="/ket-noi-jobs">Kết nối Jobs</a>';
  }
}

async function loadJobsIntegrationStatus() {
  if (!currentUser) {
    jobsIntegrationStatus = { linked: false };
    updateSyncJobsButton();
    return jobsIntegrationStatus;
  }
  try {
    jobsIntegrationStatus = await apiRequest("/api/integrations/jobs/status");
  } catch (error) {
    jobsIntegrationStatus = { linked: false, error: error.message };
    if (els.syncJobsHint) {
      els.syncJobsHint.textContent = "Không tải được trạng thái Jobs. Kiểm tra lại trang kết nối.";
    }
  }
  updateSyncJobsButton();
  return jobsIntegrationStatus;
}

function rowToJobsSyncPayload(row) {
  const coords = resolveRowCoords(row);
  return {
    client_key: getDomKey(row),
    place_id: row.googlePlaceId || row.placeId || "",
    name: row.name || "",
    phone: row.phone || "",
    address: row.address || "",
    website: row.website || "",
    rating: row.rating ?? "",
    latitude: coords?.lat ?? null,
    longitude: coords?.lng ?? null,
    google_maps_url: getMapsViewUrl(row),
    category: row.category || currentSearch?.keyword || "",
    notes: row.notes || "",
    searched_at: row.searchedAt || currentSearch?.completedAt || currentSearch?.createdAt || new Date().toISOString()
  };
}

function showJobsSyncSummary(summary = {}, requestId = "", message = "", isError = false) {
  if (!els.jobsSyncSummary) return;
  els.jobsSyncSummary.classList.remove("hidden");
  els.jobsSyncSummary.classList.toggle("error", isError);
  if (els.jobsSyncRequestId) els.jobsSyncRequestId.textContent = requestId || "";
  if (els.jobsSyncTotal) els.jobsSyncTotal.textContent = String(summary.total || 0);
  if (els.jobsSyncCreated) els.jobsSyncCreated.textContent = String(summary.created || 0);
  if (els.jobsSyncDuplicate) els.jobsSyncDuplicate.textContent = String(summary.duplicate || 0);
  if (els.jobsSyncInvalid) els.jobsSyncInvalid.textContent = String(summary.invalid || 0);
  if (els.jobsSyncFailed) els.jobsSyncFailed.textContent = String(summary.failed || 0);
  if (els.jobsSyncMessage) els.jobsSyncMessage.textContent = message || "";
}

async function syncSelectedRowsToJobs() {
  const selected = getSelectedJobsRows();
  const validCount = selected.filter((row) => normalizeJobsPhone(row.phone)).length;
  if (!jobsIntegrationStatus?.linked || validCount < 1 || jobsSyncBusy) return;

  const requestNonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2, 10);
  const requestId = `findmap-${Date.now()}-${requestNonce}`;
  jobsSyncBusy = true;
  updateSyncJobsButton();
  showJobsSyncSummary({ total: selected.length }, requestId, "Đang gửi dữ liệu...", false);
  try {
    const response = await apiRequest("/api/integrations/jobs/sync-customers", {
      method: "POST",
      body: JSON.stringify({
        request_id: requestId,
        items: selected.map(rowToJobsSyncPayload)
      })
    });
    (response.items || []).forEach((item) => {
      if (!item.client_key) return;
      jobsSyncResults.set(item.client_key, {
        status: item.status,
        message: item.message || "",
        clientId: item.client_id || null,
        updatedAt: new Date().toISOString()
      });
    });
    showJobsSyncSummary(
      response.summary,
      response.request_id,
      response.replayed ? "Yêu cầu đã được xử lý trước đó; kết quả được trả lại an toàn." : "Đồng bộ hoàn tất.",
      Number(response.summary?.failed || 0) > 0
    );
    saveResultsToStorage(true);
    renderFullTable();
    await loadJobsIntegrationStatus();
  } catch (error) {
    const status = error.status === 403 ? "forbidden" : "failed";
    selected.forEach((row) => {
      jobsSyncResults.set(getDomKey(row), {
        status,
        message: error.message,
        updatedAt: new Date().toISOString()
      });
    });
    showJobsSyncSummary(
      { total: selected.length, failed: selected.length },
      requestId,
      error.message,
      true
    );
    saveResultsToStorage(true);
    renderFullTable();
    if (error.status === 401 || error.code === "jobs_token_invalid") {
      await loadJobsIntegrationStatus();
    }
  } finally {
    jobsSyncBusy = false;
    updateSyncJobsButton();
  }
}

let winmapSite = { url: "", host: "", label: "", hasToken: false, configured: false };

function formatSiteHostForUi(host, maxLen = 22) {
  const raw = String(host || "").trim();
  if (!raw) return "";
  let display = raw;
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withProto);
    display = u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
  } catch {
    /* giữ raw */
  }
  if (display.length <= maxLen) return display;
  return `${display.slice(0, Math.max(10, maxLen - 1))}…`;
}

function updateSendSiteButton() {
  if (!els.sendSiteBtn) return;
  const host = winmapSite.host || "";
  const shortHost = formatSiteHostForUi(winmapSite.label || host, 20);
  const checkedCount = getCheckedKeys().length;
  const sendCount = checkedCount || currentData.length;
  els.sendSiteBtn.textContent = shortHost
    ? checkedCount
      ? `Gửi ${checkedCount} đã chọn về ${shortHost}`
      : `Gửi tất cả về ${shortHost}`
    : "Gửi về site";
  els.sendSiteBtn.disabled = !sendCount || !winmapSite.configured;
  els.sendSiteBtn.title = !winmapSite.configured
    ? "Chưa cấu hình site — vào Cấu hình site để lưu URL + token"
    : !sendCount
      ? "Chưa có dữ liệu để gửi"
      : `Gửi ${sendCount} điểm về ${host}`;
}

function updateRescanBtn() {
  if (!els.rescanBtn) return;

  // Chỉ cho quét lại SAU KHI quét xong (status !== "running")
  const searchStillRunning = currentSearch?.status === "running";
  if (searchStillRunning) {
    els.rescanBtn.textContent = "Đợi quét xong…";
    els.rescanBtn.disabled = true;
    els.rescanBtn.title = "Chờ quét chính kết thúc rồi mới được quét lại";
    return;
  }

  if (rescanRunning) {
    const { done, total } = rescanProgress;
    els.rescanBtn.textContent =
      total > 0 ? `Đang quét lại ${done}/${total}…` : "Đang quét lại…";
    els.rescanBtn.disabled = true;
    els.rescanBtn.dataset.rescanBusy = "1";
    els.rescanBtn.title = "Đang quét lại — vui lòng đợi hoàn tất";
    return;
  }
  if (els.rescanBtn) delete els.rescanBtn.dataset.rescanBusy;
  const checkedKeys = getCheckedKeys();
  if (checkedKeys.length) {
    els.rescanBtn.textContent = `Quét lại ${checkedKeys.length} đã chọn`;
    els.rescanBtn.disabled = false;
    els.rescanBtn.title = "Quét lại những điểm đã chọn";
  } else {
    const missing = currentData.filter(
      (r) => !normalizePhone(r.phone).length || !r.address?.trim()
    );
    els.rescanBtn.textContent = missing.length
      ? `Quét lại ${missing.length} thiếu TT`
      : "Quét lại";
    els.rescanBtn.disabled = !missing.length;
    els.rescanBtn.title = missing.length
      ? "Quét lại những điểm thiếu SĐT hoặc địa chỉ"
      : "Không có điểm cần quét lại";
  }
}

function rescanMissingRows() {
  // Không cho quét lại khi search đang chạy
  if (currentSearch?.status === "running") {
    setConnStatus("Đợi quét chính kết thúc trước khi quét lại", "error");
    return;
  }
  if (rescanRunning || els.rescanBtn?.dataset.rescanBusy === "1") {
    setConnStatus("Đang quét lại — vui lòng đợi hoàn tất", "");
    return;
  }

  const checkedKeys = getCheckedKeys();
  let rows;
  if (checkedKeys.length) {
    const set = new Set(checkedKeys);
    rows = currentData.filter((r) => set.has(getDomKey(r)));
  } else {
    rows = currentData.filter(
      (r) => !normalizePhone(r.phone).length || !r.address?.trim()
    );
  }
  if (!rows.length) {
    setConnStatus("Không có điểm nào cần quét lại", "");
    return;
  }

  rescanSessionId += 1;
  const sessionId = rescanSessionId;
  rescanRunning = true;
  rescanProgress = { done: 0, total: rows.length };
  if (els.rescanBtn) {
    els.rescanBtn.disabled = true;
    els.rescanBtn.dataset.rescanBusy = "1";
  }
  updateRescanBtn();
  armRescanAckTimeout(sessionId);
  setConnStatus(`Đang quét lại ${rows.length} điểm…`, "");
  const places = rows.map((r) => {
    const sourceKey = getDomKey(r);
    const href = buildRescanHref(r);
    return {
      name: r.name,
      phone: r.phone || "",
      address: r.address || "",
      href,
      mapsUrl: href,
      lat: r.lat,
      lng: r.lng,
      googlePlaceId: r.googlePlaceId || "",
      sourceKey
    };
  });
  window.postMessage(
    {
      source: "timdiemban-web",
      type: "START_RESCAN",
      payload: {
        places,
        webUrl: window.location.origin,
        authToken: getAuthToken(),
        searchParams: currentSearch || {},
        mapsAutoReopen:
          window.TimDiemBanSearch?.isMapsAutoReopenChecked?.() ||
          localStorage.getItem("timdiemban_maps_auto_reopen") === "1"
      }
    },
    window.location.origin
  );
}

function setWinmapStatus(text, type = "") {
  if (text) setConnStatus(text, type === "error" ? "error" : type === "connected" ? "connected" : "");
}

function clearWinmapSiteForm() {
  winmapSite = { url: "", host: "", label: "", hasToken: false, configured: false };
  setWinmapStatus("", "");
  updateSendSiteButton();
}

async function loadWinmapSite() {
  if (!getAuthToken()) {
    clearWinmapSiteForm();
    return;
  }
  try {
    const data = await apiRequest("/api/points/site");
    winmapSite = {
      url: data.url || "",
      host: data.host || "",
      label: data.label || "",
      hasToken: Boolean(data.hasToken),
      configured: Boolean(data.configured)
    };
  } catch {
    /* im lặng — chưa đăng nhập hoặc server cũ */
  }
  updateSendSiteButton();
}

async function sendAllToWinmapSite() {
  const snapshot = getRowsToSend();
  if (!snapshot.length) return;
  if (!winmapSite.configured) {
    const msg = "Chưa cấu hình site + token. Vào trang Cấu hình site để thiết lập.";
    setWinmapStatus(msg, "error");
    showErrorBanner("Chưa cấu hình site nhận dữ liệu", msg);
    return;
  }
  const total = snapshot.length;
  const host = winmapSite.host || "site";
  const hostUi = formatSiteHostForUi(host, 28);
  const sentThisRun = snapshot.map((r) => getDomKey(r));
  if (els.sendSiteBtn) els.sendSiteBtn.disabled = true;

  const showPushProgress = ({ sent, failed, processed, total: t }) => {
    const msg = `Đang gửi ${processed}/${t} về ${hostUi}… (đã gửi OK: ${sent}${failed ? `, lỗi: ${failed}` : ""})`;
    setWinmapStatus(msg, "");
    setConnStatus(msg, "");
  };

  showPushProgress({ sent: 0, failed: 0, processed: 0, total });

  try {
    const data = await pushPointsToServerBatched(snapshot, {
      silent: true,
      onProgress: showPushProgress
    });
    const msg =
      `Đã gửi ${data.pushed ?? total}/${total} điểm về ${data.host || host}` +
      (data.failed ? ` (${data.failed} lỗi/trùng)` : "");
    setWinmapStatus(msg, "connected");
    setConnStatus(msg, "connected");
    sentThisRun.forEach((k) => sentKeys.add(k));
    els.resultsBody?.querySelectorAll(".row-check:checked").forEach((cb) => (cb.checked = false));
    if (els.checkAllRows) els.checkAllRows.checked = false;
    renderFullTable();
    if (data.mode === "log") {
      showErrorBanner("Gửi về site (chế độ log)", data.message);
    }
  } catch (err) {
    setWinmapStatus(err.message, "error");
    showErrorBanner(`Gửi về ${host} thất bại`, err.message);
  } finally {
    updateSendSiteButton();
  }
}

let _mapInvalidateTimer = null;
function scheduleMapInvalidate() {
  if (_mapInvalidateTimer) return;
  _mapInvalidateTimer = setTimeout(() => {
    _mapInvalidateTimer = null;
    window.TimDiemBanMap?.invalidateSize?.();
  }, 400);
}

function updateView() {
  const isRunning = currentSearch?.status === "running";
  const hasData = currentData.length > 0;

  if (currentSearch) renderSearchInfo(currentSearch);
  els.infoTotal.textContent = String(currentData.length);

  els.emptyState?.classList.add("hidden");
  els.loadingState.classList.toggle("hidden", !isRunning || hasData);
  els.tableSection?.classList.remove("hidden");

  syncExportButtons();

  if (isRunning) {
    setLiveProgress(liveProgressText || "Đang tìm kiếm...", 0);
  } else {
    hideLiveProgress();
  }

  updateRescanBtn();
  // Không invalidateSize mỗi lần updateView (gây nháy bản đồ khi đang sync)
  scheduleMapInvalidate();
}

let extensionMergedCount = 0;
let lastSyncIncoming = 0;
let lastSyncApplied = 0;
let lastSyncRequestAt = 0;
let syncRequestTimer = null;

function maybeRequestSyncIfBehind(mergedCount) {
  if (mergedCount == null || mergedCount <= 0) return;
  if (currentSearch?.status !== "running") return;
  const gap = mergedCount - currentData.length;
  updateUnifiedCountUI(mergedCount);
  if (gap <= 0) return;

  const fire = () => {
    lastSyncRequestAt = Date.now();
    syncRequestTimer = null;
    const g = extensionMergedCount - currentData.length;
    if (g <= 0) return;
    window.TimDiemBanDrainQueue?.();
    window.TimDiemBanSearch?.requestSearchSync?.(
      `Bù ${g} quán (ext ${extensionMergedCount}, bảng ${currentData.length})`
    );
  };

  // Lệch → bù ngay (tối đa 1 lần / 0.5–1s)
  const waitMs = gap >= 10 ? 400 : 700;
  const elapsed = Date.now() - lastSyncRequestAt;
  if (elapsed >= waitMs) {
    fire();
    return;
  }
  if (syncRequestTimer) clearTimeout(syncRequestTimer);
  syncRequestTimer = setTimeout(fire, waitMs - elapsed);
}

function updateUnifiedCountUI(mergedCount) {
  if (mergedCount != null && Number(mergedCount) >= 0) {
    // Luôn lấy max — tránh progress/item cũ làm tụt số extension
    extensionMergedCount = Math.max(extensionMergedCount, Number(mergedCount));
  }
  const tableCount = currentData.length;
  const ext = extensionMergedCount;
  const inSync = currentSearch?.status !== "running" || ext <= 0 || tableCount >= ext;
  const behind = currentSearch?.status === "running" && ext > tableCount;

  if (els.infoTotal) els.infoTotal.textContent = String(tableCount);
  if (els.resultsBadge && currentSearch?.status === "running" && ext > 0) {
    els.resultsBadge.textContent = behind
      ? `${tableCount} / ${ext} QUÁN — đang bù…`
      : `${tableCount} QUÁN (Maps = Web ✓)`;
    els.resultsBadge.classList.toggle("wm-results-badge-warn", behind);
  }

  if (currentSearch?.status === "running" && ext > 0) {
    if (behind) {
      setConnStatus(`Đang bù: bảng ${tableCount} / extension ${ext} quán`, "error");
    } else {
      setConnStatus(`Đồng bộ OK — ${tableCount} quán (Maps = Web)`, "connected");
    }
  }
}

/** Cập nhật UI đồng bộ — gọi từ executeScript khi tab ở nền (không await) */
function applyExtensionDataSync(type, payload = {}) {
  if (type === "start") {
    lastRowScrollAt = 0;
    hideErrorBanner();
    if (payload.user && !getAuthToken()) {
      currentUser = payload.user;
      updateAuthUI();
    }
    const sp = payload.searchParams || {};
    // Giữ kết quả cũ trong bảng + localStorage — chỉ cập nhật phiên/bản đồ
    beginFreshSearchUi(sp);
    liveProgressText = "Bắt đầu tìm kiếm...";
    if (els.infoGridCells && sp.gridCells) {
      els.infoGridCells.textContent = String(sp.gridCells);
    } else if (els.infoGridCells && sp.radius && typeof generateSearchGrid === "function") {
      const grid = generateSearchGrid(sp.lat, sp.lng, sp.radius);
      els.infoGridCells.textContent = String(grid.totalCells);
      sp.gridCells = grid.totalCells;
    }
    if (sp.lat && sp.lng && sp.radius) {
      // Chỉ fit nếu tâm đổi; sync trước đó đã không vẽ map nữa
      window.TimDiemBanMap?.setSearchArea(
        { lat: sp.lat, lng: sp.lng },
        sp.radius,
        { gridPoints: sp.gridPoints, cellSizeKm: sp.cellSizeKm, fit: true }
      );
      window.TimDiemBanMap?.countInOut?.(currentData);
      window.TimDiemBanMap?.refreshMarkers?.(currentData);
    }
    updateView();
    return;
  }

  if (type === "progress") {
    if (currentSearch) currentSearch.status = "running";
    setInfoStatus('<span class="status-badge status-running">Đang tìm</span>');
    if (payload.mergedCount != null) {
      extensionMergedCount = Math.max(extensionMergedCount, Number(payload.mergedCount) || 0);
    }
    if (payload.text) {
      const ext = extensionMergedCount;
      const n = currentData.length;
      const syncLabel =
        ext > 0 ? (n >= ext ? "Maps=Web ✓" : `bảng ${n}/${ext} — đang bù`) : "";
      liveProgressText = syncLabel ? `${payload.text} · ${syncLabel}` : payload.text;
      setLiveProgress(liveProgressText, payload.percent || 0);
      if (currentData.length === 0 && els.loadingState) {
        const loadMsg = els.loadingState.querySelector("span");
        if (loadMsg) loadMsg.textContent = liveProgressText;
      }
    }
    updateUnifiedCountUI(payload.mergedCount);
    maybeRequestSyncIfBehind(extensionMergedCount);
    updateView();
    return;
  }

  if (type === "item") {
    if (!payload.result) return;
    upsertTableRow(payload.result);
    els.tableSection.classList.remove("hidden");
    els.loadingState.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    syncExportButtons();
    scheduleChargeNewPhones();
    saveResultsToStorage(true);
    updateView();
    if (payload.mergedCount != null) {
      extensionMergedCount = Math.max(extensionMergedCount, Number(payload.mergedCount) || 0);
      window.dispatchEvent(
        new CustomEvent("timdiemban:merged-count", { detail: { count: extensionMergedCount } })
      );
    }
    updateUnifiedCountUI(extensionMergedCount);
    // Lệch ngay sau item → bù snapshot, không chờ debounce dài
    if (extensionMergedCount > currentData.length) {
      maybeRequestSyncIfBehind(extensionMergedCount);
    }
    return;
  }

  if (type === "items_batch") {
    const items = payload.items || [];
    if (!items.length) return;
    if (payload.searchParams && !currentSearch) {
      currentSearch = {
        ...payload.searchParams,
        status: "running",
        startedAt: new Date().toISOString()
      };
    }
    for (const result of items) {
      if (result) upsertTableRow(result);
    }
    els.tableSection.classList.remove("hidden");
    els.loadingState.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    syncExportButtons();
    scheduleChargeNewPhones();
    saveResultsToStorage(true);
    updateView();
    maybeRequestSyncIfBehind(payload.mergedCount);
    updateUnifiedCountUI(payload.mergedCount);
    return;
  }

  if (type === "sync") {
    const search = payload.searchParams || currentSearch;
    const syncSearchId = payload.searchParams?.searchId || search?.searchId;
    // Sync thuộc phiên khác → bỏ qua (tránh đổ điểm Hà Nội vào lượt Bắc Ninh)
    if (
      syncSearchId &&
      currentSearch?.searchId &&
      syncSearchId !== currentSearch.searchId
    ) {
      return;
    }
    ensureSearchSession(search);
    if (payload.searchParams) {
      if (!currentSearch || currentSearch.status !== "running") {
        if (!currentData.length || !syncSearchId || syncSearchId !== currentSearch?.searchId) {
          currentSearch = {
            ...payload.searchParams,
            status: "running",
            startedAt: currentSearch?.startedAt || new Date().toISOString()
          };
          awaitingNewSearchResults = true;
        } else {
          currentSearch = { ...currentSearch, ...payload.searchParams, status: "running" };
        }
      }
      const sp = payload.searchParams;
      // Sync không đụng bản đồ — chỉ cập nhật bảng (tránh nháy tâm/lưới)
    }
    awaitingNewSearchResults = false;
    const incoming = payload.results || [];
    const extCount = payload.mergedCount ?? incoming.length;
    // Merge vào bảng hiện có — không replace để giữ điểm các lượt tìm trước
    if (incoming.length > 0) {
      applyResults(incoming, search, false);
    }
    lastSyncIncoming = incoming.length;
    lastSyncApplied = currentData.length;
    extensionMergedCount = Math.max(extensionMergedCount, extCount, incoming.length);
    if (currentSearch) {
      currentSearch.status = "running";
      setInfoStatus('<span class="status-badge status-running">Đang tìm</span>');
    }
    els.tableSection.classList.remove("hidden");
    els.loadingState.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    els.exportBtn.disabled = currentData.length === 0;
    if (payload.text) {
      liveProgressText = payload.text;
      setLiveProgress(payload.text, payload.percent || 0);
    }
    setConnStatus(`Đồng bộ — ${currentData.length} quán`, "connected");
    scheduleChargeNewPhones();
    saveResultsToStorage(true);
    updateView();
    updateUnifiedCountUI(payload.mergedCount);
    if (payload.mergedCount != null) {
      window.dispatchEvent(
        new CustomEvent("timdiemban:merged-count", { detail: { count: payload.mergedCount } })
      );
    }
    maybeRequestSyncIfBehind(extCount);
    return;
  }

  if (type === "complete") {
    const search = payload.searchParams || currentSearch;
    awaitingNewSearchResults = false;
    currentSearch = {
      ...search,
      status: "completed",
      completedAt: payload.completedAt,
      startedAt: currentSearch?.startedAt || new Date().toISOString()
    };
    const incoming = payload.results || [];
    // Complete: merge danh sách cuối — giữ điểm các lượt tìm trước trong storage
    if (incoming.length > 0) {
      applyResults(incoming, search, false);
    }
    renderFullTable();
    window.TimDiemBanMap?.refreshMarkers(currentData);
    window.TimDiemBanMap?.countInOut(currentData);
    hideLiveProgress();
    setConnStatus(`Hoàn tất — ${currentData.length} kết quả`, "connected");
    saveResultsToStorage(true);
    tryChargePendingSearch().catch(() => {});
    window.dispatchEvent(new CustomEvent("timdiemban:search-finished"));
    updateView();
  }
}

function handleExtensionMessage(event) {
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== "timdiemban-ext") return;

  const { type, payload } = event.data;
  applyExtensionDataSync(type, payload);
  handleExtensionPayload(type, payload).catch((err) => {
    console.error("TimDiemBan UI error:", err);
    setConnStatus("Lỗi hiển thị — đang tiếp tục nhận dữ liệu", "error");
  });
}

async function handleExtensionPayload(type, payload) {
  setConnStatus("Đã kết nối extension — cập nhật real-time", "connected");

  if (type === "session") {
    const { token } = payload || {};
    if (token) setAuthToken(token);
    await refreshUserPoints();
    setConnStatus(
      currentUser
        ? `Đã đồng bộ — ${formatPoints(currentUser.points)} credit (từ server)`
        : "Đã kết nối extension",
      "connected"
    );
    return;
  }

  if (type === "search_status") {
    await reconcileStaleSearchState(payload || {});
    const ext = payload?.mergedCount ?? 0;
    if ((payload?.running || payload?.stalled) && ext > currentData.length) {
      window.TimDiemBanSearch?.requestSearchSync?.("Đồng bộ sau search_status");
    }
    return;
  }

  if (type === "start") {
    if (getAuthToken()) await refreshUserPoints();
    return;
  }

  if (type === "progress" || type === "item" || type === "items_batch" || type === "sync") {
    return;
  }

  if (type === "complete") {
    let pointsInfo = payload.pointsInfo || null;

    if (payload.chargeDeferred || !pointsInfo) {
      try {
        pointsInfo = await flushChargeNewPhones();
      } catch (err) {
        showErrorBanner("Lỗi cập nhật số dư", err.message);
      }
    }

    if (pointsInfo) {
      await loadCurrentUser();
      syncSessionToExtension();
      const { charged, phoneCount, remaining } = pointsInfo;
      const phoneTotal = phoneCount ?? charged ?? countUniquePhonesInRows(currentData);
      const partialNote = payload.partial ? " (dừng sớm)" : "";
      const msg =
        phoneTotal > charged
          ? `Sau loại trùng: ${phoneTotal} SĐT unique${partialNote} — dùng ${charged} điểm (hết credit khả dụng) — còn ${remaining} credit`
          : payload.partial
            ? `Dừng sớm — ${phoneTotal} SĐT unique, dùng ${charged} điểm (quy đổi credit) — còn ${remaining} credit`
            : `Hoàn tất — ${phoneTotal} SĐT unique (đã loại trùng), dùng ${charged} điểm (quy đổi credit) — còn ${remaining} credit`;
      showErrorBanner(payload.partial ? "Đã dừng tìm kiếm" : "Hoàn tất tìm kiếm", msg);
    } else if (payload.partial) {
      showErrorBanner("Đã dừng tìm kiếm", payload.partialReason || "Kết quả đã lưu.");
    }
    return;
  }

  if (type === "error") {
    awaitingNewSearchResults = false;
    if (currentSearch) currentSearch.status = "error";
    els.loadingState.classList.add("hidden");
    hideLiveProgress();
    showErrorBanner("Lỗi tìm kiếm", payload.error);
    setConnStatus(payload.error, "error");
    if (currentData.length) await tryChargePendingSearch();
    window.dispatchEvent(new CustomEvent("timdiemban:search-finished"));
    updateView();
  }

  if (type === "tab_closed") {
    awaitingNewSearchResults = false;
    if (currentSearch) currentSearch.status = "error";
    els.loadingState.classList.add("hidden");
    hideLiveProgress();
    showErrorBanner(
      "Tìm kiếm bị gián đoạn",
      payload.error || "Trang đã bị tắt. Vui lòng mở lại trang web và chạy lại tìm kiếm."
    );
    setConnStatus(payload.error, "error");
    if (currentData.length) await tryChargePendingSearch();
    window.dispatchEvent(new CustomEvent("timdiemban:search-finished"));
    updateView();
  }

  if (type === "log") {
    return;
  }

  if (type === "rescan_ack") {
    const { success, error, total } = payload || {};
    if (success === false) {
      resetRescanUiState();
      setConnStatus(error || "Không thể quét lại", "error");
      return;
    }
    clearRescanAckTimer();
    rescanRunning = true;
    if (total) rescanProgress.total = total;
    updateRescanBtn();
    return;
  }

  if (type === "rescan_status") {
    if (payload?.running) {
      rescanRunning = true;
      rescanProgress = {
        done: payload.done || 0,
        total: payload.total || 0
      };
      if (els.rescanBtn) els.rescanBtn.dataset.rescanBusy = "1";
    } else if (rescanRunning) {
      resetRescanUiState();
      return;
    }
    updateRescanBtn();
    return;
  }

  if (type === "rescan_start") {
    clearRescanAckTimer();
    rescanRunning = true;
    if (payload?.total) rescanProgress.total = payload.total;
    rescanProgress.done = 0;
    if (els.rescanBtn) els.rescanBtn.dataset.rescanBusy = "1";
    updateRescanBtn();
    return;
  }

  if (type === "rescan_progress") {
    rescanRunning = true;
    const { done, total, name, info } = payload || {};
    if (total) rescanProgress.total = total;
    if (done != null) rescanProgress.done = done;
    if (els.rescanBtn) els.rescanBtn.dataset.rescanBusy = "1";
    updateRescanBtn();
    const statusText = info || `Quét lại ${done || 0}/${total || 0}: ${escapeHtml(name || "…")}`;
    setConnStatus(statusText, info ? "info" : "");
    return;
  }

  if (type === "rescan_complete") {
    resetRescanUiState();
    const { done, total, error, partial } = payload || {};
    try {
      await flushChargeNewPhones();
    } catch (err) {
      console.warn("rescan charge:", err.message);
    }
    if (error) {
      const msg = partial
        ? `${error} (${done ?? 0}/${total ?? 0} điểm đã cập nhật)`
        : error;
      setConnStatus(`Quét lại: ${msg}`, partial ? "info" : "error");
      if (!partial) showErrorBanner("Quét lại lỗi", error);
    } else {
      setConnStatus(`Quét lại xong — ${done ?? total} điểm`, "connected");
      saveResultsToStorage();
    }
    return;
  }
}

function deleteSelectedRows() {
  if (!currentData.length) return;
  if (!confirm("Xóa toàn bộ kết quả trên bảng?")) return;
  clearAllData();
  setConnStatus("Đã xóa tất cả", "connected");
}

function clearAllData() {
  window.TimDiemBanSearch?.abandonExtensionSearch?.();
  localStorage.removeItem(STORAGE_RESULTS_KEY);
  clearChargedPhonesForUser();
  currentData = [];
  filteredData = [];
  rowKeyMap.clear();
  sentKeys.clear();
  jobsSyncResults.clear();
  currentSearch = null;
  currentPage = 1;
  awaitingNewSearchResults = false;
  resetRescanUiState();
  renderEmptyTableRow();
  els.jobsSyncSummary?.classList.add("hidden");
  if (els.searchFilter) els.searchFilter.value = "";
  hideErrorBanner();
  hideLiveProgress();
  window.TimDiemBanMap?.clearMarkers();
  window.TimDiemBanMap?.countInOut([]);
  updateView();
  setConnStatus("Đã xóa toàn bộ dữ liệu", "");
}

function exportExcel() {
  if (!currentData.length) return;

  const rows = currentData.map((r, i) => ({
    STT: i + 1,
    "Tên": r.name || "",
    "Đánh giá": r.rating || "",
    "Số review": r.reviews || "",
    "Loại hình": r.category || "",
    "Địa chỉ": r.address || "",
    "SĐT": r.phone || "",
    "Website": r.website || "",
    "Lat": r.lat ?? "",
    "Lng": r.lng ?? "",
    "Khoảng cách (km)": r.distanceKm ?? "",
    "Giờ mở cửa": r.hours || "",
    "Link Maps": r.mapsUrl || ""
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Ket qua");

  const keyword = els.infoKeyword.textContent || "timkiem";
  const filename = `timdiemban_${keyword.replace(/\s+/g, "_")}_${Date.now()}.xlsx`;
  XLSX.writeFile(wb, filename);
}

function drainExtensionQueue() {
  try {
    const raw = localStorage.getItem(EXT_QUEUE_KEY);
    if (!raw) return;
    localStorage.removeItem(EXT_QUEUE_KEY);
    const q = JSON.parse(raw);
    if (!Array.isArray(q)) return;
    for (const msg of q) {
      if (msg?.type) {
        applyExtensionDataSync(msg.type, msg.payload);
        handleExtensionPayload(msg.type, msg.payload).catch(() => {});
      }
    }
  } catch {}
}

window.__timDiemBanGetStats = () => ({
  count: currentData.length,
  searchId: currentSearch?.searchId || null,
  searchStatus: currentSearch?.status || null,
  lastSyncIncoming,
  lastSyncApplied,
  awaitingNew: awaitingNewSearchResults
});
window.__timDiemBanIngestSync = applyExtensionDataSync;
window.__timDiemBanHandlePayload = (type, payload) => {
  handleExtensionPayload(type, payload).catch((err) => {
    console.error("TimDiemBan payload error:", err);
  });
};
window.__timDiemBanIngest = (type, payload) => {
  applyExtensionDataSync(type, payload);
};
window.TimDiemBanDrainQueue = drainExtensionQueue;
drainExtensionQueue();

window.addEventListener("message", handleExtensionMessage);
els.exportBtn?.addEventListener("click", exportExcel);
els.exportBtnFooter?.addEventListener("click", exportExcel);
els.clearBtn?.addEventListener("click", deleteSelectedRows);
els.resetBtn?.addEventListener("click", () => {
  if (!confirm("Xóa toàn bộ dữ liệu tìm kiếm hiện tại? Dữ liệu đã lưu cũng sẽ bị xóa.")) return;
  clearAllData();
  setConnStatus("Đã làm mới — sẵn sàng tìm mới", "");
});
els.rescanBtn?.addEventListener("click", rescanMissingRows);
els.sendSiteBtn?.addEventListener("click", sendAllToWinmapSite);
els.syncJobsBtn?.addEventListener("click", syncSelectedRowsToJobs);

els.resultsBody?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  const key = btn.dataset.key;
  if (!key) return;
  if (action === "delete") {
    deleteRowByKey(key);
    setConnStatus("Đã xóa 1 dòng", "connected");
  } else if (action === "view") {
    viewRowOnMaps(key);
  }
});
els.searchFilter?.addEventListener("input", applyFilter);

els.pagePrevBtn?.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  renderFullTable();
});

els.pageNextBtn?.addEventListener("click", () => {
  const visible = buildFilteredData().length;
  if (currentPage >= getTotalPages(visible)) return;
  currentPage += 1;
  renderFullTable();
});

els.checkAllRows?.addEventListener("change", (e) => {
  const checked = e.target.checked;
  els.resultsBody.querySelectorAll(".row-check").forEach((cb) => {
    cb.checked = checked;
  });
  updateSendSiteButton();
  updateSyncJobsButton();
  updateRescanBtn();
});

els.resultsBody?.addEventListener("change", (e) => {
  if (e.target.classList?.contains("row-check")) {
    updateSendSiteButton();
    updateSyncJobsButton();
    updateRescanBtn();
  }
});

function handleAuthClick() {
  if (currentUser) {
    apiRequest("/api/logout", { method: "POST" }).catch(() => {});
    setAuthToken("");
    currentUser = null;
    clearSessionInExtension();
    clearWinmapSiteForm();
    updateAuthUI();
    setConnStatus("Đã đăng xuất", "");
    window.location.replace("/login");
  } else {
    window.location.href = "/login";
  }
}

els.loginBtn?.addEventListener("click", handleAuthClick);
els.sidebarLogoutBtn?.addEventListener("click", handleAuthClick);
els.headerLogoutBtn?.addEventListener("click", () => {
  toggleHeaderUserMenu(false);
  handleAuthClick();
});

els.headerUserAvatar?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleHeaderUserMenu();
});

els.openProfileBtn?.addEventListener("click", () => {
  toggleHeaderUserMenu(false);
  openProfileModal();
});

els.sidebarNewSearchBtn?.addEventListener("click", () => {
  if (!confirm("Làm mới — xóa toàn bộ dữ liệu tìm kiếm hiện tại?")) return;
  clearAllData();
  document.getElementById("searchKeyword")?.focus();
  setConnStatus("Đã làm mới — sẵn sàng tìm mới", "");
});

document.getElementById("mapZoomIn")?.addEventListener("click", () => window.TimDiemBanMap?.zoomIn?.());
document.getElementById("mapZoomOut")?.addEventListener("click", () => window.TimDiemBanMap?.zoomOut?.());
document.getElementById("mapLocate")?.addEventListener("click", () => window.TimDiemBanMap?.locateUser?.());

els.authModal.addEventListener("click", (e) => {
  if (e.target === els.authModal) hideAuthModal();
});

els.profileModal?.addEventListener("click", (e) => {
  if (e.target === els.profileModal) els.profileModal.classList.add("hidden");
});

els.profileForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (els.profileMsg) els.profileMsg.classList.add("hidden");
  const currentPassword = els.profileCurrentPassword?.value || "";
  const newPassword = els.profileNewPassword?.value || "";
  const confirmPassword = els.profileConfirmPassword?.value || "";
  if ((currentPassword || newPassword || confirmPassword) && newPassword !== confirmPassword) {
    if (els.profileMsg) {
      els.profileMsg.textContent = "Mật khẩu mới nhập lại không khớp";
      els.profileMsg.classList.remove("hidden");
    }
    return;
  }
  try {
    const data = await apiRequest("/api/auth/profile", {
      method: "POST",
      body: JSON.stringify({
        fullName: els.profileFullName?.value?.trim() || "",
        phone: els.profilePhone?.value?.trim() || "",
        currentPassword,
        newPassword
      })
    });
    currentUser = data.user || currentUser;
    updateAuthUI();
    syncSessionToExtension();
    if (els.profileMsg) {
      els.profileMsg.textContent = data.message || "Đã cập nhật hồ sơ";
      els.profileMsg.classList.remove("hidden");
    }
    setTimeout(() => {
      if (els.profileModal) els.profileModal.classList.add("hidden");
    }, 500);
  } catch (err) {
    if (els.profileMsg) {
      els.profileMsg.textContent = err.message || "Cập nhật thất bại";
      els.profileMsg.classList.remove("hidden");
    }
  }
});

document.addEventListener("click", (e) => {
  if (!els.headerUserMenu || !els.headerUserBlock) return;
  if (!els.headerUserBlock.contains(e.target)) {
    toggleHeaderUserMenu(false);
  }
});

els.authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.authError.classList.add("hidden");
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  try {
    const data = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    setAuthToken(data.token);
    currentUser = data.user;
    updateAuthUI();
    syncSessionToExtension();
    await loadPendingPackageOrders();
    await loadWinmapSite();
    hideAuthModal();
    window.postMessage(
      { source: "timdiemban-web", type: "LOGIN", payload: { token: data.token, user: data.user } },
      window.location.origin
    );
    setConnStatus("Đăng nhập thành công", "connected");
  } catch (err) {
    els.authError.textContent = err.message;
    els.authError.classList.remove("hidden");
  }
});

window.addEventListener("timdiemban:search-starting", (e) => {
  const sp = e.detail || {};
  beginFreshSearchUi(sp);
  // Bản đồ: để handleSubmit / "start" vẽ 1 lần — tránh vẽ 2–3 lần liền gây nháy
});

window.addEventListener("timdiemban:search-status", (e) => {
  reconcileStaleSearchState(e.detail || {}).catch((err) => {
    console.warn("reconcileStaleSearchState:", err.message);
  });
});

window.addEventListener("timdiemban:bridge-ready", (e) => {
  const p = e.detail || {};
  window.TimDiemBanExtVersion?.onBridgeReady(p);
  if (p.ok) {
    const up = window.TimDiemBanExtVersion?.isUpToDate?.();
    const ver = p.version ? ` v${p.version}` : "";
    if (up === true) {
      setConnStatus(`Extension${ver} — đã cập nhật mới nhất`, "connected");
    } else if (up === false) {
      setConnStatus(`Extension${ver} — cần reload (xem thông báo phía trên)`, "error");
    } else {
      setConnStatus(`Extension đã kết nối${ver}`, "connected");
    }
    queryRescanStatus();
  } else if (p.dead) {
    window.TimDiemBanExtVersion?.onBridgeMissing();
    setConnStatus("Extension vừa reload — trang sẽ tự làm mới…", "error");
  } else {
    window.TimDiemBanExtVersion?.onBridgeMissing();
    setConnStatus("Chưa thấy extension — Reload Findmap tại chrome://extensions rồi F5", "error");
  }
});

loadCurrentUser().then(async () => {
  await loadPendingPackageOrders();
  await loadWinmapSite();
  await loadJobsIntegrationStatus();

  // Khôi phục dữ liệu đã lưu từ phiên trước
  if (loadResultsFromStorage()) {
    renderFullTable();
    if (currentSearch) {
      renderSearchInfo(currentSearch);
      const sp = currentSearch;
      if (sp.lat && sp.lng && sp.radius) {
        window.TimDiemBanMap?.setSearchArea({ lat: sp.lat, lng: sp.lng }, sp.radius, { fit: true });
      }
    }
    window.TimDiemBanMap?.refreshMarkers(currentData);
    window.TimDiemBanMap?.countInOut(currentData);
    els.infoTotal.textContent = String(currentData.length);
    syncExportButtons();
    setConnStatus(
      `Đã khôi phục ${currentData.length} kết quả từ phiên trước · Nhấn "Làm mới" để xóa`,
      "connected"
    );
    // Extension sẽ gửi search_status qua bridge — reconcile + trừ điểm nếu còn pending
    migrateLegacyChargedSearchIds();
    await refreshUserPoints();
    if (currentSearch?.status !== "running") {
      await tryChargePendingSearch();
      await refreshUserPoints();
    }
  } else {
    setConnStatus(
      currentUser
        ? `Đã đăng nhập — ${formatPoints(currentUser.points)} credit · Extension chạy ngầm`
        : "Đăng nhập góc phải, rồi dùng form Tìm kiếm mới",
      currentUser ? "connected" : ""
    );
  }

  drainExtensionQueue();
  updateView();
  setTimeout(() => window.TimDiemBanMap?.invalidateSize?.(), 500);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && getAuthToken()) {
    refreshUserPoints().catch(() => {});
  }
});

loadAvailablePackages();

window.addEventListener("timdiemban:need-login", () => {
  showAuthModal();
});

window.addEventListener("timdiemban:map-preview", (e) => {
  const { lat, lng, radius, fit } = e.detail || {};
  const safeRadius =
    typeof clampSearchRadiusKm === "function" ? clampSearchRadiusKm(radius) : radius;
  if (lat != null && lng != null && safeRadius) {
    if (typeof generateSearchGrid === "function" && els.infoGridCells) {
      const grid = generateSearchGrid(lat, lng, safeRadius);
      els.infoGridCells.textContent = String(grid.totalCells);
    }
    window.TimDiemBanMap?.setSearchArea({ lat, lng }, safeRadius, { fit: fit !== false });
  }
});
