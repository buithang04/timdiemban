const { resolveImportUrl } = require("./points-push");
const { DEFAULT_PUSH_CONFIG, parsePushConfig } = require("./push-config");

const PROVIDER = "winmap_tenant";
const SOURCE_HEADER = "findmap";

class WinmapIntegrationError extends Error {
  constructor(message, status = 500, code = "winmap_integration_error", details = null) {
    super(message);
    this.name = "WinmapIntegrationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function limitedText(value, maxLength) {
  if (value == null || typeof value === "object") return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeConnectionRequest(raw) {
  const token = limitedText(raw, 64).toUpperCase();
  if (!/^[A-F0-9]{4}(?:-?[A-F0-9]{4}){3}(?:-?[A-F0-9]{4}){0,4}$/.test(token)) {
    throw new WinmapIntegrationError("Yêu cầu kết nối Winmap không hợp lệ.", 422, "invalid_connection_request");
  }
  const compact = token.replace(/-/g, "");
  if (![16, 32].includes(compact.length)) {
    throw new WinmapIntegrationError("Yêu cầu kết nối Winmap không hợp lệ.", 422, "invalid_connection_request");
  }
  return token;
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(host);
}

function allowedHostSuffixes(env = process.env) {
  return String(env.WINMAP_TENANT_ALLOWED_HOST_SUFFIXES || "winmap.vn,.winmap.vn")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedWinmapHost(hostname, env = process.env) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (env.NODE_ENV !== "production" && isLocalHost(host)) return true;

  return allowedHostSuffixes(env).some((suffix) => {
    if (suffix.startsWith(".")) return host.endsWith(suffix);
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

function requireSecureUrl(url, env = process.env) {
  if (url.protocol === "https:") return;
  if (env.NODE_ENV !== "production" && url.protocol === "http:" && isLocalHost(url.hostname)) return;
  throw new WinmapIntegrationError("Endpoint kết nối Winmap phải dùng HTTPS ở production.", 500, "insecure_winmap_url");
}

function resolveWinmapTenantUrl(input, env = process.env) {
  let raw = limitedText(input, 500);
  if (!raw) {
    throw new WinmapIntegrationError("Thiếu tenant Winmap.", 422, "missing_winmap_tenant");
  }
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WinmapIntegrationError("Tenant Winmap không hợp lệ.", 422, "invalid_winmap_tenant");
  }
  requireSecureUrl(url, env);
  if (url.username || url.password || url.search || url.hash) {
    throw new WinmapIntegrationError("Tenant Winmap không được chứa credentials, query hoặc fragment.", 422, "invalid_winmap_tenant");
  }
  if (!isAllowedWinmapHost(url.hostname, env)) {
    throw new WinmapIntegrationError("Chỉ nhận tenant Winmap đã cho phép.", 422, "invalid_winmap_tenant");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return path && path !== "/" ? `${url.origin}${path}` : url.origin;
}

function resolveWinmapEndpointUrl(input, env = process.env, expectedOrigin = "") {
  let raw = limitedText(input, 1000);
  if (!raw) {
    throw new WinmapIntegrationError("Thiếu endpoint kết nối Winmap.", 422, "missing_winmap_endpoint");
  }
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WinmapIntegrationError("Endpoint kết nối Winmap không hợp lệ.", 422, "invalid_winmap_endpoint");
  }
  requireSecureUrl(url, env);
  if (url.username || url.password || url.hash) {
    throw new WinmapIntegrationError("Endpoint kết nối Winmap không được chứa credentials hoặc fragment.", 422, "invalid_winmap_endpoint");
  }
  if (!isAllowedWinmapHost(url.hostname, env)) {
    throw new WinmapIntegrationError("Chỉ nhận tenant Winmap đã cho phép.", 422, "invalid_winmap_tenant");
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new WinmapIntegrationError("Endpoint kết nối phải cùng tenant Winmap.", 422, "winmap_origin_mismatch");
  }
  return url.toString();
}

function normalizePendingRequest(raw, env = process.env) {
  const source = raw && typeof raw === "object" ? raw : {};
  const requestToken = normalizeConnectionRequest(
    source.request_token || source.requestToken || source.request || source.pairing_code
  );
  const tenantUrl = resolveWinmapTenantUrl(source.tenant_url || source.tenantUrl, env);
  const origin = new URL(tenantUrl).origin;
  const previewUrl = resolveWinmapEndpointUrl(
    source.preview_url || source.previewUrl || `${tenantUrl}/api/findmap/winmap/request/preview`,
    env,
    origin
  );
  const exchangeUrl = resolveWinmapEndpointUrl(
    source.exchange_url || source.exchangeUrl || `${tenantUrl}/api/findmap/winmap/exchange`,
    env,
    origin
  );
  return { requestToken, tenantUrl, previewUrl, exchangeUrl };
}

function mapRemoteError(status, data) {
  const message = limitedText(data?.message || data?.error, 500);
  if (status === 401 || status === 403) {
    return new WinmapIntegrationError(
      message || "Liên kết Winmap không hợp lệ hoặc đã bị thu hồi.",
      status,
      "winmap_token_invalid",
      data
    );
  }
  if (status === 409 || status === 410 || status === 422 || status === 429) {
    return new WinmapIntegrationError(message || "Winmap từ chối yêu cầu kết nối.", status, "winmap_request_rejected", data);
  }
  return new WinmapIntegrationError(
    message || "Winmap tenant đang tạm thời không phản hồi.",
    502,
    "winmap_upstream_error",
    data
  );
}

function resolveTimeoutMs(env = process.env) {
  const value = Number(env.WINMAP_TENANT_TIMEOUT_MS || 15000);
  return Math.max(1000, Math.min(30000, Number.isFinite(value) ? Math.floor(value) : 15000));
}

function createWinmapIntegrationService({
  db,
  fetchImpl = global.fetch,
  env = process.env,
  now = () => new Date()
}) {
  if (!db) throw new Error("Winmap integration cần db adapter");
  if (typeof fetchImpl !== "function") throw new Error("Node.js runtime cần hỗ trợ fetch");

  const timeoutMs = resolveTimeoutMs(env);

  async function requestAbsolute(url, { method = "GET", token = "", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers["X-Integration-Source"] = SOURCE_HEADER;
      }
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error"
      });
      const contentType = response.headers?.get?.("content-type") || "";
      const data = contentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : {};
      if (response.ok) return data;
      throw mapRemoteError(response.status, data);
    } catch (error) {
      if (error instanceof WinmapIntegrationError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new WinmapIntegrationError(
        timedOut ? "Kết nối Winmap quá thời gian chờ." : "Không kết nối được Winmap tenant.",
        502,
        timedOut ? "winmap_timeout" : "winmap_network_error"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function key(name, userId) {
    return `${name}:${String(userId || "").trim()}`;
  }

  async function readLink(userId, { includeToken = false } = {}) {
    const uid = String(userId || "").trim();
    if (!uid) return null;
    const url = limitedText(await db.getSetting(key("winmap_site_url", uid), ""), 500);
    const label = limitedText(await db.getSetting(key("winmap_site_label", uid), ""), 255);
    const connectedAt = limitedText(await db.getSetting(key("winmap_site_connected_at", uid), ""), 100);
    const statusUrl = limitedText(await db.getSetting(key("winmap_site_status_url", uid), ""), 1000);
    const revokeUrl = limitedText(await db.getSetting(key("winmap_site_revoke_url", uid), ""), 1000);
    const pushConfig = parsePushConfig(await db.getSetting(key("winmap_site_push_config", uid), ""));
    const token = includeToken
      ? limitedText(await db.getSetting(key("winmap_site_token", uid), ""), 2048)
      : "";
    const urlMode = pushConfig?.urlMode || "winmap";
    const importUrl = url ? resolveImportUrl(url, urlMode) : "";
    let host = "";
    try {
      host = importUrl ? new URL(importUrl).host : "";
    } catch {}
    return {
      userId: uid,
      url,
      label,
      connectedAt,
      statusUrl,
      revokeUrl,
      pushConfig,
      token,
      hasToken: includeToken ? Boolean(token) : Boolean(await db.getSetting(key("winmap_site_token", uid), "")),
      importUrl,
      host,
      status: url && (includeToken ? token : await db.getSetting(key("winmap_site_token", uid), "")) ? "active" : "empty"
    };
  }

  async function clearLink(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return;
    await db.setSetting(key("winmap_site_url", uid), "");
    await db.setSetting(key("winmap_site_label", uid), "");
    await db.setSetting(key("winmap_site_token", uid), "");
    await db.setSetting(key("winmap_site_push_config", uid), "");
    await db.setSetting(key("winmap_site_connected_at", uid), "");
    await db.setSetting(key("winmap_site_status_url", uid), "");
    await db.setSetting(key("winmap_site_revoke_url", uid), "");
  }

  async function saveLink(userId, data) {
    const uid = String(userId || "").trim();
    if (!uid) {
      throw new WinmapIntegrationError("Thiếu tài khoản Findmap.", 422, "invalid_findmap_user");
    }
    await db.setSetting(key("winmap_site_url", uid), data.tenantUrl);
    await db.setSetting(key("winmap_site_label", uid), data.label || "");
    await db.setSetting(key("winmap_site_token", uid), data.token);
    await db.setSetting(key("winmap_site_push_config", uid), JSON.stringify(data.pushConfig || DEFAULT_PUSH_CONFIG));
    await db.setSetting(key("winmap_site_connected_at", uid), data.connectedAt || now().toISOString());
    await db.setSetting(key("winmap_site_status_url", uid), data.statusUrl || "");
    await db.setSetting(key("winmap_site_revoke_url", uid), data.revokeUrl || "");
    return readLink(uid);
  }

  function publicStatus(link, extra = {}) {
    if (!link || link.status !== "active") {
      return { linked: false, provider: PROVIDER, ...extra };
    }
    return {
      linked: true,
      provider: PROVIDER,
      tenant_url: link.url,
      tenant_label: link.label || link.host,
      host: link.host,
      import_url: link.importUrl,
      linked_at: link.connectedAt || null,
      has_token: true,
      ...extra
    };
  }

  async function status(userId, { verify = false } = {}) {
    const link = await readLink(userId, { includeToken: verify });
    if (!link || link.status !== "active") return publicStatus(null);
    if (!verify) return publicStatus(link);
    if (!link.token) {
      await clearLink(userId);
      return publicStatus(null, { verified: false, error: "Không giải mã được token Winmap. Kiểm tra SETTINGS_ENCRYPTION_KEY." });
    }

    const tenantUrl = resolveWinmapTenantUrl(link.url, env);
    const statusUrl = resolveWinmapEndpointUrl(
      link.statusUrl || `${tenantUrl}/api/findmap/winmap/token/status`,
      env,
      new URL(tenantUrl).origin
    );
    try {
      const remote = await requestAbsolute(statusUrl, { token: link.token });
      return publicStatus(link, { verified: true, remote });
    } catch (error) {
      if (error.code === "winmap_token_invalid") {
        await clearLink(userId);
        return publicStatus(null, { verified: false, error: error.message });
      }
      throw error;
    }
  }

  async function previewRequest(rawRequest) {
    const pending = normalizePendingRequest(rawRequest, env);
    const response = await requestAbsolute(pending.previewUrl, {
      method: "POST",
      body: { request_token: pending.requestToken }
    });
    const request = response?.request || {};
    const tenantUrl = resolveWinmapTenantUrl(request.tenant_url || pending.tenantUrl, env);
    if (new URL(tenantUrl).origin !== new URL(pending.tenantUrl).origin) {
      throw new WinmapIntegrationError("Winmap trả tenant không khớp yêu cầu kết nối.", 409, "winmap_origin_mismatch");
    }
    return {
      request: {
        tenant_url: tenantUrl,
        tenant_name: limitedText(request.tenant_name || request.tenant?.name || new URL(tenantUrl).host, 255),
        expires_at: limitedText(request.expires_at, 100)
      }
    };
  }

  async function connect(user, rawRequest) {
    if (typeof db.assertWinmapSiteEncryptionReady === "function") {
      db.assertWinmapSiteEncryptionReady();
    }
    const pending = normalizePendingRequest(rawRequest, env);
    const response = await requestAbsolute(pending.exchangeUrl, {
      method: "POST",
      body: {
        request_token: pending.requestToken,
        findmap_user_id: String(user?.id || ""),
        findmap_email: user?.email || null,
        display_name: user?.fullName || user?.email || null
      }
    });
    if (response?.success === 0 || response?.linked === false) {
      throw new WinmapIntegrationError(response?.message || "Winmap từ chối yêu cầu kết nối.", response?.status || 422, "winmap_request_rejected", response);
    }

    const tenant = response?.tenant || {};
    const tenantUrl = resolveWinmapTenantUrl(tenant.url || response?.tenant_url || pending.tenantUrl, env);
    const tenantOrigin = new URL(tenantUrl).origin;
    if (tenantOrigin !== new URL(pending.tenantUrl).origin) {
      throw new WinmapIntegrationError("Winmap trả tenant không khớp yêu cầu kết nối.", 409, "winmap_origin_mismatch");
    }
    const push = response?.push || {};
    const token = limitedText(push.token || response?.push_token, 2048);
    if (!token) {
      throw new WinmapIntegrationError("Winmap trả dữ liệu liên kết không đầy đủ.", 502, "invalid_winmap_response");
    }
    const pushUrl = resolveWinmapEndpointUrl(push.url || response?.push_url || `${tenantUrl}/api/points/import`, env, tenantOrigin);
    const statusUrl = resolveWinmapEndpointUrl(response?.status_url || `${tenantUrl}/api/findmap/winmap/token/status`, env, tenantOrigin);
    const revokeUrl = resolveWinmapEndpointUrl(response?.revoke_url || `${tenantUrl}/api/findmap/winmap/token`, env, tenantOrigin);
    const pushConfig = {
      ...DEFAULT_PUSH_CONFIG,
      method: "POST",
      sourceTag: "timdiemban",
      pointsKey: "points",
      urlMode: "winmap"
    };

    let link;
    try {
      link = await saveLink(user.id, {
        tenantUrl,
        label: limitedText(tenant.name || response?.tenant_name || new URL(tenantUrl).host, 255),
        token,
        pushUrl,
        statusUrl,
        revokeUrl,
        pushConfig,
        connectedAt: limitedText(response?.connected_at, 100) || now().toISOString()
      });
    } catch (error) {
      await requestAbsolute(revokeUrl, { method: "DELETE", token }).catch(() => {});
      throw error;
    }

    return publicStatus(link, { message: "Đã kết nối Winmap tenant." });
  }

  async function declineRequest(rawRequest) {
    normalizePendingRequest(rawRequest, env);
    return { message: "Đã bỏ qua yêu cầu kết nối Winmap." };
  }

  async function disconnect(userId) {
    const link = await readLink(userId, { includeToken: true });
    if (!link || link.status !== "active") {
      return { disconnected: false, message: "Tài khoản chưa kết nối Winmap tenant." };
    }
    const tenantUrl = resolveWinmapTenantUrl(link.url, env);
    const revokeUrl = resolveWinmapEndpointUrl(
      link.revokeUrl || `${tenantUrl}/api/findmap/winmap/token`,
      env,
      new URL(tenantUrl).origin
    );
    if (link.token) {
      try {
        await requestAbsolute(revokeUrl, { method: "DELETE", token: link.token });
      } catch (error) {
        if (error.code !== "winmap_token_invalid") throw error;
      }
    }
    await clearLink(userId);
    return { disconnected: true, message: "Đã ngắt kết nối Winmap tenant." };
  }

  return {
    status,
    previewRequest,
    connect,
    declineRequest,
    disconnect
  };
}

module.exports = {
  PROVIDER,
  WinmapIntegrationError,
  normalizeConnectionRequest,
  normalizePendingRequest,
  resolveWinmapTenantUrl,
  resolveWinmapEndpointUrl,
  resolveTimeoutMs,
  createWinmapIntegrationService
};
