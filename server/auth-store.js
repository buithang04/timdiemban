const {
  getDb,
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
} = require("./db");

const DEFAULT_POINTS = 0;

function computePackageExpiresAt(expireDays) {
  const days = Math.max(1, Math.floor(Number(expireDays) || 365));
  const exp = new Date();
  exp.setDate(exp.getDate() + days);
  return exp.toISOString();
}

function rowToUser(row) {
  if (!row) return null;
  return sanitizeUser(row);
}

function findUserByEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return null;
  return getDb().prepare("SELECT * FROM users WHERE email = ?").get(norm) || null;
}

function loginUser(email, password) {
  const user = findUserByEmail(email);
  if (!user || user.is_active === 0 || !verifyPassword(password, user.password_hash)) {
    throw new Error("Email hoặc mật khẩu không đúng");
  }
  if (user.role === "admin") {
    throw new Error("Tài khoản admin — đăng nhập tại trang quản trị");
  }
  const token = createSessionToken(getDb(), user.id);
  return { token, user: rowToUser(user) };
}

function loginAdmin(email, password) {
  const user = findUserByEmail(email);
  if (!user || user.is_active === 0 || user.role !== "admin") {
    throw new Error("Email hoặc mật khẩu admin không đúng");
  }
  if (!verifyPassword(password, user.password_hash)) {
    throw new Error("Email hoặc mật khẩu admin không đúng");
  }
  const token = createSessionToken(getDb(), user.id);
  return { token, user: rowToUser(user) };
}

