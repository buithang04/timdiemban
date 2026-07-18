const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createJobsIntegrationService,
  normalizeConnectionRequest,
  normalizeVietnamesePhone,
  stableExternalId
} = require("../jobs-integration");
const {
  encryptJobsIntegrationToken,
  decryptJobsIntegrationToken
} = require("../db");

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => data
  };
}

function createDb(initialLink = null) {
  let link = initialLink;
  return {
    get rawLink() {
      return link;
    },
    async getJobsIntegrationLink(_userId, options = {}) {
      if (!link) return null;
      if (options.includeToken) return { ...link };
      const { integrationToken: _integrationToken, ...safe } = link;
      return safe;
    },
    async saveJobsIntegrationLink(findmapUserId, data) {
      link = {
        status: "active",
        findmapUserId,
        jobsUserId: Number(data.jobsUserId),
        jobsUserName: data.jobsUserName,
        jobsUserEmail: data.jobsUserEmail,
        jobsUserRole: data.jobsUserRole,
        jobsDepartmentId: data.jobsDepartmentId,
        jobsBaseUrl: data.jobsBaseUrl,
        integrationToken: data.integrationToken,
        linkedAt: data.linkedAt,
        lastSyncAt: null
      };
      const { integrationToken: _integrationToken, ...safe } = link;
      return safe;
    },
    async revokeJobsIntegrationLink() {
      if (link) link = { ...link, status: "revoked", integrationToken: "", revokedAt: new Date().toISOString() };
    },
    async touchJobsIntegrationSync(_userId, syncedAt) {
      if (link) link = { ...link, lastSyncAt: syncedAt };
    }
  };
}

const testEnv = {
  NODE_ENV: "test",
  JOBS_CLICKON_BASE_URL: "https://jobs.clickon.vn",
  JOBS_CLICKON_TIMEOUT_MS: "1000"
};

function activeLink() {
  return {
    status: "active",
    findmapUserId: "findmap-1",
    jobsUserId: 12,
    jobsUserName: "Nhân viên Jobs",
    jobsUserEmail: "staff@example.test",
    jobsUserRole: "nhan_vien",
    jobsDepartmentId: 4,
    jobsBaseUrl: "https://jobs.clickon.vn",
    integrationToken: "a".repeat(64),
    linkedAt: "2026-07-18T01:00:00.000Z",
    lastSyncAt: null
  };
}

test("status trả chưa liên kết và không gọi Jobs", async () => {
  let calls = 0;
  const service = createJobsIntegrationService({
    db: createDb(),
    env: testEnv,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(500, {});
    }
  });

  assert.deepEqual(await service.status("findmap-1"), {
    linked: false,
    provider: "jobs_clickon"
  });
  assert.equal(calls, 0);
});

test("preview yêu cầu kết nối chỉ gọi Jobs từ backend Findmap", async () => {
  const requestToken = "ABCD-EF12-3456-7890-ABCD-EF12-3456-7890";
  const service = createJobsIntegrationService({
    db: createDb(),
    env: testEnv,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://jobs.clickon.vn/api/v1/integrations/findmap/request/preview");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { request_token: requestToken });
      return jsonResponse(200, {
        request: {
          jobs_user_id: 12,
          name: "Nhân viên Jobs",
          email: "staff@example.test",
          department_id: 4,
          expires_at: "2026-07-18T02:00:00.000Z"
        }
      });
    }
  });

  const result = await service.previewRequest(requestToken);
  assert.equal(result.request.jobs_user_id, 12);
  assert.equal(normalizeConnectionRequest(requestToken), requestToken);
  assert.throws(() => normalizeConnectionRequest("not-a-request"), /không hợp lệ/);
});

