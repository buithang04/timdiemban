const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWinmapIntegrationService,
  normalizeConnectionRequest,
  normalizePendingRequest,
  resolveWinmapTenantUrl
} = require("../winmap-integration");

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => data
  };
}

function createDb(initial = {}) {
  const settings = new Map(Object.entries(initial));
  return {
    get rawSettings() {
      return settings;
    },
    assertWinmapSiteEncryptionReady() {},
    async getSetting(key, fallback = "") {
      return settings.has(key) ? settings.get(key) : fallback;
    },
    async setSetting(key, value) {
      settings.set(key, value == null ? "" : String(value));
    }
  };
}

const env = {
  NODE_ENV: "test",
  WINMAP_TENANT_ALLOWED_HOST_SUFFIXES: "winmap.vn,.winmap.vn,localhost",
  WINMAP_TENANT_TIMEOUT_MS: "1000"
};

const pendingRequest = {
  request_token: "ABCD-EF12-3456-7890-ABCD-EF12-3456-7890",
  tenant_url: "https://demo.winmap.vn",
  preview_url: "https://demo.winmap.vn/api/findmap/winmap/request/preview",
  exchange_url: "https://demo.winmap.vn/api/findmap/winmap/exchange"
};

test("chuẩn hóa yêu cầu Winmap chỉ nhận tenant Winmap và endpoint cùng origin", () => {
  assert.equal(normalizeConnectionRequest("abcd-ef12-3456-7890"), "ABCD-EF12-3456-7890");
  assert.equal(resolveWinmapTenantUrl("demo.winmap.vn", env), "https://demo.winmap.vn");

  const normalized = normalizePendingRequest(pendingRequest, env);
  assert.equal(normalized.requestToken, pendingRequest.request_token);
  assert.equal(normalized.tenantUrl, "https://demo.winmap.vn");
  assert.equal(normalized.previewUrl, pendingRequest.preview_url);
  assert.equal(normalized.exchangeUrl, pendingRequest.exchange_url);

  assert.throws(
    () => normalizePendingRequest({ ...pendingRequest, tenant_url: "https://evil.example" }, env),
    /tenant Winmap/
  );
  assert.throws(
    () => normalizePendingRequest({ ...pendingRequest, exchange_url: "https://other.winmap.vn/api/findmap/winmap/exchange" }, env),
    /cùng tenant/
  );
  assert.throws(
    () => normalizePendingRequest({ ...pendingRequest, preview_url: "http://demo.winmap.vn/api/findmap/winmap/request/preview" }, { ...env, NODE_ENV: "production" }),
    /HTTPS/
  );
});

test("preview yêu cầu kết nối gọi Winmap tenant từ backend Findmap và không gửi token dài hạn", async () => {
  const service = createWinmapIntegrationService({
    db: createDb(),
    env,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://demo.winmap.vn/api/findmap/winmap/request/preview");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { request_token: pendingRequest.request_token });
      return jsonResponse(200, {
        request: {
          tenant_url: "https://demo.winmap.vn",
          tenant_name: "Demo Winmap",
          expires_at: "2026-09-07T11:00:00+07:00"
        }
      });
    }
  });

  const result = await service.previewRequest(pendingRequest);
  assert.equal(result.request.tenant_url, "https://demo.winmap.vn");
  assert.equal(result.request.tenant_name, "Demo Winmap");
  assert.equal(result.request.push_token, undefined);
});

