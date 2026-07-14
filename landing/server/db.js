/**
 * db.js — MySQL cho hệ tin tức (database riêng: findmap_news)
 */
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const {
  isSecretSettingKey,
  encryptSecret,
  decryptSecret,
  migrateSecretSettings
} = require("../../config/settings-crypto");

let pool = null;

function getPool() {
  if (!pool) throw new Error("MySQL chưa được khởi tạo — gọi initDb() trước");
  return pool;
}

async function initDb() {
  if (pool) return pool;

  const dbName = process.env.MYSQL_DATABASE || "findmap_news";

  const tmpPool = mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    waitForConnections: true,
    connectionLimit: 2,
    charset: "utf8mb4"
  });
  try {
    await tmpPool.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await tmpPool.end().catch(() => {});
  }

  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4"
  });

  await createAuthTables();
  await seedDefaultStaff();

  try {
    const { ensureCmsTables, purgeTrashOlderThan } = require("./cms-store");
    await ensureCmsTables();
    await purgeTrashOlderThan(30);
  } catch (err) {
    console.error("[cms] Không khởi tạo bảng tin tức:", err.message);
    throw err;
  }

  await migrateSecretSettings(pool);

  return pool;
}

async function createAuthTables() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cms_users (
        id            VARCHAR(64)   NOT NULL PRIMARY KEY,
        full_name     VARCHAR(255)  DEFAULT NULL,
        email         VARCHAR(255)  NOT NULL,
        password_hash VARCHAR(512)  NOT NULL,
        role          VARCHAR(20)   NOT NULL DEFAULT 'editor',
        is_active     TINYINT       NOT NULL DEFAULT 1,
        created_at    VARCHAR(64)   NOT NULL,
        UNIQUE KEY uq_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cms_tokens (
        id         BIGINT AUTO_INCREMENT PRIMARY KEY,
        token      VARCHAR(128) NOT NULL,
        type       VARCHAR(32)  NOT NULL,
        user_id    VARCHAR(64)  NOT NULL,
        expires_at BIGINT       NOT NULL,
        created_at VARCHAR(64)  NOT NULL,
        UNIQUE KEY uq_token (token),
        KEY idx_user (user_id),
        CONSTRAINT fk_cms_tokens_user FOREIGN KEY (user_id) REFERENCES cms_users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\`     VARCHAR(255) NOT NULL PRIMARY KEY,
        value      TEXT         DEFAULT NULL,
        updated_at VARCHAR(64)  NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } finally {
    conn.release();
  }
}

async function seedDefaultStaff() {
  const adminEmail =
    (process.env.CMS_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "").trim().toLowerCase() ||
    "admin@findmap-news.local";
  const adminPassword = process.env.CMS_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "Admin@123456";
  const editorEmail =
    (process.env.CMS_EDITOR_EMAIL || process.env.EDITOR_EMAIL || "").trim().toLowerCase() ||
    "editor@findmap-news.local";
  const editorPassword =
    process.env.CMS_EDITOR_PASSWORD || process.env.EDITOR_PASSWORD || "Editor@123456";

  const [admins] = await pool.execute("SELECT id FROM cms_users WHERE role = 'admin' LIMIT 1");
  if (!admins.length) {
    const id = newId("cms_admin");
    await pool.execute(
      `INSERT INTO cms_users (id, full_name, email, password_hash, role, is_active, created_at)
       VALUES (?, ?, ?, ?, 'admin', 1, ?)`,
      [id, "CMS Admin", adminEmail, hashPassword(adminPassword), new Date().toISOString()]
    );
    console.log(`[DB] CMS admin: ${adminEmail} / ${adminPassword}`);
  }

  const [editors] = await pool.execute("SELECT id FROM cms_users WHERE role = 'editor' LIMIT 1");
  if (!editors.length) {
    const [byEmail] = await pool.execute("SELECT id FROM cms_users WHERE email = ? LIMIT 1", [
      editorEmail
    ]);
    if (!byEmail.length) {
      const id = newId("cms_ed");
      await pool.execute(
        `INSERT INTO cms_users (id, full_name, email, password_hash, role, is_active, created_at)
         VALUES (?, ?, ?, ?, 'editor', 1, ?)`,
        [id, "Editor CMS", editorEmail, hashPassword(editorPassword), new Date().toISOString()]
      );
      console.log(`[DB] CMS editor: ${editorEmail} / ${editorPassword}`);
    }
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
  } catch {
    return false;
  }
}

function newId(prefix = "cms") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function purgeExpiredTokens() {
  await pool.execute("DELETE FROM cms_tokens WHERE expires_at <= ?", [Date.now()]);
}

async function createSessionToken(userId) {
  await purgeExpiredTokens();
  const token = newToken();
  const now = Date.now();
  await pool.execute(
    `INSERT INTO cms_tokens (token, type, user_id, expires_at, created_at) VALUES (?, 'session', ?, ?, ?)`,
    [token, userId, now + SESSION_TTL_MS, new Date(now).toISOString()]
  );
  return token;
}

async function getTokenRow(token) {
  if (!token) return null;
  await purgeExpiredTokens();
  const [rows] = await pool.execute(
    `SELECT t.*, u.email, u.role, u.full_name, u.is_active, u.created_at AS user_created_at
     FROM cms_tokens t
     JOIN cms_users u ON u.id = t.user_id
     WHERE t.token = ? AND t.expires_at > ?`,
    [token, Date.now()]
  );
  return rows[0] || null;
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id || row.user_id,
    fullName: row.full_name || "",
    email: row.email,
    role: row.role || "editor",
    isActive: row.is_active !== 0,
    createdAt: row.created_at || row.user_created_at
  };
}

async function getUserById(id) {
  const [rows] = await pool.execute("SELECT * FROM cms_users WHERE id = ?", [id]);
  return rows[0] ? sanitizeUser(rows[0]) : null;
}

async function getSetting(key, fallback = null) {
  const [rows] = await pool.execute("SELECT value FROM settings WHERE `key` = ?", [key]);
  if (!rows[0]) return fallback;
  const raw = rows[0].value;
  if (raw == null) return fallback;
  return isSecretSettingKey(key) ? decryptSecret(raw) : raw;
}

async function setSetting(key, value) {
  const now = new Date().toISOString();
  let stored = value == null ? null : String(value);
  if (stored !== null && isSecretSettingKey(key)) {
    stored = stored ? encryptSecret(stored) : "";
  }
  await pool.execute(
    `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [key, stored, now]
  );
}

module.exports = {
  initDb,
  getPool,
  hashPassword,
  verifyPassword,
  newId,
  newToken,
  SESSION_TTL_MS,
  createSessionToken,
  getTokenRow,
  sanitizeUser,
  getUserById,
  getSetting,
  setSetting,
  purgeExpiredTokens
};
