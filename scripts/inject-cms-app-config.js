const fs = require("fs");
const path = require("path");

const htmls = [
  "landing/web/tin-tuc/admin-post-article.html",
  "landing/web/tin-tuc/admin-post-editor.html",
  "landing/web/tin-tuc/admin-post-seo.html",
  "landing/web/tin-tuc/admin-post-categories.html",
  "landing/web/tin-tuc/admin-post-media.html",
  "landing/web/tin-tuc/admin-post-trash.html",
  "landing/web/tin-tuc/preview-bai-viet.html"
];

for (const rel of htmls) {
  const f = path.join(__dirname, "..", rel);
  if (!fs.existsSync(f)) continue;
  let s = fs.readFileSync(f, "utf8");
  if (s.includes("/app-config.js")) {
    console.log("skip", rel);
    continue;
  }
  if (!s.includes("/tin-tuc/cms-api.js")) {
    console.log("nocms", rel);
    continue;
  }
  s = s.replace(
    '<script src="/tin-tuc/cms-api.js"></script>',
    '<script src="/app-config.js"></script>\n  <script src="/tin-tuc/cms-api.js"></script>'
  );
  fs.writeFileSync(f, s);
  console.log("updated", rel);
}