test("connect chỉ lưu cấu hình Winmap sau khi exchange thành công với tenant", async () => {
  const db = createDb();
  const user = Object.freeze({ id: "findmap-1", email: "user@findmap.vn", fullName: "Findmap User" });
  let body;
  const service = createWinmapIntegrationService({
    db,
    env,
    now: () => new Date("2026-09-07T04:00:00.000Z"),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://demo.winmap.vn/api/findmap/winmap/exchange");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, undefined);
      body = JSON.parse(options.body);
      return jsonResponse(200, {
        linked: true,
        tenant: {
          url: "https://demo.winmap.vn",
          name: "Demo Winmap"
        },
        push: {
          url: "https://demo.winmap.vn/api/points/import",
          token: "winmap-push-token"
        },
        status_url: "https://demo.winmap.vn/api/findmap/winmap/token/status",
        revoke_url: "https://demo.winmap.vn/api/findmap/winmap/token",
        connected_at: "2026-09-07T11:00:00+07:00"
      });
    }
  });

  const status = await service.connect(user, pendingRequest);
  assert.equal(status.linked, true);
  assert.equal(status.provider, "winmap_tenant");
  assert.equal(body.findmap_user_id, "findmap-1");
  assert.equal(db.rawSettings.get("winmap_site_url:findmap-1"), "https://demo.winmap.vn");
  assert.equal(db.rawSettings.get("winmap_site_token:findmap-1"), "winmap-push-token");
  assert.equal(db.rawSettings.get("winmap_site_label:findmap-1"), "Demo Winmap");
  assert.equal(db.rawSettings.get("winmap_site_status_url:findmap-1"), "https://demo.winmap.vn/api/findmap/winmap/token/status");
  assert.equal(db.rawSettings.get("winmap_site_revoke_url:findmap-1"), "https://demo.winmap.vn/api/findmap/winmap/token");

  const pushConfig = JSON.parse(db.rawSettings.get("winmap_site_push_config:findmap-1"));
  assert.equal(pushConfig.urlMode, "winmap");
  assert.equal(pushConfig.sourceTag, "timdiemban");
});

test("connect không gọi Winmap khi mã hóa secret chưa sẵn sàng", async () => {
  const db = createDb();
  db.assertWinmapSiteEncryptionReady = () => {
    throw new Error("SETTINGS_ENCRYPTION_KEY chưa cấu hình");
  };
  let calls = 0;
  const service = createWinmapIntegrationService({
    db,
    env,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, {});
    }
  });

  await assert.rejects(
    service.connect({ id: "findmap-1", email: "user@findmap.vn" }, pendingRequest),
    /SETTINGS_ENCRYPTION_KEY/
  );
  assert.equal(calls, 0);
});

test("status verify dùng token đã lưu và tự gỡ link khi Winmap từ chối token", async () => {
  const db = createDb({
    "winmap_site_url:findmap-1": "https://demo.winmap.vn",
    "winmap_site_token:findmap-1": "revoked-token",
    "winmap_site_label:findmap-1": "Demo Winmap",
    "winmap_site_status_url:findmap-1": "https://demo.winmap.vn/api/findmap/winmap/token/status"
  });
  const service = createWinmapIntegrationService({
    db,
    env,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://demo.winmap.vn/api/findmap/winmap/token/status");
      assert.equal(options.headers.Authorization, "Bearer revoked-token");
      return jsonResponse(403, { message: "Token đã bị thu hồi." });
    }
  });

  const status = await service.status("findmap-1", { verify: true });
  assert.equal(status.linked, false);
  assert.equal(status.verified, false);
  assert.equal(db.rawSettings.get("winmap_site_token:findmap-1"), "");
});

test("disconnect thu hồi token ở Winmap rồi xóa cấu hình cục bộ", async () => {
  const db = createDb({
    "winmap_site_url:findmap-1": "https://demo.winmap.vn",
    "winmap_site_token:findmap-1": "findmap-token",
    "winmap_site_label:findmap-1": "Demo Winmap",
    "winmap_site_revoke_url:findmap-1": "https://demo.winmap.vn/api/findmap/winmap/token"
  });
  const service = createWinmapIntegrationService({
    db,
    env,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://demo.winmap.vn/api/findmap/winmap/token");
      assert.equal(options.method, "DELETE");
      assert.equal(options.headers.Authorization, "Bearer findmap-token");
      return jsonResponse(200, { revoked: true });
    }
  });

  const result = await service.disconnect("findmap-1");
  assert.equal(result.disconnected, true);
  assert.equal(db.rawSettings.get("winmap_site_url:findmap-1"), "");
  assert.equal(db.rawSettings.get("winmap_site_token:findmap-1"), "");
});
