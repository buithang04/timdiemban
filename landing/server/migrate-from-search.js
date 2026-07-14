/**
 * migrate-from-search.js
 * Copy dữ liệu CMS từ DB tìm kiếm (timdiemban) → findmap_news
 * Sau đó chạy: npm run purge-search-cms
 */
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");

(function loadEnv() {
  for (const p of [path.join(__dirname, ".env"), path.join(__dirname, "../../server/.env")]) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      // MYSQL_DATABASE từ server/.env là DB tìm kiếm — không ghi đè DB tin.
      if (key === "MYSQL_DATABASE") {
        if (!process.env.SEARCH_MYSQL_DATABASE) process.env.SEARCH_MYSQL_DATABASE = val;
        continue;
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
})();

const SEARCH_DB = process.env.SEARCH_MYSQL_DATABASE || "timdiemban";
const NEWS_DB = process.env.NEWS_MYSQL_DATABASE || "findmap_news";
process.env.MYSQL_DATABASE = NEWS_DB;

const SEO_KEYS = [
  "gsc_verification_meta",
  "gsc_property_url",
  "seo_site_name",
  "seo_default_description"
];

const connOpts = {
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  charset: "utf8mb4",
  multipleStatements: true
};

async function tableExists(conn, db, table) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = ? AND table_name = ?`,
    [db, table]
  );
  return Number(rows[0].c) > 0;
}

async function main() {
  console.log(`Migrate CMS: ${SEARCH_DB} → ${NEWS_DB}`);

  const root = await mysql.createConnection(connOpts);
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${NEWS_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await root.end();

  // Init schema news (cms_users, posts, …)
  process.env.MYSQL_DATABASE = NEWS_DB;
  const { initDb, getPool } = require("./db");
  await initDb();
  const news = getPool();

  const search = await mysql.createConnection({ ...connOpts, database: SEARCH_DB });

  if (!(await tableExists(search, SEARCH_DB, "posts"))) {
    console.log("Không thấy bảng posts trên DB tìm kiếm — bỏ qua copy bài viết.");
  } else {
    // Staff: editors + admin → cms_users (giữ id để khớp author_id)
    const [staff] = await search.execute(
      `SELECT id, full_name, email, password_hash, role, is_active, created_at
       FROM users WHERE role IN ('admin','editor')`
    );
    for (const u of staff) {
      await news.execute(
        `INSERT INTO cms_users (id, full_name, email, password_hash, role, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           full_name=VALUES(full_name),
           password_hash=VALUES(password_hash),
           role=VALUES(role),
           is_active=VALUES(is_active)`,
        [
          u.id,
          u.full_name || (u.role === "admin" ? "CMS Admin" : "Editor"),
          u.email,
          u.password_hash,
          u.role === "admin" ? "admin" : "editor",
          u.is_active,
          u.created_at || new Date().toISOString()
        ]
      );
    }
    console.log(`Đã đồng bộ ${staff.length} tài khoản staff → cms_users`);

    // categories
    await news.execute("SET FOREIGN_KEY_CHECKS=0");
    const [cats] = await search.execute("SELECT * FROM post_categories");
    for (const c of cats) {
      await news.execute(
        `INSERT INTO post_categories (id, name, slug, description, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description)`,
        [c.id, c.name, c.slug, c.description, c.created_at]
      );
    }
    console.log(`Đã copy ${cats.length} danh mục`);

    // posts — clear seed demo nếu đang migrate dữ liệu thật
    const [srcPosts] = await search.execute("SELECT * FROM posts");
    if (srcPosts.length) {
      await news.execute("DELETE FROM posts");
      for (const p of srcPosts) {
        await news.execute(
          `INSERT INTO posts (
            id, title, slug, excerpt, content_html, cover_image, category_id, author_id,
            status, published_at, seo_title, seo_description, focus_keyword, og_image,
            canonical_url, noindex, seo_score, view_count, created_at, updated_at,
            secondary_keywords, trashed_at, url_path
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE title=VALUES(title)`,
          [
            p.id,
            p.title,
            p.slug,
            p.excerpt,
            p.content_html,
            p.cover_image,
            p.category_id,
            p.author_id,
            p.status,
            p.published_at,
            p.seo_title,
            p.seo_description,
            p.focus_keyword,
            p.og_image,
            p.canonical_url,
            p.noindex,
            p.seo_score,
            p.view_count,
            p.created_at,
            p.updated_at,
            p.secondary_keywords ?? null,
            p.trashed_at ?? null,
            p.url_path != null ? p.url_path : "tin-tuc"
          ]
        );
      }
      // author_id không khớp cms_users → NULL
      await news.execute(`
        UPDATE posts SET author_id = NULL
        WHERE author_id IS NOT NULL
          AND author_id NOT IN (SELECT id FROM cms_users)
      `);
    }
    await news.execute("SET FOREIGN_KEY_CHECKS=1");
    console.log(`Đã copy ${srcPosts.length} bài viết`);
  }

  // SEO settings
  if (await tableExists(search, SEARCH_DB, "settings")) {
    const marks = SEO_KEYS.map(() => "?").join(",");
    const [rows] = await search.execute(
      `SELECT \`key\`, value, updated_at FROM settings WHERE \`key\` IN (${marks})`,
      SEO_KEYS
    );
    for (const r of rows) {
      await news.execute(
        `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
        [r.key, r.value, r.updated_at || new Date().toISOString()]
      );
    }
    console.log(`Đã copy ${rows.length} SEO settings`);
  }

  await search.end();
  console.log("\nOK — dữ liệu đã vào findmap_news.");
  console.log("Tiếp theo: npm run purge-search-cms  (xóa bảng CMS cũ trên timdiemban)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