test("connect đổi pairing code server-to-server nhưng không thay phiên Findmap", async () => {
  const db = createDb();
  const sessionToken = "findmap-session-token";
  const user = Object.freeze({ id: "findmap-1", email: "user@findmap.vn", fullName: "Findmap User" });
  let requestBody;
  const service = createJobsIntegrationService({
    db,
    env: testEnv,
    now: () => new Date("2026-07-18T01:00:00.000Z"),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://jobs.clickon.vn/api/v1/integrations/findmap/exchange");
      assert.equal(options.headers.Authorization, undefined);
      requestBody = JSON.parse(options.body);
      return jsonResponse(200, {
        jobs_user_id: 12,
        name: "Nhân viên Jobs",
        email: "staff@example.test",
        role: "nhan_vien",
        department_id: 4,
        integration_token: "b".repeat(64),
        linked_at: "2026-07-18T01:00:00.000Z"
      });
    }
  });

  const result = await service.connect(user, "ABCD-EF12-3456-7890");
  assert.equal(result.linked, true);
  assert.equal(result.jobs_user_id, 12);
  assert.equal(requestBody.findmap_user_id, "findmap-1");
  assert.equal(db.rawLink.integrationToken, "b".repeat(64));
  assert.equal(sessionToken, "findmap-session-token");
});

test("từ chối yêu cầu được chuyển server-to-server sang Jobs", async () => {
  const requestToken = "ABCD-EF12-3456-7890-ABCD-EF12-3456-7890";
  const service = createJobsIntegrationService({
    db: createDb(),
    env: testEnv,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://jobs.clickon.vn/api/v1/integrations/findmap/request/decline");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { request_token: requestToken });
      return jsonResponse(200, { message: "Đã từ chối yêu cầu kết nối." });
    }
  });

  const result = await service.declineRequest(requestToken);
  assert.match(result.message, /từ chối/);
});

test("connect không gọi Jobs khi khóa mã hóa chưa sẵn sàng", async () => {
  let calls = 0;
  const db = createDb();
  db.assertJobsIntegrationEncryptionReady = () => {
    throw new Error("SETTINGS_ENCRYPTION_KEY chưa cấu hình");
  };
  const service = createJobsIntegrationService({
    db,
    env: testEnv,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, {});
    }
  });

  await assert.rejects(
    service.connect({ id: "findmap-1", email: "user@example.test" }, "ABCD-EF12-3456-7890"),
    /SETTINGS_ENCRYPTION_KEY/
  );
  assert.equal(calls, 0);
});

test("connect thu hồi token Jobs nếu lưu liên kết cục bộ thất bại", async () => {
  const db = createDb();
  db.saveJobsIntegrationLink = async () => {
    throw new Error("database unavailable");
  };
  const methods = [];
  const service = createJobsIntegrationService({
    db,
    env: testEnv,
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      if (options.method === "POST") {
        return jsonResponse(200, {
          jobs_user_id: 12,
          integration_token: "d".repeat(64)
        });
      }
      assert.equal(options.headers.Authorization, `Bearer ${"d".repeat(64)}`);
      return jsonResponse(200, { message: "revoked" });
    }
  });

  await assert.rejects(
    service.connect({ id: "findmap-1", email: "user@example.test" }, "ABCD-EF12-3456-7890"),
    /database unavailable/
  );
  assert.deepEqual(methods, ["POST", "DELETE"]);
});

