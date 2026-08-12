/**
 * Local smoke/coverage checks for ward geo feature + key routes.
 * Usage: node scripts/verify-ward-system.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = process.env.APP_BASE || "http://127.0.0.1:3000";
const GEO_ROOT = path.join(__dirname, "..", "server", "data", "geo");
const UNITS_PATH = path.join(GEO_ROOT, "full_units.json");
const GEOJSON_ROOT = path.join(GEO_ROOT, "geojson");

function get(urlPath) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 30000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      })
      .on("error", reject);
  });
}

function titleOf(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1] : "";
}

async function main() {
  const report = { ok: [], warn: [], fail: [] };
  const pass = (msg) => report.ok.push(msg);
  const warn = (msg) => report.warn.push(msg);
  const fail = (msg) => report.fail.push(msg);

  // --- Routes ---
  const home = await get("/");
  if (home.status === 200 && /Findmap/i.test(home.body)) pass("GET / returns landing/app HTML");
  else fail(`GET / unexpected status=${home.status}`);

  const landingCss = await get("/landing/styles.css");
  if (landingCss.status === 200 && landingCss.body.includes("{")) {
    pass("GET /landing/styles.css OK");
  } else {
    fail(`GET /landing/styles.css status=${landingCss.status} (landing CSS broken)`);
  }

  const rootCss = await get("/styles.css");
  if (rootCss.status === 200) pass("GET /styles.css OK");
  // Expected 404 after serving landing only under /landing/*

  const login = await get("/login");
  if (login.status === 200 && /Đăng nhập|login/i.test(titleOf(login.body) + login.body)) {
    pass("GET /login OK");
  } else fail(`GET /login status=${login.status}`);

  const searchJs = await get("/search.js");
  if (searchJs.status === 200 && searchJs.body.includes("loadProvinces")) {
    pass("GET /search.js has ward dropdown logic");
  } else fail("search.js missing loadProvinces");

  const mapJs = await get("/map.js");
  if (mapJs.status === 200 && mapJs.body.includes("drawWardBoundary")) {
    pass("GET /map.js has drawWardBoundary");
  } else fail("map.js missing drawWardBoundary");

  // --- Geo APIs ---
  const provincesRes = await get("/api/geo/provinces");
  if (provincesRes.status !== 200) fail(`provinces API ${provincesRes.status}`);
  const provinces = JSON.parse(provincesRes.body);
  if (provinces.length >= 30) pass(`provinces API: ${provinces.length} items`);
  else fail(`provinces too few: ${provinces.length}`);

  // UTF-8 Vietnamese check
  const hn = provinces.find((p) => p.code === "01");
  if (hn && /Hà Nội|Ha Noi/i.test(hn.name + hn.fullName)) {
    pass(`UTF-8 province name OK: ${hn.fullName}`);
  } else {
    fail(`UTF-8/province name broken: ${JSON.stringify(hn)}`);
  }

  const wardsHn = JSON.parse((await get("/api/geo/wards?province_code=01")).body);
  if (Array.isArray(wardsHn) && wardsHn.length > 50) {
    pass(`HN wards: ${wardsHn.length}`);
  } else fail(`HN wards unexpected: ${wardsHn?.length}`);

  const bad = await get("/api/geo/wards");
  if (bad.status === 400) pass("wards without province_code -> 400");
  else warn(`wards without param status=${bad.status}`);

  const tayHo = await get("/api/geo/ward-boundary/00103");
  const tayHoJson = JSON.parse(tayHo.body);
  if (
    tayHo.status === 200 &&
    tayHoJson.type === "FeatureCollection" &&
    tayHoJson.features?.length === 1 &&
    tayHoJson.bbox
  ) {
    pass("Tay Ho boundary FeatureCollection + bbox OK");
  } else fail("Tay Ho boundary invalid");

  // --- Disk coverage vs full_units ---
  const units = JSON.parse(fs.readFileSync(UNITS_PATH, "utf8"));
  let diskOk = 0;
  let diskMiss = 0;
  const missSamples = [];
  for (const p of units) {
    const slug = `${p.Code}_${p.CodeName}`;
    for (const w of p.Wards || []) {
      const file = path.join(GEOJSON_ROOT, slug, "wards", `${w.Code}_${w.CodeName}.geojson`);
      if (fs.existsSync(file)) diskOk++;
      else {
        diskMiss++;
        if (missSamples.length < 12) missSamples.push(`${slug}/${w.Code}_${w.CodeName}.geojson`);
      }
    }
  }
  if (diskMiss === 0) pass(`Disk GeoJSON coverage 100%: ${diskOk} files match units`);
  else fail(`Disk missing ${diskMiss}/${diskOk + diskMiss} ward files. Samples: ${missSamples.join(", ")}`);

  // API sample: first + last ward of every province
  let apiOk = 0;
  let apiEmpty = 0;
  let apiFail = 0;
  const emptySamples = [];
  for (const p of units) {
    const list = p.Wards || [];
    if (!list.length) continue;
    const picks = [list[0], list[list.length - 1]];
    for (const w of picks) {
      const r = await get(`/api/geo/ward-boundary/${w.Code}`);
      if (r.status !== 200) {
        apiFail++;
        continue;
      }
      const j = JSON.parse(r.body);
      if (!j.features?.length) {
        apiEmpty++;
        if (emptySamples.length < 10) emptySamples.push(`${p.Code}/${w.Code} ${w.FullName}`);
      } else apiOk++;
    }
  }
  if (apiFail === 0 && apiEmpty === 0) {
    pass(`API boundary sample OK: ${apiOk} (first+last each province)`);
  } else {
    fail(`API boundary sample fail=${apiFail} empty=${apiEmpty}. Empty: ${emptySamples.join(" | ")}`);
  }

  // orphan dirs info
  const unitSlugs = new Set(units.map((p) => `${p.Code}_${p.CodeName}`));
  const dirs = fs
    .readdirSync(GEOJSON_ROOT)
    .filter((n) => fs.statSync(path.join(GEOJSON_ROOT, n)).isDirectory());
  const orphans = dirs.filter((d) => !unitSlugs.has(d));
  if (orphans.length) {
    warn(
      `${orphans.length} orphan geojson province dirs on disk (not in full_units). e.g. ${orphans
        .slice(0, 5)
        .join(", ")}`
    );
  } else pass("No orphan province dirs");

  // --- Static code smell checks ---
  const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
  if (bg.includes("trong bán kính ${params.radius}")) {
    fail('extension progress text still says "trong bán kính ${params.radius}" (null in ward mode)');
  } else pass("extension progress text no longer uses null radius phrase");

  const gridJs = fs.readFileSync(path.join(__dirname, "..", "extension", "grid.js"), "utf8");
  if (gridJs.includes("radiusKm == null") && gridJs.includes("MAX_POLYGON_GRID_CELLS")) {
    pass("extension grid.js guards null radius + caps cells at 180");
  } else {
    warn("extension grid.js may be missing null-radius guard or 180 cap");
  }

  // Large GeoJSON risk for chrome.storage / messaging
  let bigFiles = 0;
  for (const p of units) {
    const slug = `${p.Code}_${p.CodeName}`;
    for (const w of p.Wards || []) {
      const file = path.join(GEOJSON_ROOT, slug, "wards", `${w.Code}_${w.CodeName}.geojson`);
      if (!fs.existsSync(file)) continue;
      const sz = fs.statSync(file).size;
      if (sz > 500 * 1024) bigFiles++;
    }
  }
  if (bigFiles) {
    warn(
      `${bigFiles} ward GeoJSON files >500KB — storing full boundary in extension storage/messages may be heavy`
    );
  }

  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  if (/id="searchLat"|id="searchLng"|id="searchRadius"/.test(indexHtml)) {
    fail("web/index.html still has lat/lng/radius inputs");
  } else pass("web/index.html has no lat/lng/radius inputs");
  if (!/id="searchProvince"/.test(indexHtml) || !/id="searchWard"/.test(indexHtml)) {
    fail("web/index.html missing province/ward selects");
  } else pass("web/index.html has province/ward selects");

  // Print report
  console.log("\n===== VERIFY REPORT =====");
  for (const m of report.ok) console.log("OK   ", m);
  for (const m of report.warn) console.log("WARN ", m);
  for (const m of report.fail) console.log("FAIL ", m);
  console.log(
    `\nSummary: ${report.ok.length} ok, ${report.warn.length} warn, ${report.fail.length} fail`
  );
  process.exit(report.fail.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
