/**
 * auth-store-mysql.js — async version of auth-store.js for MySQL.
 */
const {
  getPool,
  hashPassword,
  verifyPassword,
  newId,
  newToken,
  RESET_TTL_MS,
  createSessionToken,
  getTokenRow,
  sanitizeUser,
  getUserById,
  listPackages,
  purgeExpiredTokens
} = require("./db-mysql");

const DEFAULT_POINTS = 0;

function computePackageExpiresAt(expireDays) {
  const days = Math.max(1, Math.floor(Number(expireDays) || 365));
  const exp = new Date();
  exp.setDate(exp.getDate() + days);
  return exp.toISOString();
}

async function findUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return null;
  const [rows] = await getPool().execute("SELECT * FROM users WHERE email = ?", [norm]);
  return rows[0] || null;
}

async function loginUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user || user.is_active === 0 || !verifyPassword(password, user.password_hash)) {
    throw new Error("Email hoặc mật khẩu không đúng");
  }
  if (user.role === "admin") {
    throw new Error("Tài khoản admin — đăng nhập tại trang quản trị");
  }
  const token = await createSessionToken(user.id);
  return { token, user: sanitizeUser(user) };
}

async function loginAdmin(email, password) {
  const user = await findUserByEmail(email);
  if (!user || user.is_active === 0 || user.role !== "admin") {
    throw new Error("Email hoặc mật khẩu admin không đúng");
  }
  if (!verifyPassword(password, user.password_hash)) {
    throw new Error("Email hoặc mật khẩu admin không đúng");
  }
  const token = await createSessionToken(user.id);
  return { token, user: sanitizeUser(user) };
}

async function getUserFromToken(token) {
  const row = await getTokenRow(token);
  if (!row || row.type !== "session") return null;
  if (row.is_active === 0) return null;
  return {
    id: row.user_id,
    email: row.email,
    role: row.role,
    points: row.points ?? 0,
    packageId: row.package_id || null,
    packageName: row.package_name || null,
    isActive: true,
    createdAt: row.user_created_at
  };
}

async function getAdminFromToken(token) {
  const user = await getUserFromToken(token);
  if (!user || user.role !== "admin") return null;
  return user;
}