test("integration token được mã hóa AES-256-GCM trước khi lưu", () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = "test-key-for-jobs-integration";
  try {
    const token = "c".repeat(64);
    const stored = encryptJobsIntegrationToken(token);
    assert.notEqual(stored, token);
    assert.match(stored, /^enc1:/);
    assert.equal(decryptJobsIntegrationToken(stored), token);
    assert.equal(decryptJobsIntegrationToken(token), "");
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("disconnect thu hồi token Jobs, xóa token cục bộ và giữ phiên Findmap", async () => {
  const db = createDb(activeLink());
  const sessionToken = "findmap-session-token";
  const service = createJobsIntegrationService({
    db,
    env: testEnv,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://jobs.clickon.vn/api/v1/integrations/findmap/token");
      assert.equal(options.method, "DELETE");
      assert.equal(options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
      assert.equal(options.headers["X-Integration-Source"], "findmap");
      return jsonResponse(200, { message: "revoked" });
    }
  });

  const result = await service.disconnect("findmap-1");
  assert.equal(result.disconnected, true);
  assert.equal(db.rawLink.status, "revoked");
  assert.equal(db.rawLink.integrationToken, "");
  assert.equal(sessionToken, "findmap-session-token");
});

test("sync chỉ gửi dòng hợp lệ và hợp nhất created duplicate invalid theo dòng gốc", async () => {
  const db = createDb(activeLink());
  let upstreamItems;
  const service = createJobsIntegrationService({
    db,
    env: testEnv,
    randomUUID: () => "fixed-request-id",
    now: () => new Date("2026-07-18T02:00:00.000Z"),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      upstreamItems = body.items;
      assert.equal(body.request_id, "batch-001");
      return jsonResponse(200, {
        request_id: "batch-001",
        replayed: false,
        items: [
          { index: 0, external_id: body.items[0].external_id, status: "created", client_id: 101, message: "Đã tạo" },
          { index: 1, external_id: body.items[1].external_id, status: "duplicate", client_id: 88, message: "Trùng số" }
        ]
      });
    }
  });

  const response = await service.syncCustomers("findmap-1", [
    { client_key: "row-1", place_id: "place-1", name: "Điểm A", phone: "0912 345 678" },
    { client_key: "row-2", name: "Thiếu số", phone: "" },
    { client_key: "row-3", place_id: "place-3", name: "Điểm C", phone: "+84 987 654 321" }
  ], "batch-001");

  assert.equal(upstreamItems.length, 2);
  assert.deepEqual(upstreamItems.map((item) => item.phone), ["0912345678", "0987654321"]);
  assert.deepEqual(response.summary, { total: 3, created: 1, duplicate: 1, invalid: 1, failed: 0 });
  assert.deepEqual(response.items.map((item) => item.status), ["created", "invalid", "duplicate"]);
  assert.deepEqual(response.items.map((item) => item.client_key), ["row-1", "row-2", "row-3"]);
  assert.equal(db.rawLink.lastSyncAt, "2026-07-18T02:00:00.000Z");
});

test("batch chỉ có dòng thiếu phone không gọi Jobs", async () => {
  let calls = 0;
  const service = createJobsIntegrationService({
    db: createDb(activeLink()),
    env: testEnv,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, {});
    }
  });

  const response = await service.syncCustomers("findmap-1", [
    { client_key: "row-no-phone", name: "Không có số", phone: "" }
  ], "batch-no-phone");
  assert.equal(calls, 0);
  assert.equal(response.summary.invalid, 1);
  assert.equal(response.items[0].status, "invalid");
});

test("sync retry đúng một lần cho HTTP 5xx và giữ nguyên request_id", async () => {
  let calls = 0;
  const bodies = [];
  const service = createJobsIntegrationService({
    db: createDb(activeLink()),
    env: testEnv,
    fetchImpl: async (_url, options) => {
      calls += 1;
      bodies.push(options.body);
      if (calls === 1) return jsonResponse(503, { message: "temporary" });
      const body = JSON.parse(options.body);
      return jsonResponse(200, {
        request_id: body.request_id,
        items: [{ index: 0, status: "created", external_id: body.items[0].external_id }]
      });
    }
  });

  const response = await service.syncCustomers("findmap-1", [
    { name: "Điểm retry", phone: "0901234567" }
  ], "batch-retry");
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(response.summary.created, 1);
});

test("chuẩn hóa +84 và external_id fallback SHA-256 ổn định", () => {
  assert.equal(normalizeVietnamesePhone("+84 901 234 567"), "0901234567");
  const row = { name: "Cửa hàng A", phone: "0901234567", lat: 21.02, lng: 105.8 };
  assert.equal(stableExternalId(row), stableExternalId({ ...row }));
  assert.match(stableExternalId(row), /^sha256:[a-f0-9]{64}$/);
  assert.equal(stableExternalId({ ...row, place_id: "ChIJ123" }), "ChIJ123");
});
