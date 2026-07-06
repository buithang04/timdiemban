const form = document.getElementById("searchForm");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const startBtn = document.getElementById("startBtn");
const latInput = document.getElementById("lat");
const lngInput = document.getElementById("lng");
const centerPreview = document.getElementById("centerPreview");
const loginPanel = document.getElementById("loginPanel");
const userBar = document.getElementById("userBar");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");

const AUTH_TOKEN_KEY = "authToken";
const AUTH_USER_KEY = "authUser";

let centerSource = "manual";
let currentUser = null;
let authToken = "";

function showStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove("hidden");
}

function updateProgress(percent, text) {
  progressEl.classList.remove("hidden");
  progressBar.style.setProperty("--progress", `${percent}%`);
  progressText.textContent = text || `${percent}%`;
  const logEl = document.getElementById("scrapeLog");
  if (logEl) logEl.classList.remove("hidden");
}

function clearScrapeLog() {
  const logEl = document.getElementById("scrapeLog");
  if (logEl) {
    logEl.textContent = "";
    logEl.classList.add("hidden");
  }
}

function getWebUrl() {
  const fromInput = document.getElementById("webUrl")?.value?.trim().replace(/\/$/, "");
  const fromConfig = String(globalThis.TIMDIEMBAN_CONFIG?.APP_ORIGIN || "").replace(/\/$/, "");
  return fromInput || fromConfig || "http://localhost:3000";
}

