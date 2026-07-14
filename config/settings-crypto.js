/**
 * Mã hóa giá trị nhạy cảm trong bảng settings (AES-256-GCM).
 * Đặt SETTINGS_ENCRYPTION_KEY trong server/.env hoặc landing/server/.env
 * (chuỗi bất kỳ, hoặc 64 ký tự hex).
 */
const crypto = require("crypto");

const PREFIX = "enc1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;

const SECRET_KEY_EXACT = new Set([
  "pagespeed_api_key",
  "vietqr_api_key",
  "vietqr_client_id",
  "smtp_password"
]);

const SECRET_KEY_PREFIXES = ["winmap_site_token:", "winmap_site_push_config:"];

function isSecretSettingKey(key) {
  const k = String(key || "");
  if (SECRET_KEY_EXACT.has(k)) return true;
  return SECRET_KEY_PREFIXES.some((p) => k.startsWith(p));
}

function getKey() {
  const raw = String(process.env.SETTINGS_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function isEncrypted(stored) {
  return String(stored || "").startsWith(PREFIX);
}

function encryptSecret(plaintext) {
  const text = String(plaintext ?? "");
  if (!text) return "";
  const key = getKey();
  if (!key) {
    throw new Error("SETTINGS_ENCRYPTION_KEY chưa cấu hình — không thể lưu secret");
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

function decryptSecret(stored) {
  const text = String(stored ?? "");
  if (!text) return "";
  if (!isEncrypted(text)) return text;
  const key = getKey();
  if (!key) {
    console.error("[settings-crypto] Thiếu SETTINGS_ENCRYPTION_KEY — không giải mã được secret");
    return "";
  }
  const body = text.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(":");
  if (!ivB64 || !tagB64 || !dataB64) return "";
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[settings-crypto] Giải mã thất bại:", err.message);
    return "";
  }
}

async function migrateSecretSettings(pool) {
  if (!getKey()) {
    console.warn("[settings-crypto] Bỏ qua migrate — chưa có SETTINGS_ENCRYPTION_KEY");
    return;
  }
  const [rows] = await pool.execute("SELECT `key`, value FROM settings");
  const now = new Date().toISOString();
  let migrated = 0;
  for (const row of rows) {
    if (!isSecretSettingKey(row.key)) continue;
    const val = row.value;
    if (!val || isEncrypted(val)) continue;
    const enc = encryptSecret(val);
    await pool.execute("UPDATE settings SET value = ?, updated_at = ? WHERE `key` = ?", [
      enc,
      now,
      row.key
    ]);
    migrated++;
  }
  if (migrated > 0) {
    console.log(`[settings-crypto] Đã mã hóa ${migrated} setting(s) còn plain text`);
  }
}

module.exports = {
  isSecretSettingKey,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  migrateSecretSettings
};
