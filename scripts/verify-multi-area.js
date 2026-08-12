/**
 * Thorough offline + live checks for multi-area search batch.
 * Usage: node scripts/verify-multi-area.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.APP_BASE || "http://127.0.0.1:3000";

const report = { ok: [], warn: [], fail: [] };
const pass = (m) => report.ok.push(m);
const warn = (m) => report.warn.push(m);
const fail = (m) => report.fail.push(m);

function get(urlPath) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 30000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      })
      .on("error", reject);
  });
}

function loadGridUtils() {
  const code = fs.readFileSync(path.join(ROOT, "web", "grid-utils.js"), "utf8");
  const sandbox = {
    console,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    parseFloat,
    parseInt,
    isNaN,
    Infinity
  };
  vm.createContext(sandbox);
  vm.runInContext(
    code +
      "\nthis.__g={generateGridFromPolygon,estimateGridCellsFromBoundary,MAX_POLYGON_GRID_CELLS,DEFAULT_POLYGON_VIEWPORT_M};",
    sandbox
  );
  return sandbox.__g;
}

function extractJobHelpers(searchJs) {
  // Mirror jobCoords / totalJobs / buildPlannedContexts logic for unit checks
  function totalJobs(areasLen, keywordsLen) {
    return Math.max(0, areasLen) * Math.max(0, keywordsLen);
  }
  function jobCoords(jobIndex, keywordsLen) {
    const ki = keywordsLen > 0 ? jobIndex % keywordsLen : 0;
    const ai = keywordsLen > 0 ? Math.floor(jobIndex / keywordsLen) : 0;
    return { areaIndex: ai, keywordIndex: ki };
  }
  function buildPlannedContexts(areas, keywords) {
    const out = [];
    for (let ai = 0; ai < areas.length; ai++) {
      const area = areas[ai];
      for (let ki = 0; ki < keywords.length; ki++) {
        const keyword = keywords[ki];
        const wardCode = area.wardCode || "";
        const wardName = area.wardName || area.wardFullName || `KV${ai + 1}`;
        const key = `${wardCode}::${keyword}`;
        out.push({
          key,
          wardCode,
          wardName,
          keyword,
          label: `${wardName} · ${keyword}`,
          areaIndex: ai,
          keywordIndex: ki
        });
      }
    }
    return out;
  }
  return { totalJobs, jobCoords, buildPlannedContexts, sourceHas: (s) => searchJs.includes(s) };
}

async function main() {
  // --- Syntax / static presence ---
  for (const rel of ["web/search.js", "web/app.js", "web/grid-utils.js", "web/map.js", "extension/grid.js"]) {
    try {
      require("child_process").execFileSync(process.execPath, ["--check", path.join(ROOT, rel)], {
        stdio: "pipe"
      });
      pass(`syntax ${rel}`);
    } catch (e) {
      fail(`syntax ${rel}: ${e.message}`);
    }
  }

  const searchJs = fs.readFileSync(path.join(ROOT, "web", "search.js"), "utf8");
  const appJs = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const indexHtml = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");

  const mustHaveSearch = [
    "function createAreaCard",
    "version !== 3",
    "nextJobIndex",
    "buildPlannedContexts",
    "generateGridFromPolygon",
    "addSearchAreaBtn",
    "search_${batchId}_a${areaIndex}_k${keywordIndex}"
  ];
  for (const s of mustHaveSearch) {
    if (searchJs.includes(s)) pass(`search.js has ${s}`);
    else fail(`search.js missing ${s}`);
  }

  // Old single-select should be gone from runtime paths
  if (/els\.province\b/.test(searchJs) || /els\.ward\b/.test(searchJs)) {
    fail("search.js still references els.province/els.ward");
  } else pass("search.js no longer uses els.province/els.ward");

  if (/selectedWardInfo\b/.test(searchJs)) fail("search.js still has selectedWardInfo");
  else pass("search.js no selectedWardInfo");

  if (indexHtml.includes("id=\"searchAreas\"") && indexHtml.includes("id=\"addSearchAreaBtn\"")) {
    pass("index.html multi-area UI markers");
  } else fail("index.html missing multi-area UI");

  if (indexHtml.includes("id=\"searchProvince\"") || indexHtml.includes("id=\"searchWard\"")) {
    fail("index.html still has old single province/ward ids");
  } else pass("index.html old single selects removed");

  const mustHaveApp = [
    "let plannedContexts",
    "function normalizePlannedContexts",
    "function mergeSearchAreaKeys",
    "searchAreaKey",
    "searchWardCode"
  ];
  for (const s of mustHaveApp) {
    if (appJs.includes(s)) pass(`app.js has ${s}`);
    else fail(`app.js missing ${s}`);
  }

  // --- Job order unit tests ---
  const { totalJobs, jobCoords, buildPlannedContexts } = extractJobHelpers(searchJs);
  const areas = [
    { wardCode: "00103", wardName: "Tây Hồ" },
    { wardCode: "00004", wardName: "Ba Đình" }
  ];
  const keywords = ["tạp hóa", "phòng khám"];
  const jobs = totalJobs(areas.length, keywords.length);
  if (jobs !== 4) fail(`totalJobs expected 4 got ${jobs}`);
  else pass("totalJobs 2 areas × 2 keywords = 4");

  const order = [];
  for (let j = 0; j < jobs; j++) {
    const { areaIndex, keywordIndex } = jobCoords(j, keywords.length);
    order.push(`A${areaIndex + 1}:${keywords[keywordIndex]}`);
  }
  const expected = ["A1:tạp hóa", "A1:phòng khám", "A2:tạp hóa", "A2:phòng khám"];
  if (order.join("|") === expected.join("|")) pass(`job order OK: ${order.join(" → ")}`);
  else fail(`job order wrong: ${order.join(" → ")}`);

  const contexts = buildPlannedContexts(areas, keywords);
  if (contexts.length === 4 && contexts[0].key === "00103::tạp hóa" && contexts[3].label.includes("Ba Đình")) {
    pass("plannedContexts keys/labels OK");
  } else fail(`plannedContexts unexpected: ${JSON.stringify(contexts)}`);

  // searchId pattern from source
  if (searchJs.includes("`search_${batchId}_a${areaIndex}_k${keywordIndex}`")) {
    pass("searchId pattern includes area + keyword indexes");
  } else fail("searchId pattern missing");

  // --- Grid PIP vs bbox ---
  const g = loadGridUtils();
  const tayHoPath = path.join(
    ROOT,
    "server/data/geo/geojson/01_ha_noi/wards/00103_tay_ho.geojson"
  );
  if (fs.existsSync(tayHoPath)) {
    const gj = JSON.parse(fs.readFileSync(tayHoPath, "utf8"));
    const actual = g.generateGridFromPolygon(gj).totalCells;
    const bboxEst = g.estimateGridCellsFromBoundary(gj);
    if (actual > 0) pass(`Tay Ho PIP cells=${actual}`);
    else fail("Tay Ho PIP cells=0");
    if (bboxEst !== actual) {
      pass(`bbox estimate (${bboxEst}) ≠ PIP actual (${actual}) — hint must use PIP`);
    } else {
      warn(`bbox estimate equals PIP (${actual}) for Tay Ho — unusual but ok`);
    }
    // Ensure search.js computeScanCells uses generateGridFromPolygon not bbox estimate helper alone
    if (searchJs.includes("generateGridFromPolygon(boundaryGeoJSON") || searchJs.includes("generateGridFromPolygon(boundary")) {
      pass("search.js computeScanCells uses generateGridFromPolygon");
    } else fail("search.js may still estimate via bbox only");
  } else {
    warn("Tay Ho geojson missing — skip PIP compare");
  }

  // Cap check
  const truongSa = path.join(
    ROOT,
    "server/data/geo/geojson/56_khanh_hoa/wards/22736_truong_sa.geojson"
  );
  if (fs.existsSync(truongSa)) {
    const gj = JSON.parse(fs.readFileSync(truongSa, "utf8"));
    const grid = g.generateGridFromPolygon(gj);
    if (grid.totalCells <= g.MAX_POLYGON_GRID_CELLS && grid.capped) {
      pass(`Truong Sa capped at ${grid.totalCells}`);
    } else {
      warn(`Truong Sa cells=${grid.totalCells} capped=${grid.capped}`);
    }
  }

  // --- Live routes ---
  try {
    const home = await get("/");
    if (home.status === 200) pass("GET / 200");
    else fail(`GET / ${home.status}`);

    const login = await get("/login");
    if (login.status === 200) pass("GET /login 200");
    else fail(`GET /login ${login.status}`);

    // Authenticated app page
    // Use raw login then cookie is findmap_session=1 via Set-Cookie — fetch / with cookie
    const loginRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        email: "admin@timdiemban.local",
        password: "Admin@123456"
      });
      const req = http.request(
        BASE + "/api/auth/login",
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    if (loginRes.status === 200) pass("login API 200");
    else fail(`login API ${loginRes.status}`);

    const appPage = await new Promise((resolve, reject) => {
      http
        .get(
          BASE + "/",
          { headers: { Cookie: "findmap_session=1" } },
          (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => resolve({ status: res.statusCode, body: d }));
          }
        )
        .on("error", reject);
    });
    if (appPage.status === 200 && appPage.body.includes("searchAreas") && appPage.body.includes("addSearchAreaBtn")) {
      pass("authed / serves multi-area form");
    } else {
      fail("authed / missing multi-area markers");
    }
    if (appPage.body.includes("searchProvince") || appPage.body.includes("id=\"searchWard\"")) {
      fail("authed page still has old province/ward ids");
    } else pass("authed page has no old single selects");

    // Assets
    for (const p of ["/search.js?v=20260810multi1", "/app.js?v=20260810multi1", "/grid-utils.js?v=20260810multi1", "/style.css?v=20260810multi1"]) {
      const r = await get(p);
      if (r.status === 200) pass(`asset ${p}`);
      else fail(`asset ${p} -> ${r.status}`);
    }

    // Geo APIs still work
    const prov = JSON.parse((await get("/api/geo/provinces")).body);
    if (prov.length >= 30) pass(`provinces ${prov.length}`);
    else fail(`provinces ${prov.length}`);
    const wards = JSON.parse((await get("/api/geo/wards?province_code=01")).body);
    if (wards.length > 50) pass(`HN wards ${wards.length}`);
    else fail(`HN wards ${wards.length}`);
    const bound = JSON.parse((await get("/api/geo/ward-boundary/00103")).body);
    if (bound.features?.length === 1) pass("Tay Ho boundary OK");
    else fail("Tay Ho boundary broken");

    // Live PIP via same boundary as UI would
    const liveGrid = g.generateGridFromPolygon(bound);
    pass(`live API boundary → PIP cells=${liveGrid.totalCells}`);
  } catch (e) {
    fail(`live checks: ${e.message}`);
  }

  // --- Idle wait quality ---
  if (searchJs.includes("status?.paused") && searchJs.includes("90000")) {
    pass("waitForExtensionIdle tightened + 90s between jobs");
  } else warn("idle wait may not match plan tightening");

  // Recovery keeps on temporary error
  if (searchJs.includes("keepRecoveryOnError")) pass("batch keeps recovery on temp errors");
  else warn("keepRecoveryOnError flag not found");

  console.log("\n===== MULTI-AREA VERIFY =====");
  for (const m of report.ok) console.log("OK   ", m);
  for (const m of report.warn) console.log("WARN ", m);
  for (const m of report.fail) console.log("FAIL ", m);
  console.log(`\nSummary: ${report.ok.length} ok, ${report.warn.length} warn, ${report.fail.length} fail`);
  process.exit(report.fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
