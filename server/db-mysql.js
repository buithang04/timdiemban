/**
 * db-mysql.js — MySQL (mysql2/promise) thay thế db.js cho DB_TYPE=mysql
 * API giống db.js nhưng tất cả hàm là async.
 */
const mysql = require("mysql2/promise");
const crypto = require("crypto");

const PACKAGES = [
  { id: "pkg_3000",  name: "Gói 3.000 điểm",  points: 3000,  price: 99000,  expire_days: 365 },
  { id: "pkg_5000",  name: "Gói 5.000 điểm",  points: 5000,  price: 149000, expire_days: 365 },
  { id: "pkg_10000", name: "Gói 10.000 điểm", points: 10000, price: 279000, expire_days: 365 }
];

let pool = null;

function getPool() {
  if (!pool) throw new Error("MySQL chưa được khởi tạo — gọi initDb() trước");
  return pool;
}

async function initDb() {
  if (pool) return pool;

  pool = mysql.createPool({
    host:     process.env.MYSQL_HOST     || "localhost",
    port:     Number(process.env.MYSQL_PORT)  || 3306,
    user:     process.env.MYSQL_USER     || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "timdiemban",
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4"
  });

  // Tự động tạo database nếu chưa có
  const tmpPool = mysql.createPool({
    host:     process.env.MYSQL_HOST     || "localhost",
    port:     Number(process.env.MYSQL_PORT)  || 3306,
    user:     process.env.MYSQL_USER     || "root",
    password: process.env.MYSQL_PASSWORD || "",
    waitForConnections: true,
    connectionLimit: 2,
    charset: "utf8mb4"
  });
  const dbName = process.env.MYSQL_DATABASE || "timdiemban";
  try {
    await tmpPool.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await tmpPool.end().catch(() => {});
  }

  await createTables();
  await seedPackages();
  await seedDefaultAdmin();
  await migrateUsersSchema();

  return pool;
}

