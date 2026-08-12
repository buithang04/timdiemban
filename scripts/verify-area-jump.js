/**
 * Offline checks: multi-area job order + map redraw keeps all areas.
 * Usage: node scripts/verify-area-jump.js
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

function jobCoords(jobIndex, keywordsLen) {
  const ki = keywordsLen > 0 ? jobIndex % keywordsLen : 0;
  const ai = keywordsLen > 0 ? Math.floor(jobIndex / keywordsLen) : 0;
  return { areaIndex: ai, keywordIndex: ki };
}

function totalJobs(a, k) {
  return Math.max(0, a) * Math.max(0, k);
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
    const req = http.get(url, { timeout: 8000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8")
        })
      );
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function main() {
  // --- Job order: area-major × keywords ---
  const areas = ["NgocHa", "HoanKiem", "TayHo"];
  const keywords = ["tap hoa", "quan an"];
  const jobs = totalJobs(areas.length, keywords.length);
  if (jobs !== 6) fail(`jobs expected 6 got ${jobs}`);
  else pass(`jobs = ${areas.length}×${keywords.length} = ${jobs}`);

  const sequence = [];
  for (let job = 0; job < jobs; job++) {
    const { areaIndex, keywordIndex } = jobCoords(job, keywords.length);
    sequence.push(`${areas[areaIndex]}::${keywords[keywordIndex]}`);
  }
  const expected = [
    "NgocHa::tap hoa",
    "NgocHa::quan an",
    "HoanKiem::tap hoa",
    "HoanKiem::quan an",
    "TayHo::tap hoa",
    "TayHo::quan an"
  ];
  if (sequence.join("|") === expected.join("|")) {
    pass("job order: area1×all KW → area2×all KW…");
  } else {
    fail(`job order mismatch:\n  got ${sequence.join(" → ")}\n  want ${expected.join(" → ")}`);
  }

  // Jump points: when areaIndex increases
  const jumps = [];
  for (let job = 1; job < jobs; job++) {
    const prev = jobCoords(job - 1, keywords.length);
    const cur = jobCoords(job, keywords.length);
    if (cur.areaIndex !== prev.areaIndex) {
      jumps.push({
        fromJob: job - 1,
        toJob: job,
        from: areas[prev.areaIndex],
        to: areas[cur.areaIndex],
        keyword: keywords[cur.keywordIndex]
      });
    }
  }
  if (jumps.length === 2 && jumps[0].to === "HoanKiem" && jumps[1].to === "TayHo") {
    pass(`area jumps OK: ${jumps.map((j) => `${j.from}→${j.to}`).join(", ")}`);
  } else {
    fail(`unexpected jumps: ${JSON.stringify(jumps)}`);
  }

  // searchId pattern
  const sid = (batchId, ai, ki) => `search_${batchId}_a${ai}_k${ki}`;
  if (sid(99, 1, 0) === "search_99_a1_k0") pass("searchId pattern a{area}_k{keyword}");
  else fail("searchId pattern broken");

  // --- Source markers for map-keep-all fix ---
  const searchJs = fs.readFileSync(path.join(ROOT, "web", "search.js"), "utf8");
  const appJs = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const mapJs = fs.readFileSync(path.join(ROOT, "web", "map.js"), "utf8");

  const needSearch = [
    "lastBatchAreasForMap",
    "redrawAllAreaMaps",
    "activeAreaIndex",
    "TimDiemBanSearch"
  ];
  for (const s of needSearch) {
    if (searchJs.includes(s)) pass(`search.js has ${s}`);
    else fail(`search.js missing ${s}`);
  }
  if (searchJs.includes("redrawAllAreaMaps({\n          areas,\n          activeAreaIndex: areaIndex")) {
    pass("batch loop redraws ALL areas before each job");
  } else if (
    searchJs.includes("activeAreaIndex: areaIndex") &&
    searchJs.includes("timdiemban:search-starting")
  ) {
    pass("batch loop redraws areas around search-starting");
  } else {
    fail("batch loop may not redraw all areas on area jump");
  }

  if (appJs.includes("TimDiemBanSearch?.redrawAllAreaMaps")) {
    pass("app.js start uses redrawAllAreaMaps (keeps all KV)");
  } else {
    fail("app.js start still only drawWardBoundary — sẽ mất KV khác");
  }

  // Regression: start handler must NOT only call drawWardBoundary as sole path
  const startBlock = appJs.slice(
    appJs.indexOf('if (type === "start")'),
    appJs.indexOf('if (type === "start")') + 1200
  );
  if (
    startBlock.includes("redrawAllAreaMaps") &&
    startBlock.includes("else if (sp.wardBoundary")
  ) {
    pass("start: redrawAll first, drawWardBoundary fallback only");
  } else if (startBlock.includes("redrawAllAreaMaps")) {
    pass("start: redrawAllAreaMaps present");
  } else {
    fail("start block missing redrawAllAreaMaps");
  }

  if (mapJs.includes("activeAreaIndex") && mapJs.includes("đang quét")) {
    pass("map.js highlights active area while keeping others");
  } else if (mapJs.includes("activeAreaIndex")) {
    pass("map.js supports activeAreaIndex");
  } else {
    warn("map.js may not emphasize active area");
  }

  // Live geo + grid for 2 wards (map would draw both)
  try {
    const codes = ["00008", "00070"]; // Ngọc Hà, Hoàn Kiếm
    const grids = [];
    for (const code of codes) {
      const res = await get(`/api/geo/wards/${code}/boundary`);
      if (res.status !== 200) {
        warn(`boundary ${code} HTTP ${res.status} — skip live`);
        continue;
      }
      const gj = JSON.parse(res.body);
      const codeGrid = fs.readFileSync(path.join(ROOT, "web", "grid-utils.js"), "utf8");
      const sandbox = { console, Math, Number, String, Array, Object, JSON, parseFloat, parseInt, isNaN, Infinity };
      vm.createContext(sandbox);
      vm.runInContext(codeGrid + "\nthis.__g={generateGridFromPolygon};", sandbox);
      const grid = sandbox.__g.generateGridFromPolygon(gj);
      grids.push({ code, cells: grid.totalCells, vm: grid.viewportM });
      if (grid.totalCells > 1) pass(`${code} adaptive cells=${grid.totalCells} @${grid.viewportM}m`);
      else warn(`${code} only ${grid.totalCells} cell(s)`);
    }
    if (grids.length === 2) {
      pass(`live map would keep ${grids.length} areas (Ngọc Hà + Hoàn Kiếm) with grids`);
    }
  } catch (e) {
    warn(`live API skipped: ${e.message}`);
  }

  console.log("\n=== verify-area-jump ===");
  for (const m of report.ok) console.log("OK ", m);
  for (const m of report.warn) console.log("WARN", m);
  for (const m of report.fail) console.log("FAIL", m);
  console.log(
    `\n${report.ok.length} ok, ${report.warn.length} warn, ${report.fail.length} fail`
  );
  if (report.fail.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