async function createUser(email, password, options = {}) {
  const norm = String(email || "").trim().toLowerCase();
  const pw = String(password || "");
  const { packageId = null, points = null, role = "user" } = options;

  if (!norm || !norm.includes("@")) throw new Error("Email không hợp lệ");
  if (pw.length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");
  if (await findUserByEmail(norm)) throw new Error("Email đã tồn tại");

  const pool = getPool();
  let initialPoints = DEFAULT_POINTS;
  let assignedPackage = null;
  let packageExpiresAt = null;

  if (packageId) {
    const [pkgRows] = await pool.execute(
      "SELECT * FROM packages WHERE id = ? AND is_active = 1", [packageId]
    );
    if (!pkgRows[0]) throw new Error("Gói điểm không hợp lệ");
    initialPoints = pkgRows[0].points;
    assignedPackage = pkgRows[0].id;
    packageExpiresAt = computePackageExpiresAt(pkgRows[0].expire_days);
  } else if (points != null) {
    initialPoints = Math.max(0, Math.floor(Number(points) || 0));
  }

  const id = newId("u");
  await pool.execute(
    `INSERT INTO users (id, email, password_hash, role, points, package_id, package_expires_at, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, norm, hashPassword(pw), role === "admin" ? "admin" : "user",
     initialPoints, assignedPackage, packageExpiresAt, new Date().toISOString()]
  );
  return getUserById(id);
}

async function requestPasswordReset(email) {
  const user = await findUserByEmail(email);
  if (!user || user.role === "admin") {
    return { ok: true, message: "Nếu email tồn tại, liên kết đặt lại mật khẩu đã được tạo." };
  }

  const pool = getPool();
  await purgeExpiredTokens();
  await pool.execute(
    "DELETE FROM tokens WHERE user_id = ? AND type = 'password_reset'", [user.id]
  );

  const token = newToken();
  const now = Date.now();
  await pool.execute(
    `INSERT INTO tokens (token, type, user_id, expires_at, created_at) VALUES (?, 'password_reset', ?, ?, ?)`,
    [token, user.id, now + RESET_TTL_MS, new Date(now).toISOString()]
  );

  return {
    ok: true,
    token,
    expiresAt: now + RESET_TTL_MS,
    message: "Liên kết đặt lại mật khẩu đã được tạo (hiệu lực 1 giờ)."
  };
}

async function resetPasswordWithToken(token, newPassword) {
  const pw = String(newPassword || "");
  if (pw.length < 6) throw new Error("Mật khẩu mới tối thiểu 6 ký tự");

  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM tokens WHERE token = ? AND type = 'password_reset' AND expires_at > ?",
    [token, Date.now()]
  );
  if (!rows[0]) throw new Error("Liên kết không hợp lệ hoặc đã hết hạn");

  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?",
    [hashPassword(pw), rows[0].user_id]);
  await pool.execute("DELETE FROM tokens WHERE token = ?", [token]);

  return { ok: true, message: "Đã đặt lại mật khẩu. Vui lòng đăng nhập lại." };
}

async function adminResetPassword(email, newPassword) {
  const norm = String(email || "").trim().toLowerCase();
  const pw = String(newPassword || "");
  if (pw.length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");

  const user = await findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");

  await getPool().execute("UPDATE users SET password_hash = ? WHERE id = ?",
    [hashPassword(pw), user.id]);
  return { ok: true, message: `Đã đặt lại mật khẩu cho ${norm}` };
}

async function listUsers() {
  const [rows] = await getPool().execute(
    `SELECT u.id, u.email, u.role, u.points, u.package_id, u.package_expires_at,
            u.is_active, u.created_at,
            p.name AS package_name, p.points AS package_points, p.expire_days
     FROM users u
     LEFT JOIN packages p ON p.id = u.package_id
     WHERE u.role = 'user'
     ORDER BY u.created_at DESC`
  );
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    points: u.points,
    packageId: u.package_id,
    packageName: u.package_name || null,
    packageExpiresAt: u.package_expires_at || null,
    packageExpireDays: u.expire_days ?? null,
    isActive: u.is_active !== 0,
    createdAt: u.created_at
  }));
}

async function addPoints(email, amount) {
  const norm = String(email || "").trim().toLowerCase();
  const delta = Math.floor(Number(amount));
  if (!norm || !delta) throw new Error("Số điểm không hợp lệ");

  const user = await findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");

  const next = Math.max(0, (user.points || 0) + delta);
  await getPool().execute("UPDATE users SET points = ? WHERE id = ?", [next, user.id]);
  return getUserById(user.id);
}

async function applyPackageToUser(user, packageId) {
  const pool = getPool();
  const [pkgRows] = await pool.execute(
    "SELECT * FROM packages WHERE id = ? AND is_active = 1", [packageId]
  );
  if (!pkgRows[0]) throw new Error("Gói điểm không hợp lệ");
  const pkg = pkgRows[0];

  const next = (user.points || 0) + pkg.points;
  const packageExpiresAt = computePackageExpiresAt(pkg.expire_days);
  await pool.execute(
    "UPDATE users SET points = ?, package_id = ?, package_expires_at = ? WHERE id = ?",
    [next, pkg.id, packageExpiresAt, user.id]
  );

  return {
    user: await getUserById(user.id),
    package: { id: pkg.id, name: pkg.name, points: pkg.points, price: pkg.price },
    pointsAdded: pkg.points,
    totalPoints: next
  };
}

function rowToPackageOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    packageId: row.package_id,
    packageName: row.package_name,
    points: row.points,
    paymentAmount: row.payment_amount || 0,
    paymentConfirmed: row.payment_confirmed === 1,
    paymentConfirmedAt: row.payment_confirmed_at || null,
    status: row.status,
    adminNote: row.admin_note || null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null
  };
}

async function getPackageOrderById(orderId) {
  const [rows] = await getPool().execute(
    `SELECT o.*, u.email AS user_email, p.name AS package_name
     FROM package_orders o
     JOIN users u ON u.id = o.user_id
     JOIN packages p ON p.id = o.package_id
     WHERE o.id = ?`,
    [orderId]
  );
  return rowToPackageOrder(rows[0]);
}

async function listPackageOrders({ status = null, userId = null } = {}) {
  let sql = `
    SELECT o.*, u.email AS user_email, p.name AS package_name
    FROM package_orders o
    JOIN users u ON u.id = o.user_id
    JOIN packages p ON p.id = o.package_id
    WHERE 1=1
  `;
  const params = [];
  // status="all" → no filter; otherwise filter by status
  if (status && status !== "all") { sql += " AND o.status = ?"; params.push(status); }
  if (userId) { sql += " AND o.user_id = ?"; params.push(userId); }
  sql += " ORDER BY o.created_at DESC";
  const [rows] = await getPool().execute(sql, params);
  return rows.map(rowToPackageOrder);
}

async function deletePackageOrder(orderId) {
  const pool = getPool();
  const [rows] = await pool.execute("SELECT * FROM package_orders WHERE id = ?", [orderId]);
  if (!rows[0]) throw new Error("Không tìm thấy đơn");
  await pool.execute("DELETE FROM package_orders WHERE id = ?", [orderId]);
  return { message: "Đã xóa yêu cầu mua gói" };
}

async function cancelPackageOrder(orderId, userId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM package_orders WHERE id = ? AND user_id = ? AND status = 'pending'",
    [orderId, userId]
  );
  if (!rows[0]) throw new Error("Không tìm thấy đơn chờ thanh toán");

  await pool.execute(
    `UPDATE package_orders SET status = 'cancelled', reviewed_at = ?
     WHERE id = ? AND status = 'pending'`,
    [new Date().toISOString(), orderId]
  );

  return {
    order: await getPackageOrderById(orderId),
    message: "Đã hủy đơn — bạn có thể chọn gói khác"
  };
}

async function requestPackagePurchase(userId, packageId) {
  const pool = getPool();
  const [userRows] = await pool.execute("SELECT * FROM users WHERE id = ?", [userId]);
  const user = userRows[0];
  if (!user) throw new Error("Tài khoản không tồn tại");
  if (user.is_active === 0) throw new Error("Tài khoản đã bị khóa");
  if (user.role === "admin") throw new Error("Tài khoản admin không mua gói tại đây");

  const [pkgRows] = await pool.execute(
    "SELECT * FROM packages WHERE id = ? AND is_active = 1", [packageId]
  );
  if (!pkgRows[0]) throw new Error("Gói điểm không hợp lệ");
  const pkg = pkgRows[0];

  const [pendingRows] = await pool.execute(
    "SELECT id FROM package_orders WHERE user_id = ? AND status = 'pending' LIMIT 1", [userId]
  );
  if (pendingRows.length) throw new Error("Bạn đã có yêu cầu mua gói đang chờ admin duyệt");

  const orderId = newId("ord");
  const now = new Date().toISOString();
  await pool.execute(
    `INSERT INTO package_orders (id, user_id, package_id, points, payment_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [orderId, userId, pkg.id, pkg.points, pkg.price || 0, now]
  );

  const order = await getPackageOrderById(orderId);
  return {
    order,
    user: await getUserById(userId),
    message: `Đã gửi yêu cầu mua ${pkg.name} (+${pkg.points.toLocaleString("vi-VN")} điểm) — vui lòng thanh toán`
  };
}

async function confirmPayment(orderId, userId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM package_orders WHERE id = ? AND user_id = ? AND status = 'pending'",
    [orderId, userId]
  );
  if (!rows[0]) throw new Error("Không tìm thấy đơn hàng");
  if (rows[0].payment_confirmed) throw new Error("Đã xác nhận thanh toán trước đó");

  const now = new Date().toISOString();
  await pool.execute(
    "UPDATE package_orders SET payment_confirmed = 1, payment_confirmed_at = ? WHERE id = ?",
    [now, orderId]
  );
  return {
    order: await getPackageOrderById(orderId),
    message: "Đã xác nhận — admin sẽ duyệt và cộng điểm sớm"
  };
}

async function approvePackageOrder(orderId, adminId) {
  const pool = getPool();
  const [orderRows] = await pool.execute(
    "SELECT * FROM package_orders WHERE id = ? AND status = 'pending'", [orderId]
  );
  if (!orderRows[0]) throw new Error("Không tìm thấy đơn chờ duyệt");
  const order = orderRows[0];

  const [userRows] = await pool.execute("SELECT * FROM users WHERE id = ?", [order.user_id]);
  const user = userRows[0];
  if (!user) throw new Error("Tài khoản không tồn tại");
  if (user.is_active === 0) throw new Error("Tài khoản user đã bị khóa — không thể duyệt");

  const applied = await applyPackageToUser(user, order.package_id);
  await pool.execute(
    `UPDATE package_orders SET status = 'approved', admin_id = ?, reviewed_at = ?
     WHERE id = ? AND status = 'pending'`,
    [adminId, new Date().toISOString(), orderId]
  );

  return {
    order: await getPackageOrderById(orderId),
    user: applied.user,
    package: applied.package,
    message: `Đã duyệt — cộng ${applied.pointsAdded.toLocaleString("vi-VN")} điểm cho ${user.email} (tổng ${applied.totalPoints.toLocaleString("vi-VN")})`
  };
}

async function rejectPackageOrder(orderId, adminId, note) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM package_orders WHERE id = ? AND status = 'pending'", [orderId]
  );
  if (!rows[0]) throw new Error("Không tìm thấy đơn chờ duyệt");

  const [userRows] = await pool.execute("SELECT email FROM users WHERE id = ?", [rows[0].user_id]);
  const adminNote = String(note || "").trim() || null;

  await pool.execute(
    `UPDATE package_orders SET status = 'rejected', admin_id = ?, admin_note = ?, reviewed_at = ?
     WHERE id = ? AND status = 'pending'`,
    [adminId, adminNote, new Date().toISOString(), orderId]
  );

  return {
    order: await getPackageOrderById(orderId),
    message: `Đã từ chối yêu cầu mua gói của ${userRows[0]?.email || "user"}`
  };
}