async function migrateUsersSchema() {
  try {
    await pool.execute(
      "ALTER TABLE users ADD COLUMN package_expires_at VARCHAR(64) DEFAULT NULL"
    );
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
  const [rows] = await pool.execute(
    `SELECT u.id, u.created_at, p.expire_days
     FROM users u
     INNER JOIN packages p ON p.id = u.package_id
     WHERE u.package_expires_at IS NULL`
  );
  for (const r of rows) {
    const base = new Date(r.created_at);
    const exp = new Date(base);
    exp.setDate(exp.getDate() + Math.max(1, Number(r.expire_days) || 365));
    await pool.execute("UPDATE users SET package_expires_at = ? WHERE id = ?", [
      exp.toISOString(),
      r.id
    ]);
  }
}

async function createTables() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS packages (
        id          VARCHAR(64)  NOT NULL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        points      INT          NOT NULL,
        price       INT          NOT NULL DEFAULT 0,
        expire_days INT          NOT NULL DEFAULT 30,
        is_active   TINYINT      NOT NULL DEFAULT 1,
        created_at  VARCHAR(64)  NOT NULL,
        UNIQUE KEY uq_points (points)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id            VARCHAR(64)   NOT NULL PRIMARY KEY,
        email         VARCHAR(255)  NOT NULL,
        password_hash VARCHAR(512)  NOT NULL,
        role          VARCHAR(20)   NOT NULL DEFAULT 'user',
        points        INT           NOT NULL DEFAULT 0,
        package_id    VARCHAR(64)   REFERENCES packages(id),
        package_expires_at VARCHAR(64) DEFAULT NULL,
        is_active     TINYINT       NOT NULL DEFAULT 1,
        created_at    VARCHAR(64)   NOT NULL,
        UNIQUE KEY uq_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tokens (
        id         BIGINT AUTO_INCREMENT PRIMARY KEY,
        token      VARCHAR(128) NOT NULL,
        type       VARCHAR(32)  NOT NULL,
        user_id    VARCHAR(64)  NOT NULL,
        expires_at BIGINT       NOT NULL,
        created_at VARCHAR(64)  NOT NULL,
        UNIQUE KEY uq_token (token),
        KEY idx_user (user_id),
        CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS package_orders (
        id                   VARCHAR(64)  NOT NULL PRIMARY KEY,
        user_id              VARCHAR(64)  NOT NULL,
        package_id           VARCHAR(64)  NOT NULL,
        points               INT          NOT NULL,
        payment_amount       INT          NOT NULL DEFAULT 0,
        status               VARCHAR(20)  NOT NULL DEFAULT 'pending',
        payment_confirmed    TINYINT      NOT NULL DEFAULT 0,
        payment_confirmed_at VARCHAR(64)  DEFAULT NULL,
        admin_id             VARCHAR(64)  DEFAULT NULL,
        admin_note           TEXT         DEFAULT NULL,
        created_at           VARCHAR(64)  NOT NULL,
        reviewed_at          VARCHAR(64)  DEFAULT NULL,
        KEY idx_status (status),
        KEY idx_user_id (user_id),
        CONSTRAINT fk_po_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
        CONSTRAINT fk_po_pkg     FOREIGN KEY (package_id) REFERENCES packages(id),
        CONSTRAINT fk_po_admin   FOREIGN KEY (admin_id)   REFERENCES users(id)
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

async function seedPackages() {
  const now = new Date().toISOString();
  for (const pkg of PACKAGES) {
    await pool.execute(
      `INSERT INTO packages (id, name, points, price, expire_days, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price), expire_days=VALUES(expire_days)`,
      [pkg.id, pkg.name, pkg.points, pkg.price, pkg.expire_days, now]
    );
  }
}

async function seedDefaultAdmin() {
  const envEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase() || "admin@timdiemban.local";
  const envPassword = process.env.ADMIN_PASSWORD || "Admin@123456";

  const [rows] = await pool.execute("SELECT id, email FROM users WHERE role = 'admin' LIMIT 1");

  if (rows.length) {
    const existing = rows[0];
    if (envEmail !== existing.email) {
      const [taken] = await pool.execute(
        "SELECT id FROM users WHERE email = ? AND id != ?",
        [envEmail, existing.id]
      );
      if (!taken.length) {
        await pool.execute("UPDATE users SET email = ? WHERE id = ?", [envEmail, existing.id]);
        console.log(`[DB] Đã đổi email admin → ${envEmail}`);
      }
    }
    return;
  }

  const id = newId("u_admin");
  await pool.execute(
    `INSERT INTO users (id, email, password_hash, role, points, is_active, created_at)
     VALUES (?, ?, ?, 'admin', 0, 1, ?)`,
    [id, envEmail, hashPassword(envPassword), new Date().toISOString()]
  );
  console.log(`[DB] Tài khoản admin mặc định: ${envEmail} / ${envPassword}`);
  console.log("[DB] Đổi mật khẩu ngay sau lần đăng nhập đầu.");
}

// ——— Helpers ———

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

function newId(prefix = "u") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

async function purgeExpiredTokens() {
  await pool.execute("DELETE FROM tokens WHERE expires_at <= ?", [Date.now()]);
}

async function createSessionToken(userId) {
  await purgeExpiredTokens();
  const token = newToken();
  const now = Date.now();
  await pool.execute(
    `INSERT INTO tokens (token, type, user_id, expires_at, created_at) VALUES (?, 'session', ?, ?, ?)`,
    [token, userId, now + SESSION_TTL_MS, new Date(now).toISOString()]
  );
  return token;
}

async function getTokenRow(token) {
  if (!token) return null;
  await purgeExpiredTokens();
  const [rows] = await pool.execute(
    `SELECT t.*, u.email, u.role, u.points, u.is_active, u.package_id, u.created_at AS user_created_at,
            p.name AS package_name
     FROM tokens t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN packages p ON p.id = u.package_id
     WHERE t.token = ? AND t.expires_at > ?`,
    [token, Date.now()]
  );
  return rows[0] || null;
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id || row.user_id,
    email: row.email,
    role: row.role || "user",
    points: row.points ?? 0,
    packageId: row.package_id || null,
    packageName: row.package_name || null,
    packageExpiresAt: row.package_expires_at || null,
    isActive: row.is_active !== 0,
    createdAt: row.created_at || row.user_created_at
  };
}

async function getUserById(id) {
  const [rows] = await pool.execute(
    `SELECT u.*, p.name AS package_name
     FROM users u
     LEFT JOIN packages p ON p.id = u.package_id
     WHERE u.id = ?`,
    [id]
  );
  return rows[0] ? sanitizeUser(rows[0]) : null;
}

async function listPackages() {
  const [rows] = await pool.execute(
    "SELECT id, name, points, price, expire_days FROM packages WHERE is_active = 1 ORDER BY points ASC"
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    points: r.points,
    price: r.price,
    expireDays: r.expire_days
  }));
}

async function getSetting(key, fallback = null) {
  const [rows] = await pool.execute("SELECT value FROM settings WHERE `key` = ?", [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  const now = new Date().toISOString();
  await pool.execute(
    `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [key, value == null ? null : String(value), now]
  );
}

module.exports = {
  initDb,
  getPool,
  PACKAGES,
  hashPassword,
  verifyPassword,
  newId,
  newToken,
  SESSION_TTL_MS,
  RESET_TTL_MS,
  createSessionToken,
  getTokenRow,
  sanitizeUser,
  getUserById,
  listPackages,
  getSetting,
  setSetting,
  purgeExpiredTokens
};
