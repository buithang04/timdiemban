/**
 * Lưu workspace kết quả tìm kiếm theo từng user (MySQL).
 * Một user = một bản ghi mới nhất (upsert).
 */
const { getPool } = require("./db");

const MAX_RESULT_ROWS = 20000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB

function safeJsonParse(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function normalizeWorkspacePayload(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length > MAX_RESULT_ROWS) {
    throw new Error(`Quá nhiều kết quả (tối đa ${MAX_RESULT_ROWS.toLocaleString("vi-VN")} dòng)`);
  }

  const payload = {
    data,
    search: body?.search && typeof body.search === "object" ? body.search : null,
    sentKeys: Array.isArray(body?.sentKeys) ? body.sentKeys.slice(0, MAX_RESULT_ROWS) : [],
    jobsSyncResults: Array.isArray(body?.jobsSyncResults) ? body.jobsSyncResults : [],
    savedAt: Number(body?.savedAt) || Date.now()
  };

  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Dữ liệu kết quả quá lớn — hãy xuất Excel rồi làm mới bảng");
  }

  return { payload, json, resultCount: data.length };
}

async function getUserSearchResults(userId) {
  const [rows] = await getPool().execute(
    `SELECT result_count, payload, updated_at
     FROM user_search_results
     WHERE user_id = ?
     LIMIT 1`,
    [userId]
  );
  if (!rows[0]) {
    return { exists: false, resultCount: 0, data: [], search: null, sentKeys: [], jobsSyncResults: [], updatedAt: null };
  }

  const parsed = safeJsonParse(rows[0].payload) || {};
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  return {
    exists: true,
    resultCount: Number(rows[0].result_count) || data.length,
    data,
    search: parsed.search || null,
    sentKeys: Array.isArray(parsed.sentKeys) ? parsed.sentKeys : [],
    jobsSyncResults: Array.isArray(parsed.jobsSyncResults) ? parsed.jobsSyncResults : [],
    updatedAt: rows[0].updated_at || null,
    savedAt: parsed.savedAt || null
  };
}

async function saveUserSearchResults(userId, body) {
  const { payload, json, resultCount } = normalizeWorkspacePayload(body);
  const now = new Date().toISOString();

  if (resultCount === 0) {
    await deleteUserSearchResults(userId);
    return { resultCount: 0, updatedAt: now, cleared: true };
  }

  await getPool().execute(
    `INSERT INTO user_search_results (user_id, result_count, payload, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       result_count = VALUES(result_count),
       payload = VALUES(payload),
       updated_at = VALUES(updated_at)`,
    [userId, resultCount, json, now]
  );

  return {
    resultCount,
    updatedAt: now,
    savedAt: payload.savedAt,
    cleared: false
  };
}

async function deleteUserSearchResults(userId) {
  await getPool().execute("DELETE FROM user_search_results WHERE user_id = ?", [userId]);
  return { cleared: true, resultCount: 0 };
}

module.exports = {
  MAX_RESULT_ROWS,
  getUserSearchResults,
  saveUserSearchResults,
  deleteUserSearchResults
};