async function loadSession() {
  const data = await chrome.storage.local.get([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
  authToken = data[AUTH_TOKEN_KEY] || "";
  currentUser = data[AUTH_USER_KEY] || null;
  if (authToken && currentUser) {
    try {
      const fresh = await apiFetch(getWebUrl(), "/api/auth/me", authToken);
      currentUser = fresh.user;
      await saveSession(authToken, currentUser);
    } catch {
      await clearSession();
    }
  }
  updateAuthUI();
}

async function saveSession(token, user) {
  authToken = token;
  currentUser = user;
  await chrome.storage.local.set({
    [AUTH_TOKEN_KEY]: token,
    [AUTH_USER_KEY]: user
  });
  await syncSessionToWeb(getWebUrl(), token, user);
}

async function clearSession() {
  authToken = "";
  currentUser = null;
  await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
}

async function apiFetch(webUrl, path, token, options = {}) {
  const res = await fetch(`${webUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

async function syncSessionToWeb(webUrl, token, user) {
  const tabs = await chrome.tabs.query({ url: `${webUrl}/*` });
  if (!tabs.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (t, u) => {
        localStorage.setItem("timdiemban_token", t);
        window.postMessage(
          { source: "timdiemban-ext", type: "session", payload: { token: t, user: u } },
          window.location.origin
        );
      },
      args: [token, user]
    });
  } catch {}
}

function updateAuthUI() {
  if (currentUser && authToken) {
    loginPanel.classList.add("hidden");
    userBar.classList.remove("hidden");
    form.classList.remove("hidden");
    document.getElementById("userEmail").textContent = currentUser.email;
    document.getElementById("userPoints").textContent = `${currentUser.points} điểm`;
    startBtn.disabled = false;
  } else {
    loginPanel.classList.remove("hidden");
    userBar.classList.add("hidden");
    form.classList.add("hidden");
    startBtn.disabled = true;
  }
}

loginBtn.addEventListener("click", async () => {
  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  const webUrl = getWebUrl();
  if (!email || !password) {
    showStatus("Nhập email và mật khẩu.", "error");
    return;
  }
  loginBtn.disabled = true;
  try {
    const res = await fetch(`${webUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Đăng nhập thất bại");
    await saveSession(data.token, data.user);
    updateAuthUI();
    loginPassword.value = "";
    showStatus(`Đăng nhập OK — ${data.user.points} điểm`, "success");
  } catch (err) {
    showStatus(err.message, "error");
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  await clearSession();
  updateAuthUI();
  showStatus("Đã đăng xuất.", "info");
});

document.getElementById("forgotLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${getWebUrl()}/quen-mat-khau` });
});

function parseCoordInput(value) {
  if (value == null || String(value).trim() === "") return NaN;
  const n = parseFloat(String(value).trim().replace(",", "."));
  return n;
}

function setCenterFields(lat, lng, source, extra = "") {
  const c = normalizeCenterCoords(lat, lng);
  if (!c) return false;
  latInput.value = c.lat;
  lngInput.value = c.lng;
  centerSource = source;
  centerPreview.textContent = `✓ Tâm: ${c.lat}, ${c.lng}${extra ? ` (${extra})` : ""}`;
  centerPreview.classList.remove("hidden");
  return true;
}

function readCenterFromForm() {
  const lat = parseCoordInput(latInput.value);
  const lng = parseCoordInput(lngInput.value);
  if (isNaN(lat) || isNaN(lng)) return null;
  return normalizeCenterCoords(lat, lng);
}

async function getHighAccuracyLocation() {
  return new Promise((resolve, reject) => {
    let best = null;
    let watchId = null;

    const finish = (result, err) => {
      clearTimeout(timer);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (result) resolve(result);
      else reject(err || new Error("Không lấy được GPS"));
    };

    const timer = setTimeout(() => {
      finish(best, new Error("GPS quá lâu — thử 'Lấy từ tab Maps' hoặc nhập tay"));
    }, 18000);

    if (!navigator.geolocation) {
      finish(null, new Error("Trình duyệt không hỗ trợ GPS"));
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const sample = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        if (!best || sample.accuracy < best.accuracy) best = sample;
        if (sample.accuracy <= 25) finish(best);
      },
      (err) => {
        if (best) finish(best);
        else finish(null, err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 18000 }
    );
  });
}

async function getCenterFromMapsTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("google.com/maps")) {
    throw new Error(
      "Mở Google Maps, kéo bản đồ đến đúng điểm trung tâm (chuột phải → tọa độ), rồi bấm lại."
    );
  }
  const center = extractMapCenterFromUrl(tab.url);
  if (!center) {
    throw new Error("Không đọc được @lat,lng từ URL Maps. Hãy zoom/di chuyển bản đồ rồi thử lại.");
  }
  return center;
}

document.getElementById("btnFromMaps").addEventListener("click", async () => {
  try {
    showStatus("Đang đọc tọa độ từ tab Google Maps...", "info");
    const c = await getCenterFromMapsTab();
    setCenterFields(c.lat, c.lng, "maps_tab", "từ URL Maps");
    showStatus("Đã lấy tâm từ tab Maps. Kiểm tra lat/lng trước khi tìm.", "success");
  } catch (err) {
    showStatus(err.message, "error");
  }
});

document.getElementById("btnFromGps").addEventListener("click", async () => {
  try {
    showStatus("Đang lấy GPS độ chính xác cao (có thể mất 5–15 giây)...", "info");
    const loc = await getHighAccuracyLocation();
    const extra = loc.accuracy ? `±${Math.round(loc.accuracy)}m` : "";
    setCenterFields(loc.lat, loc.lng, "gps", extra);
    showStatus(`GPS: ${extra || "đã lấy"}. Nên kiểm tra trên Maps nếu cần chính xác tuyệt đối.`, "success");
  } catch (err) {
    showStatus(
      err.message || "Không lấy được GPS. Dùng 'Lấy từ tab Maps' hoặc nhập lat/lng tay.",
      "error"
    );
  }
});

latInput.addEventListener("input", () => {
  const c = readCenterFromForm();
  if (c) {
    centerSource = "manual";
    centerPreview.textContent = `✓ Tâm: ${c.lat}, ${c.lng} (nhập tay)`;
    centerPreview.classList.remove("hidden");
  } else {
    centerPreview.classList.add("hidden");
  }
});

lngInput.addEventListener("input", () => {
  latInput.dispatchEvent(new Event("input"));
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!authToken || !currentUser) {
    showStatus("Vui lòng đăng nhập trước.", "error");
    return;
  }

  startBtn.disabled = true;
  clearScrapeLog();
  showStatus("Đang chuẩn bị tìm kiếm...", "info");
  updateProgress(0, "0%");

  const keyword = document.getElementById("keyword").value.trim();
  const radius = parseFloat(document.getElementById("radius").value);
  const webUrl = getWebUrl();

  if (!keyword) {
    showStatus("Vui lòng nhập từ khóa tìm kiếm.", "error");
    startBtn.disabled = false;
    return;
  }

  let center = readCenterFromForm();
  if (!center) {
    try {
      showStatus("Chưa có tọa độ — đang lấy GPS chính xác...", "info");
      const loc = await getHighAccuracyLocation();
      center = normalizeCenterCoords(loc.lat, loc.lng);
      centerSource = "gps";
      if (center) {
        setCenterFields(center.lat, center.lng, "gps", loc.accuracy ? `±${Math.round(loc.accuracy)}m` : "");
      }
    } catch {
      showStatus(
        "Bắt buộc có tọa độ trung tâm chính xác. Nhập lat/lng, bấm 'Lấy từ tab Maps', hoặc 'GPS chính xác'.",
        "error"
      );
      startBtn.disabled = false;
      return;
    }
  }

  if (!center) {
    showStatus("Tọa độ trung tâm không hợp lệ (lat: -90..90, lng: -180..180).", "error");
    startBtn.disabled = false;
    return;
  }

  const searchParams = {
    keyword,
    radius,
    lat: center.lat,
    lng: center.lng,
    centerSource,
    webUrl,
    authToken,
    searchId: `search_${Date.now()}`
  };

  try {
    await chrome.runtime.sendMessage({ action: "START_SEARCH", data: searchParams });
    showStatus(`Tâm: ${center.lat}, ${center.lng} — đang tìm...`, "info");
  } catch (err) {
    showStatus(`Lỗi: ${err.message}`, "error");
    startBtn.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "SEARCH_PROGRESS") {
    updateProgress(message.percent, message.text);
    showStatus(message.text, "info");
  }
  if (message.action === "SEARCH_LOG") {
    const logEl = document.getElementById("scrapeLog");
    if (logEl && message.line) {
      logEl.textContent = (logEl.textContent ? logEl.textContent + "\n" : "") + message.line;
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
  if (message.action === "SEARCH_COMPLETE") {
    updateProgress(100, "Hoàn tất");
    showStatus(`Hoàn tất! Đã tìm ${message.count} điểm.`, "success");
    startBtn.disabled = false;
    if (message.user) {
      currentUser = message.user;
      saveSession(authToken, currentUser).then(updateAuthUI);
    } else {
      loadSession();
    }
  }
  if (message.action === "SEARCH_ERROR") {
    showStatus(`Lỗi: ${message.error}`, "error");
    startBtn.disabled = false;
  }
});

chrome.storage.local.get(["lastSearch"], (result) => {
  if (result.lastSearch) {
    const s = result.lastSearch;
    document.getElementById("keyword").value = s.keyword || "";
    document.getElementById("radius").value = s.radius || 5;
    if (s.webUrl) document.getElementById("webUrl").value = s.webUrl;
    if (s.lat != null && s.lng != null) {
      setCenterFields(s.lat, s.lng, s.centerSource || "saved", "đã lưu");
    }
  }
});

loadSession();
