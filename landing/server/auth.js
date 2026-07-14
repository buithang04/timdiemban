/**
 * auth.js — đăng nhập CMS tin tức (tách khỏi hệ tìm kiếm)
 */
const {
  getPool,
  hashPassword,
  verifyPassword,
  newId,
  createSessionToken,
  getTokenRow,
  sanitizeUser,
  getUserById,
  purgeExpiredTokens
} = require("./db");

async function findUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return null;
  const [rows] = await getPool().execute("SELECT * FROM cms_users WHERE email = ?", [norm]);
  return rows[0] || null;
}

async function loginStaff(email, password) {
  const user = await findUserByEmail(email);
  if (!user || user.is_active === 0 || !verifyPassword(password, user.password_hash)) {
    throw new Error("Email hoặc mật khẩu không đúng");
  }
  if (user.role !== "admin" && user.role !== "editor") {
    throw new Error("Tài khoản không có quyền CMS");
  }
  const token = await createSessionToken(user.id);
  return { token, user: sanitizeUser(user) };
}

async function getStaffFromToken(token) {
  const row = await getTokenRow(token);
  if (!row || row.type !== "session") return null;
  if (row.is_active === 0) return null;
  if (row.role !== "admin" && row.role !== "editor") return null;
  return getUserById(row.user_id);
}

async function getAdminFromToken(token) {
  const user = await getStaffFromToken(token);
  if (!user || user.role !== "admin") return null;
  return user;
}

async function logoutToken(token) {
  if (!token) return;
  await getPool().execute("DELETE FROM cms_tokens WHERE token = ?", [token]);
}

async function listEditors() {
  const [rows] = await getPool().execute(
    `SELECT id, full_name, email, role, is_active, created_at
     FROM cms_users
     WHERE role = 'editor'
     ORDER BY created_at DESC`
  );
  return rows.map(sanitizeUser);
}

async function createEditor(email, password, fullName = "") {
  const norm = String(email || "").trim().toLowerCase();
  const pw = String(password || "");
  const cleanName = String(fullName || "").trim() || "Editor";
  if (!norm || !norm.includes("@")) throw new Error("Email không hợp lệ");
  if (pw.length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");
  if (await findUserByEmail(norm)) throw new Error("Email đã tồn tại");
  const id = newId("cms_ed");
  await getPool().execute(
    `INSERT INTO cms_users (id, full_name, email, password_hash, role, is_active, created_at)
     VALUES (?, ?, ?, ?, 'editor', 1, ?)`,
    [id, cleanName, norm, hashPassword(pw), new Date().toISOString()]
  );
  return getUserById(id);
}

async function setEditorActive(id, active) {
  await getPool().execute("UPDATE cms_users SET is_active = ? WHERE id = ? AND role = 'editor'", [
    active ? 1 : 0,
    id
  ]);
  return getUserById(id);
}

async function resetEditorPassword(id, password) {
  const pw = String(password || "");
  if (pw.length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");
  await getPool().execute(
    "UPDATE cms_users SET password_hash = ? WHERE id = ? AND role = 'editor'",
    [hashPassword(pw), id]
  );
  return getUserById(id);
}

module.exports = {
  loginStaff,
  getStaffFromToken,
  getAdminFromToken,
  logoutToken,
  listEditors,
  createEditor,
  setEditorActive,
  resetEditorPassword,
  purgeExpiredTokens
};
