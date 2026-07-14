/**
 * purge-search-cms.js
 * Xóa bảng/settings CMS khỏi DB tìm kiếm (timdiemban) sau khi đã migrate.
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
      if (key === "MYSQL_DATABASE") {
        if (!process.env.SEARCH_MYSQL_DATABASE) process.env.SEARCH_MYSQL_DATABASE = val;
        continue;
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
})();

const SEARCH_DB = process.env.SEARCH_MYSQL_DATABASE || "timdiemban";

const SEO_KEYS = [
  "gsc_verification_meta",
  "gsc_property_url",
  "seo_site_name",
  "seo_default_description"
];

async function main() {
  const confirm = String(process.env.CONFIRM_PURGE || "").toLowerCase();
  if (confirm !== "yes") {
    console.log("Script sẽ XÓA posts / post_categories / SEO settings / editor trên DB tìm kiếm.");
    console.log("Chạy lại với: CONFIRM_PURGE=yes npm run purge-search-cms");
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: SEARCH_DB,
    charset: "utf8mb4"
  });

  console.log(`Purge CMS khỏi ${SEARCH_DB}…`);

  await conn.execute("SET FOREIGN_KEY_CHECKS=0");
  await conn.execute("DROP TABLE IF EXISTS posts");
  await conn.execute("DROP TABLE IF EXISTS post_categories");
  await conn.execute("SET FOREIGN_KEY_CHECKS=1");
  console.log("Đã DROP posts, post_categories");

  const marks = SEO_KEYS.map(() => "?").join(",");
  const [delSeo] = await conn.execute(`DELETE FROM settings WHERE \`key\` IN (${marks})`, SEO_KEYS);
  console.log(`Đã xóa SEO settings: ${delSeo.affectedRows || 0}`);

  // Xóa session + user editor (không đụng admin/user tìm kiếm)
  await conn.execute(
    `DELETE t FROM tokens t
     INNER JOIN users u ON u.id = t.user_id
     WHERE u.role = 'editor'`
  );
  const [delEd] = await conn.execute(`DELETE FROM users WHERE role = 'editor'`);
  console.log(`Đã xóa user editor: ${delEd.affectedRows || 0}`);

  await conn.end();
  console.log("Xong — DB tìm kiếm không còn dữ liệu CMS.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
