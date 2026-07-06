const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "timdiemban.db");
const LEGACY_USERS = path.join(DATA_DIR, "users.json");

const PACKAGES = [
  { id: "pkg_3000", name: "Gói 3.000 điểm", points: 3000 },
  { id: "pkg_5000", name: "Gói 5.000 điểm", points: 5000 },
  { id: "pkg_10000", name: "Gói 10.000 điểm", points: 10000 }
];

let db;

function getDb() {
  if (!db) db = openDb();
  return db;
}

function openDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  database.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      points INTEGER NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      points INTEGER NOT NULL DEFAULT 0,
      package_id TEXT REFERENCES packages(id),
      package_expires_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS package_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL REFERENCES packages(id),
      points INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_id TEXT REFERENCES users(id),
      admin_note TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_package_orders_status ON package_orders(status);
    CREATE INDEX IF NOT EXISTS idx_package_orders_user ON package_orders(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  seedPackages(database);
  seedDefaultAdmin(database);
  migrateUsersSchema(database);
  migrateLegacyUsers(database);

  return database;
}

function migrateUsersSchema(database) {
  const cols = database.pragma("table_info(users)");
  if (!cols.some((c) => c.name === "package_expires_at")) {
    database.exec("ALTER TABLE users ADD COLUMN package_expires_at TEXT");
  }
  const rows = database
    .prepare(
      `SELECT u.id, u.created_at, p.expire_days
       FROM users u
       INNER JOIN packages p ON p.id = u.package_id
       WHERE u.package_expires_at IS NULL`
    )
    .all();
  const upd = database.prepare("UPDATE users SET package_expires_at = ? WHERE id = ?");
  for (const r of rows) {
    const base = new Date(r.created_at);
    const exp = new Date(base);
    exp.setDate(exp.getDate() + Math.max(1, Number(r.expire_days) || 365));
    upd.run(exp.toISOString(), r.id);
  }
}

function seedPackages(database) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO packages (id, name, points, is_active, created_at)
    VALUES (@id, @name, @points, 1, @created_at)
  `);
  const now = new Date().toISOString();
  for (const pkg of PACKAGES) {
    insert.run({ ...pkg, created_at: now });
  }
}

function seedDefaultAdmin(database) {
  const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD;
  const email = envEmail || "admin@timdiemban.local";
  const password = envPassword || "Admin@123456";
  const existing = database.prepare("SELECT id, email FROM users WHERE role = 'admin' LIMIT 1").get();

  if (existing) {
    if (envEmail && envEmail !== existing.email) {
      const taken = database.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(envEmail, existing.id);
      if (taken) throw new Error(`ADMIN_EMAIL "${envEmail}" đã được dùng bởi tài khoản khác`);
      database.prepare("UPDATE users SET email = ? WHERE id = ?").run(envEmail, existing.id);
      console.log(`[DB] Đã đổi email admin → ${envEmail}`);
    }
    if (envPassword) {
      database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(envPassword), existing.id);
      console.log("[DB] Đã cập nhật mật khẩu admin từ biến môi trường ADMIN_PASSWORD");
    }
    return;
  }

  const id = `u_admin_${crypto.randomBytes(4).toString("hex")}`;
  database
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, points, is_active, created_at)
       VALUES (?, ?, ?, 'admin', 0, 1, ?)`
    )
    .run(id, email, hashPassword(password), new Date().toISOString());

  console.log(`[DB] Tài khoản admin mặc định: ${email} / ${password}`);
  console.log("[DB] Đổi mật khẩu ngay sau lần đăng nhập đầu.");
}

function migrateLegacyUsers(database) {
  if (!fs.existsSync(LEGACY_USERS)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_USERS, "utf8"));
    if (!Array.isArray(legacy) || !legacy.length) return;

    const insert = database.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, role, points, is_active, created_at)
      VALUES (?, ?, ?, 'user', ?, 1, ?)
    `);
    let migrated = 0;
    for (const u of legacy) {
      if (!u.email || !u.passwordHash) continue;
      const r = insert.run(
        u.id || `u_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        String(u.email).trim().toLowerCase(),
        u.passwordHash,
        Math.max(0, Math.floor(Number(u.points) || 0)),
        u.createdAt || new Date().toISOString()
      );
      if (r.changes) migrated++;
    }
    if (migrated > 0) {
      fs.renameSync(LEGACY_USERS, LEGACY_USERS + ".migrated.bak");
      console.log(`[DB] Đã chuyển ${migrated} user từ users.json → SQLite`);
    }
  } catch (err) {
    console.warn("[DB] migrate users.json:", err.message);
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
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function newId(prefix = "u") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function purgeExpiredTokens(database) {
  database.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(Date.now());
}

function createSessionToken(database, userId) {
  purgeExpiredTokens(database);
  const token = newToken();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO tokens (token, type, user_id, expires_at, created_at)
       VALUES (?, 'session', ?, ?, ?)`
    )
    .run(token, userId, now + SESSION_TTL_MS, new Date(now).toISOString());
  return token;
}

function getTokenRow(token) {
  if (!token) return null;
  const database = getDb();
  purgeExpiredTokens(database);
  return database
    .prepare(
      `SELECT t.*, u.email, u.role, u.points, u.is_active, u.package_id, u.created_at AS user_created_at,
              p.name AS package_name
       FROM tokens t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN packages p ON p.id = u.package_id
       WHERE t.token = ? AND t.expires_at > ?`
    )
    .get(token, Date.now());
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

function getUserById(id) {
  const row = getDb()
    .prepare(
      `SELECT u.*, p.name AS package_name
       FROM users u
       LEFT JOIN packages p ON p.id = u.package_id
       WHERE u.id = ?`
    )
    .get(id);
  return row ? sanitizeUser(row) : null;
}

function listPackages() {
  return getDb()
    .prepare("SELECT id, name, points FROM packages WHERE is_active = 1 ORDER BY points ASC")
    .all();
}

function getSetting(key, fallback = null) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value == null ? null : String(value), new Date().toISOString());
}

module.exports = {
  getDb,
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