function getUserFromToken(token) {
  const row = getTokenRow(token);
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

function getAdminFromToken(token) {
  const user = getUserFromToken(token);
  if (!user || user.role !== "admin") return null;
  return user;
}

function createUser(email, password, options = {}) {
  const norm = String(email || "").trim().toLowerCase();
  const pw = String(password || "");
  const { packageId = null, points = null, role = "user" } = options;

  if (!norm || !norm.includes("@")) throw new Error("Email không hợp lệ");
  if (pw.length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");
  if (findUserByEmail(norm)) throw new Error("Email đã tồn tại");

  const database = getDb();
  let initialPoints = DEFAULT_POINTS;
  let assignedPackage = null;
  let packageExpiresAt = null;

  if (packageId) {
    const pkg = database.prepare("SELECT * FROM packages WHERE id = ? AND is_active = 1").get(packageId);
    if (!pkg) throw new Error("Gói điểm không hợp lệ");
    initialPoints = pkg.points;
    assignedPackage = pkg.id;
    packageExpiresAt = computePackageExpiresAt(pkg.expire_days);
  } else if (points != null) {
    initialPoints = Math.max(0, Math.floor(Number(points) || 0));
  }

  const id = newId("u");
  database
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, points, package_id, package_expires_at, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      id,
      norm,
      hashPassword(pw),
      role === "admin" ? "admin" : "user",
      initialPoints,
      assignedPackage,
      packageExpiresAt,
      new Date().toISOString()
    );

  return getUserById(id);
}

function requestPasswordReset(email) {
  const user = findUserByEmail(email);
  if (!user || user.role === "admin") {
    return { ok: true, message: "Nếu email tồn tại, liên kết đặt lại mật khẩu đã được tạo." };
  }

  const database = getDb();
  purgeExpiredTokens(database);
  database.prepare("DELETE FROM tokens WHERE user_id = ? AND type = 'password_reset'").run(user.id);

  const token = newToken();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO tokens (token, type, user_id, expires_at, created_at)
       VALUES (?, 'password_reset', ?, ?, ?)`
    )
    .run(token, user.id, now + RESET_TTL_MS, new Date(now).toISOString());

  return {
    ok: true,
    token,
    expiresAt: now + RESET_TTL_MS,
    message: "Liên kết đặt lại mật khẩu đã được tạo (hiệu lực 1 giờ)."
  };
}

function resetPasswordWithToken(token, newPassword) {
  const pw = String(newPassword || "");
  if (pw.length < 6) throw new Error("Mật khẩu mới tối thiểu 6 ký tự");

  const database = getDb();
  const row = database
    .prepare(`SELECT * FROM tokens WHERE token = ? AND type = 'password_reset' AND expires_at > ?`)
    .get(token, Date.now());
  if (!row) throw new Error("Liên kết không hợp lệ hoặc đã hết hạn");

  database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(pw), row.user_id);
  database.prepare("DELETE FROM tokens WHERE token = ?").run(token);

  return { ok: true, message: "Đã đặt lại mật khẩu. Vui lòng đăng nhập lại." };
}

function adminResetPassword(email, newPassword) {
  const norm = String(email || "").trim().toLowerCase();
  const pw = String(newPassword || "");
  if (pw.length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");

  const user = findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");

  getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(pw), user.id);
  return { ok: true, message: `Đã đặt lại mật khẩu cho ${norm}` };
}

function listUsers() {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT u.id, u.email, u.role, u.points, u.package_id, u.package_expires_at,
              u.is_active, u.created_at,
              p.name AS package_name, p.points AS package_points, p.expire_days
       FROM users u
       LEFT JOIN packages p ON p.id = u.package_id
       WHERE u.role = 'user'
       ORDER BY u.created_at DESC`
    )
    .all();

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

function addPoints(email, amount) {
  const norm = String(email || "").trim().toLowerCase();
  const delta = Math.floor(Number(amount));
  if (!norm || !delta) throw new Error("Số điểm không hợp lệ");

  const user = findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");

  const database = getDb();
  const next = Math.max(0, (user.points || 0) + delta);
  database.prepare("UPDATE users SET points = ? WHERE id = ?").run(next, user.id);
  return getUserById(user.id);
}

function applyPackageToUser(user, packageId) {
  const database = getDb();
  const pkg = database.prepare("SELECT * FROM packages WHERE id = ? AND is_active = 1").get(packageId);
  if (!pkg) throw new Error("Gói điểm không hợp lệ");

  const next = (user.points || 0) + pkg.points;
  const packageExpiresAt = computePackageExpiresAt(pkg.expire_days);
  database
    .prepare("UPDATE users SET points = ?, package_id = ?, package_expires_at = ? WHERE id = ?")
    .run(next, pkg.id, packageExpiresAt, user.id);

  return {
    user: getUserById(user.id),
    package: { id: pkg.id, name: pkg.name, points: pkg.points },
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
    status: row.status,
    adminNote: row.admin_note || null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null
  };
}

function getPackageOrderById(orderId) {
  const row = getDb()
    .prepare(
      `SELECT o.*, u.email AS user_email, p.name AS package_name
       FROM package_orders o
       JOIN users u ON u.id = o.user_id
       JOIN packages p ON p.id = o.package_id
       WHERE o.id = ?`
    )
    .get(orderId);
  return rowToPackageOrder(row);
}

function listPackageOrders({ status = null, userId = null } = {}) {
  const database = getDb();
  let sql = `
    SELECT o.*, u.email AS user_email, p.name AS package_name
    FROM package_orders o
    JOIN users u ON u.id = o.user_id
    JOIN packages p ON p.id = o.package_id
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== "all") {
    sql += " AND o.status = ?";
    params.push(status);
  }
  if (userId) {
    sql += " AND o.user_id = ?";
    params.push(userId);
  }
  sql += " ORDER BY o.created_at DESC";
  return database.prepare(sql).all(...params).map(rowToPackageOrder);
}

/** User gửi yêu cầu mua gói — chờ admin duyệt mới cộng điểm */
function requestPackagePurchase(userId, packageId) {
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("Tài khoản không tồn tại");
  if (user.is_active === 0) throw new Error("Tài khoản đã bị khóa");
  if (user.role === "admin") throw new Error("Tài khoản admin không mua gói tại đây");

  const pkg = database.prepare("SELECT * FROM packages WHERE id = ? AND is_active = 1").get(packageId);
  if (!pkg) throw new Error("Gói điểm không hợp lệ");

  const pending = database
    .prepare("SELECT id FROM package_orders WHERE user_id = ? AND status = 'pending' LIMIT 1")
    .get(userId);
  if (pending) throw new Error("Bạn đã có yêu cầu mua gói đang chờ admin duyệt");

  const orderId = newId("ord");
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO package_orders (id, user_id, package_id, points, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .run(orderId, userId, pkg.id, pkg.points, now);

  const order = getPackageOrderById(orderId);
  return {
    order,
    user: getUserById(userId),
    message: `Đã gửi yêu cầu mua ${pkg.name} (+${pkg.points.toLocaleString("vi-VN")} điểm) — chờ admin duyệt`
  };
}

function approvePackageOrder(orderId, adminId) {
  const database = getDb();
  const order = database
    .prepare("SELECT * FROM package_orders WHERE id = ? AND status = 'pending'")
    .get(orderId);
  if (!order) throw new Error("Không tìm thấy đơn chờ duyệt");

  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(order.user_id);
  if (!user) throw new Error("Tài khoản không tồn tại");
  if (user.is_active === 0) throw new Error("Tài khoản user đã bị khóa — không thể duyệt");

  let applied;
  const txn = database.transaction(() => {
    applied = applyPackageToUser(user, order.package_id);
    database
      .prepare(
        `UPDATE package_orders
         SET status = 'approved', admin_id = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(adminId, new Date().toISOString(), orderId);
  });
  txn();

  const updatedOrder = getPackageOrderById(orderId);
  return {
    order: updatedOrder,
    user: applied.user,
    package: applied.package,
    message: `Đã duyệt — cộng ${applied.pointsAdded.toLocaleString("vi-VN")} điểm cho ${user.email} (tổng ${applied.totalPoints.toLocaleString("vi-VN")})`
  };
}