async function assignPackage(email, packageId) {
  const norm = String(email || "").trim().toLowerCase();
  const user = await findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");
  const applied = await applyPackageToUser(user, packageId);
  return {
    user: applied.user,
    package: applied.package,
    message: `Đã nạp gói ${applied.package.name} (+${applied.pointsAdded.toLocaleString("vi-VN")} điểm) cho ${norm} — tổng ${applied.totalPoints.toLocaleString("vi-VN")} điểm`
  };
}

async function setUserActive(email, isActive) {
  const norm = String(email || "").trim().toLowerCase();
  const user = await findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");
  if (user.role === "admin") throw new Error("Không thể khóa tài khoản admin");

  await getPool().execute("UPDATE users SET is_active = ? WHERE id = ?",
    [isActive ? 1 : 0, user.id]);
  return getUserById(user.id);
}

async function setUserPoints(email, points) {
  const norm = String(email || "").trim().toLowerCase();
  const user = await findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");

  const next = Math.max(0, Math.floor(Number(points) || 0));
  await getPool().execute("UPDATE users SET points = ? WHERE id = ?", [next, user.id]);
  return getUserById(user.id);
}

async function chargePoints(userId, phoneCount) {
  const count = Math.max(0, Math.floor(Number(phoneCount) || 0));
  const pool = getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE id = ?", [userId]);
  const user = rows[0];
  if (!user) throw new Error("Tài khoản không tồn tại");
  if (user.is_active === 0) throw new Error("Tài khoản đã bị khóa");

  const available = user.points || 0;
  const charged = Math.min(available, count);
  const remaining = available - charged;

  await pool.execute("UPDATE users SET points = ? WHERE id = ?", [remaining, userId]);
  return {
    user: await getUserById(userId),
    charged,
    allowedCount: charged,
    phoneCount: count,
    totalFound: count,
    remaining,
    chargeRule: "phone_only"
  };
}

async function logoutToken(token) {
  if (!token) return;
  await getPool().execute("DELETE FROM tokens WHERE token = ?", [token]);
}

module.exports = {
  DEFAULT_POINTS,
  listPackages,
  createUser,
  loginUser,
  loginAdmin,
  getUserFromToken,
  getAdminFromToken,
  logoutToken,
  requestPasswordReset,
  resetPasswordWithToken,
  adminResetPassword,
  listUsers,
  addPoints,
  assignPackage,
  requestPackagePurchase,
  confirmPayment,
  listPackageOrders,
  getPackageOrderById,
  approvePackageOrder,
  rejectPackageOrder,
  deletePackageOrder,
  cancelPackageOrder,
  setUserActive,
  setUserPoints,
  chargePoints
};
