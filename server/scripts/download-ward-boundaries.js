/**
 * Script batch download tất cả ward boundary GeoJSON từ thanglequoc/vietnamese-provinces-database v4.2.0
 * Chạy: node server/scripts/download-ward-boundaries.js
 *
 * Dữ liệu source: https://github.com/thanglequoc/vietnamese-provinces-database (MIT License)
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const DATA_DIR = path.join(__dirname, "..", "data", "geo");
const OUT_BASE = path.join(DATA_DIR, "geojson");
const FULL_UNITS_PATH = path.join(DATA_DIR, "full_units.json");
const TAG = "v4.2.0";
const BASE_URL = `https://raw.githubusercontent.com/thanglequoc/vietnamese-provinces-database/${TAG}/json/geojson`;

const MAX_CONCURRENT = 8;
let downloaded = 0;
let failed = 0;
let skipped = 0;
let total = 0;
const queue = [];
const inProgress = new Set();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function downloadFile(url, destPath) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith("https") ? https : http;

    const req = protocol.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        file.close();
        fs.unlink(destPath, () => {});
        resolve({ ok: false, status: 404 });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        resolve({ ok: false, status: res.statusCode });
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve({ ok: true });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      file.close();
      fs.unlink(destPath, () => {});
      resolve({ ok: false, status: "timeout" });
    });

    req.on("error", (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      resolve({ ok: false, status: err.message });
    });
  });
}

async function processQueue() {
  while (queue.length > 0 || inProgress.size > 0) {
    while (queue.length > 0 && inProgress.size < MAX_CONCURRENT) {
      const task = queue.shift();
      if (!task) break;
      inProgress.add(task.url);
      downloadFile(task.url, task.dest)
        .then(({ ok, status }) => {
          if (ok) {
            downloaded++;
          } else {
            failed++;
            console.error(`\n  FAIL ${task.url} → ${status}`);
          }
          process.stdout.write(`\rDownloaded: ${downloaded}  Failed: ${failed}  Queue: ${queue.length}`);
        })
        .finally(() => {
          inProgress.delete(task.url);
        });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  if (!fs.existsSync(FULL_UNITS_PATH)) {
    console.error(`ERROR: full_units.json not found at ${FULL_UNITS_PATH}`);
    console.error("Run: node server/scripts/download-ward-boundaries.js");
    process.exit(1);
  }

  const units = JSON.parse(fs.readFileSync(FULL_UNITS_PATH, "utf8"));
  console.log(`Loaded ${units.length} provinces from full_units.json\n`);

  for (const province of units) {
    // Repo folder is "{code}_{codename}" e.g., "01_ha_noi"
    const provinceSlug = `${province.Code}_${province.CodeName}`;
    const provinceDir = path.join(OUT_BASE, provinceSlug);
    const wardsDir = path.join(provinceDir, "wards");
    if (!fs.existsSync(wardsDir)) {
      fs.mkdirSync(wardsDir, { recursive: true });
    }

    // Province boundary (dùng preview map khi chỉ chọn tỉnh)
    const provinceFile = `${provinceSlug}.geojson`;
    const provinceDest = path.join(provinceDir, provinceFile);
    if (!fs.existsSync(provinceDest)) {
      queue.push({
        url: `${BASE_URL}/${provinceSlug}/${provinceFile}`,
        dest: provinceDest
      });
    } else {
      skipped++;
    }

    const wards = province.Wards || [];
    for (const ward of wards) {
      const fileName = `${ward.Code}_${ward.CodeName}.geojson`;
      const destPath = path.join(wardsDir, fileName);

      if (fs.existsSync(destPath)) {
        skipped++;
        continue;
      }

      const url = `${BASE_URL}/${provinceSlug}/wards/${fileName}`;
      queue.push({ url, dest: destPath });
    }

    if (wards.length > 0) {
      const pending = wards.filter((w) => !fs.existsSync(path.join(wardsDir, `${w.Code}_${w.CodeName}.geojson`))).length;
      const provincePending = fs.existsSync(provinceDest) ? 0 : 1;
      console.log(`  ${province.Name} (${provinceSlug}): ${wards.length} wards, ${pending} ward + ${provincePending} province to download`);
    }
  }

  total = queue.length;
  const alreadyDone = skipped;
  console.log(`\nAlready cached: ${alreadyDone}`);
  console.log(`Total to download: ${total}`);
  console.log(`Concurrency: ${MAX_CONCURRENT}`);
  console.log("Starting...\n");

  await processQueue();

  console.log(`\n\nDone! Downloaded: ${downloaded}, Failed: ${failed}, Skipped: ${alreadyDone}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
