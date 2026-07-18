const crypto = require("crypto");

const PROVIDER = "jobs_clickon";
const SOURCE_HEADER = "findmap";
const MAX_BATCH_SIZE = 200;

class JobsIntegrationError extends Error {
  constructor(message, status = 500, code = "jobs_integration_error", details = null) {
    super(message);
    this.name = "JobsIntegrationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function resolveJobsBaseUrl(env = process.env) {
  const raw = String(env.JOBS_CLICKON_BASE_URL || "https://jobs.clickon.vn").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new JobsIntegrationError("JOBS_CLICKON_BASE_URL không hợp lệ.", 500, "invalid_jobs_base_url");
  }

  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && isLocal && url.protocol === "http:")) {
    throw new JobsIntegrationError(
      "JOBS_CLICKON_BASE_URL phải dùng HTTPS ở production.",
      500,
      "insecure_jobs_base_url"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new JobsIntegrationError("JOBS_CLICKON_BASE_URL không được chứa credentials hoặc query.", 500, "invalid_jobs_base_url");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function resolveTimeoutMs(env = process.env) {
  const value = Number(env.JOBS_CLICKON_TIMEOUT_MS || 15000);
  return Math.max(1000, Math.min(30000, Number.isFinite(value) ? Math.floor(value) : 15000));
}

function normalizeVietnamesePhone(raw) {
  let digits = String(raw || "").replace(/\D+/g, "");
  if (digits.startsWith("84") && digits.length >= 11) digits = `0${digits.slice(2)}`;
  return digits.length >= 9 && digits.length <= 11 ? digits : "";
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
    throw new JobsIntegrationError("Yêu cầu kết nối không hợp lệ.", 422, "invalid_connection_request");
  }
  const compact = token.replace(/-/g, "");
  if (![16, 32].includes(compact.length)) {
    throw new JobsIntegrationError("Yêu cầu kết nối không hợp lệ.", 422, "invalid_connection_request");
  }
  return token;
}

function stableExternalId(row) {
  const placeId = limitedText(row.place_id || row.googlePlaceId || row.placeId, 120);
  if (placeId) return placeId;

  const input = [
    limitedText(row.name, 255).toLocaleLowerCase("vi"),
    normalizeVietnamesePhone(row.phone),
    Number.isFinite(Number(row.latitude ?? row.lat)) ? Number(row.latitude ?? row.lat).toFixed(6) : "",
    Number.isFinite(Number(row.longitude ?? row.lng)) ? Number(row.longitude ?? row.lng).toFixed(6) : ""
  ].join("|");
  return `sha256:${crypto.createHash("sha256").update(input).digest("hex")}`;
}

function buildJobsItem(row) {
  const latitude = Number(row.latitude ?? row.lat);
  const longitude = Number(row.longitude ?? row.lng);
  const placeId = limitedText(row.place_id || row.googlePlaceId || row.placeId, 120);
  return {
    external_id: stableExternalId(row),
    place_id: placeId || null,
    name: limitedText(row.name, 255),
    phone: normalizeVietnamesePhone(row.phone),
    address: limitedText(row.address, 1000),
    website: limitedText(row.website, 1000),
    rating: limitedText(row.rating, 50),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    google_maps_url: limitedText(row.google_maps_url || row.mapsUrl || row.href, 1500),
    category: limitedText(row.category || row.keyword, 500),
    notes: limitedText(row.notes, 4000),
    searched_at: limitedText(row.searched_at || row.searchedAt, 100)
  };
}

function mapRemoteError(status, data) {
  const message = limitedText(data?.message || data?.error, 500);
  if (status === 401) {
    return new JobsIntegrationError(
      message || "Liên kết Jobs không hợp lệ hoặc đã bị thu hồi.",
      401,
      "jobs_token_invalid"
    );
  }
  if (status === 403) {
    return new JobsIntegrationError(message || "Tài khoản Jobs không còn quyền CRM.", 403, "jobs_forbidden");
  }
  if (status === 409 || status === 410 || status === 422 || status === 429) {
    return new JobsIntegrationError(message || "Jobs ClickOn từ chối yêu cầu.", status, "jobs_request_rejected", data);
  }
  return new JobsIntegrationError(
    message || "Jobs ClickOn đang tạm thời không phản hồi.",
    502,
    "jobs_upstream_error"
  );
}

function createJobsIntegrationService({
  db,
  fetchImpl = global.fetch,
  env = process.env,
  randomUUID = () => crypto.randomUUID(),
  now = () => new Date()
}) {
  if (!db) throw new Error("Jobs integration cần db adapter");
  if (typeof fetchImpl !== "function") throw new Error("Node.js runtime cần hỗ trợ fetch");

  const baseUrl = resolveJobsBaseUrl(env);
  const timeoutMs = resolveTimeoutMs(env);

  async function request(path, { method = "GET", token = "", body, retry5xx = false } = {}) {
    const maxAttempts = retry5xx ? 2 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { Accept: "application/json", "Content-Type": "application/json" };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
          headers["X-Integration-Source"] = SOURCE_HEADER;
        }
        const response = await fetchImpl(`${baseUrl}${path}`, {
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
        if (retry5xx && response.status >= 500 && attempt < maxAttempts) continue;
        throw mapRemoteError(response.status, data);
      } catch (error) {
        if (error instanceof JobsIntegrationError) throw error;
        lastError = error;
        if (attempt >= maxAttempts) {
          const timedOut = error?.name === "AbortError";
          throw new JobsIntegrationError(
            timedOut
              ? "Kết nối Jobs ClickOn quá thời gian chờ."
              : "Không kết nối được Jobs ClickOn.",
            502,
            timedOut ? "jobs_timeout" : "jobs_network_error"
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new JobsIntegrationError("Không kết nối được Jobs ClickOn.", 502);
  }

  function publicStatus(link, extra = {}) {
    if (!link || link.status !== "active") {
      return { linked: false, provider: PROVIDER, ...extra };
    }
    return {
      linked: true,
      provider: PROVIDER,
      jobs_user_id: link.jobsUserId,
      name: link.jobsUserName,
      email: link.jobsUserEmail,
      role: link.jobsUserRole,
      department_id: link.jobsDepartmentId,
      linked_at: link.linkedAt,
      last_sync_at: link.lastSyncAt,
      ...extra
    };
  }

  async function status(findmapUserId, { verify = false } = {}) {
    const link = await db.getJobsIntegrationLink(findmapUserId, { includeToken: verify });
    if (!link || link.status !== "active") return publicStatus(null);
    if (!verify) return publicStatus(link);
    if (!link.integrationToken) {
      return publicStatus(link, {
        verified: false,
        error: "Không giải mã được integration token. Kiểm tra SETTINGS_ENCRYPTION_KEY."
      });
    }

    try {
      const remote = await request("/api/v1/integrations/findmap/token/status", {
        token: link.integrationToken
      });
      return publicStatus(link, { verified: true, remote });
    } catch (error) {
      if (error.code === "jobs_token_invalid") {
        await db.revokeJobsIntegrationLink(findmapUserId);
        return publicStatus(null, { verified: false, error: error.message });
      }
      throw error;
    }
  }

  async function previewRequest(requestToken) {
    const token = normalizeConnectionRequest(requestToken);
    const response = await request("/api/v1/integrations/findmap/request/preview", {
      method: "POST",
      body: { request_token: token }
    });
    if (!response?.request?.jobs_user_id || !response?.request?.expires_at) {
      throw new JobsIntegrationError("Jobs ClickOn trả yêu cầu kết nối không đầy đủ.", 502, "invalid_jobs_response");
    }
    return response;
  }

  async function connect(user, requestToken) {
    if (typeof db.assertJobsIntegrationEncryptionReady === "function") {
      db.assertJobsIntegrationEncryptionReady();
    }
    const code = normalizeConnectionRequest(requestToken);

    const response = await request("/api/v1/integrations/findmap/exchange", {
      method: "POST",
      body: {
        pairing_code: code,
        findmap_user_id: String(user.id),
        findmap_email: user.email || null,
        display_name: user.fullName || user.email || null
      }
    });
    if (!response?.integration_token || !response?.jobs_user_id) {
      throw new JobsIntegrationError("Jobs ClickOn trả dữ liệu liên kết không đầy đủ.", 502, "invalid_jobs_response");
    }

    let link;
    try {
      link = await db.saveJobsIntegrationLink(user.id, {
        jobsUserId: response.jobs_user_id,
        jobsUserName: response.name || "",
        jobsUserEmail: response.email || "",
        jobsUserRole: response.role || "",
        jobsDepartmentId: response.department_id ?? null,
        jobsBaseUrl: baseUrl,
        integrationToken: response.integration_token,
        linkedAt: response.linked_at || now().toISOString()
      });
    } catch (error) {
      await request("/api/v1/integrations/findmap/token", {
        method: "DELETE",
        token: response.integration_token
      }).catch(() => {});
      throw error;
    }
    return publicStatus(link, { message: "Đã kết nối Jobs ClickOn." });
  }

  async function declineRequest(requestToken) {
    const token = normalizeConnectionRequest(requestToken);
    return request("/api/v1/integrations/findmap/request/decline", {
      method: "POST",
      body: { request_token: token }
    });
  }

  async function disconnect(findmapUserId) {
    const link = await db.getJobsIntegrationLink(findmapUserId, { includeToken: true });
    if (!link || link.status !== "active") {
      return { disconnected: false, message: "Tài khoản chưa kết nối Jobs ClickOn." };
    }

    if (!link.integrationToken) {
      throw new JobsIntegrationError(
        "Không giải mã được integration token. Kiểm tra SETTINGS_ENCRYPTION_KEY trước khi ngắt liên kết.",
        500,
        "jobs_token_unavailable"
      );
    }
    try {
      await request("/api/v1/integrations/findmap/token", {
        method: "DELETE",
        token: link.integrationToken
      });
    } catch (error) {
      if (error.code !== "jobs_token_invalid") throw error;
    }
    await db.revokeJobsIntegrationLink(findmapUserId);
    return { disconnected: true, message: "Đã ngắt kết nối Jobs ClickOn." };
  }

  async function syncCustomers(findmapUserId, rows, requestedId = "") {
    if (!Array.isArray(rows) || rows.length < 1) {
      throw new JobsIntegrationError("Chọn ít nhất một điểm bán để đồng bộ.", 422, "empty_batch");
    }
    if (rows.length > MAX_BATCH_SIZE) {
      throw new JobsIntegrationError(`Mỗi lần chỉ đồng bộ tối đa ${MAX_BATCH_SIZE} dòng.`, 422, "batch_too_large");
    }

    const link = await db.getJobsIntegrationLink(findmapUserId, { includeToken: true });
    if (!link || link.status !== "active") {
      throw new JobsIntegrationError("Chưa kết nối Jobs ClickOn hoặc liên kết đã hết hiệu lực.", 409, "jobs_not_linked");
    }
    if (!link.integrationToken) {
      throw new JobsIntegrationError(
        "Không giải mã được integration token. Kiểm tra SETTINGS_ENCRYPTION_KEY.",
        500,
        "jobs_token_unavailable"
      );
    }

    const entries = rows.map((row, originalIndex) => {
      const source = row && typeof row === "object" ? row : {};
      return {
        originalIndex,
        clientKey: limitedText(source.client_key, 500),
        item: buildJobsItem(source)
      };
    });
    const valid = entries.filter((entry) => entry.item.phone && entry.item.name);
    const invalid = entries
      .filter((entry) => !entry.item.phone || !entry.item.name)
      .map((entry) => ({
        index: entry.originalIndex,
        client_key: entry.clientKey,
        external_id: entry.item.external_id,
        status: "invalid",
        message: !entry.item.phone ? "Số điện thoại không hợp lệ." : "Thiếu tên địa điểm.",
        retryable: false
      }));

    let remoteItems = [];
    let replayed = false;
    let requestId = limitedText(requestedId, 100);
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) requestId = `findmap-${randomUUID()}`;

    if (valid.length) {
      const response = await request("/api/v1/integrations/findmap/customers/import", {
        method: "POST",
        token: link.integrationToken,
        retry5xx: true,
        body: {
          request_id: requestId,
          source: "findmap",
          source_type: "google_maps",
          findmap_user_id: String(findmapUserId),
          items: valid.map((entry) => entry.item)
        }
      });
      replayed = Boolean(response?.replayed);
      remoteItems = (Array.isArray(response?.items) ? response.items : []).map((item) => {
        const entry = valid[Number(item?.index)];
        return {
          ...item,
          index: entry?.originalIndex ?? (Number(item?.index) || 0),
          client_key: entry?.clientKey || ""
        };
      });
      await db.touchJobsIntegrationSync(findmapUserId, now().toISOString());
    }

    const items = [...remoteItems, ...invalid].sort((a, b) => Number(a.index) - Number(b.index));
    const count = (statusName) => items.filter((item) => item.status === statusName).length;
    return {
      request_id: requestId,
      replayed,
      summary: {
        total: items.length,
        created: count("created"),
        duplicate: count("duplicate"),
        invalid: count("invalid"),
        failed: count("failed")
      },
      items
    };
  }

  return { status, previewRequest, connect, declineRequest, disconnect, syncCustomers, baseUrl };
}

module.exports = {
  PROVIDER,
  MAX_BATCH_SIZE,
  JobsIntegrationError,
  resolveJobsBaseUrl,
  resolveTimeoutMs,
  normalizeConnectionRequest,
  normalizeVietnamesePhone,
  stableExternalId,
  buildJobsItem,
  createJobsIntegrationService
};