function rejectPackageOrder(orderId, adminId, note) {
  const database = getDb();
  const order = database
    .prepare("SELECT * FROM package_orders WHERE id = ? AND status = 'pending'")
    .get(orderId);
  if (!order) throw new Error("Không tìm thấy đơn chờ duyệt");

  const user = database.prepare("SELECT email FROM users WHERE id = ?").get(order.user_id);
  const adminNote = String(note || "").trim() || null;

  database
    .prepare(
      `UPDATE package_orders
       SET status = 'rejected', admin_id = ?, admin_note = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(adminId, adminNote, new Date().toISOString(), orderId);

  const updatedOrder = getPackageOrderById(orderId);
  return {
    order: updatedOrder,
    message: `Đã từ chối yêu cầu mua gói của ${user?.email || "user"}`
  };
}

function assignPackage(email, packageId) {
  const norm = String(email || "").trim().toLowerCase();
  const user = findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");
  const applied = applyPackageToUser(user, packageId);
  return {
    user: applied.user,
    package: applied.package,
    message: `Đã nạp gói ${applied.package.name} (+${applied.pointsAdded.toLocaleString("vi-VN")} điểm) cho ${norm} — tổng ${applied.totalPoints.toLocaleString("vi-VN")} điểm`
  };
}

function setUserActive(email, isActive) {
  const norm = String(email || "").trim().toLowerCase();
  const user = findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");
  if (user.role === "admin") throw new Error("Không thể khóa tài khoản admin");

  getDb().prepare("UPDATE users SET is_active = ? WHERE id = ?").run(isActive ? 1 : 0, user.id);
  return getUserById(user.id);
}

function setUserPoints(email, points) {
  const norm = String(email || "").trim().toLowerCase();
  const user = findUserByEmail(norm);
  if (!user) throw new Error("Không tìm thấy tài khoản");

  const next = Math.max(0, Math.floor(Number(points) || 0));
  getDb().prepare("UPDATE users SET points = ? WHERE id = ?").run(next, user.id);
  return getUserById(user.id);
}

/** Chỉ trừ điểm cho kết quả có số điện thoại hợp lệ */
function chargePoints(userId, phoneCount) {
  const count = Math.max(0, Math.floor(Number(phoneCount) || 0));
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("Tài khoản không tồn tại");
  if (user.is_active === 0) throw new Error("Tài khoản đã bị khóa");

  const available = user.points || 0;
  const charged = Math.min(available, count);
  const remaining = available - charged;

  database.prepare("UPDATE users SET points = ? WHERE id = ?").run(remaining, userId);

  return {
    user: getUserById(userId),
    charged,
    allowedCount: charged,
    phoneCount: count,
    totalFound: count,
    remaining,
    chargeRule: "phone_only"
  };
}

function logoutToken(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM tokens WHERE token = ?").run(token);
}

function deletePackageOrder(orderId) {
  const database = getDb();
  const order = database.prepare("SELECT * FROM package_orders WHERE id = ?").get(orderId);
  if (!order) throw new Error("Không tìm thấy đơn");
  database.prepare("DELETE FROM package_orders WHERE id = ?").run(orderId);
  return { message: "Đã xóa yêu cầu mua gói" };
}

function cancelPackageOrder(orderId, userId) {
  const database = getDb();
  const order = database
    .prepare("SELECT * FROM package_orders WHERE id = ? AND user_id = ? AND status = 'pending'")
    .get(orderId, userId);
  if (!order) throw new Error("Không tìm thấy đơn chờ thanh toán");

  database
    .prepare(
      `UPDATE package_orders SET status = 'cancelled', reviewed_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(new Date().toISOString(), orderId);

  return {
    order: getPackageOrderById(orderId),
    message: "Đã hủy đơn — bạn có thể chọn gói khác"
  };
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
  listPackageOrders,
  approvePackageOrder,
  rejectPackageOrder,
  deletePackageOrder,
  cancelPackageOrder,
  setUserActive,
  setUserPoints,
  chargePoints
};
