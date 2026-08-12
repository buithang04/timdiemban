/**
 * Vietnam Administrative Units — GeoJSON API
 * Data source: thanglequoc/vietnamese-provinces-database (MIT License)
 * Repo: https://github.com/thanglequoc/vietnamese-provinces-database
 * Tag: v4.2.0 ( Decree 30/2026/QH16 )
 */

const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const DATA_DIR = path.join(__dirname, "data", "geo");
const GEOJSON_TAG = "v4.2.0";
const GEOJSON_BASE = `https://raw.githubusercontent.com/thanglequoc/vietnamese-provinces-database/${GEOJSON_TAG}/json/geojson`;

let _unitsCache = null;
let _wardBoundaryCache = Object.create(null);
let _provinceBoundaryCache = Object.create(null);

function loadFullUnits() {
  if (_unitsCache) return _unitsCache;
  const filePath = path.join(DATA_DIR, "full_units.json");
  const raw = fs.readFileSync(filePath, "utf8");
  _unitsCache = JSON.parse(raw);
  return _unitsCache;
}

function findProvinceByCode(code) {
  const units = loadFullUnits();
  const raw = String(code || "").trim();
  return (
    units.find((p) => p.Code === raw) ||
    units.find((p) => p.Code === raw.replace(/^0+/, "") || p.Code.replace(/^0+/, "") === raw.replace(/^0+/, ""))
  );
}

function provinceSlugOf(province) {
  return `${province.Code}_${province.CodeName}`;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function downloadJson(url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/** Gộp polygon các phường/xã thành FeatureCollection tỉnh (fallback offline). */
function buildProvinceFromWards(provinceSlug, province) {
  const wardsDir = path.join(DATA_DIR, "geojson", provinceSlug, "wards");
  if (!fs.existsSync(wardsDir)) return null;
  const features = [];
  for (const name of fs.readdirSync(wardsDir)) {
    if (!name.endsWith(".geojson")) continue;
    const gj = readJsonFile(path.join(wardsDir, name));
    if (!gj?.features?.length) continue;
    for (const feat of gj.features) features.push(feat);
  }
  if (!features.length) return null;
  return {
    type: "FeatureCollection",
    features,
    properties: {
      code: province.Code,
      name: province.Name,
      fullName: province.FullName,
      level: "province",
      source: "wards-merge"
    }
  };
}

async function loadProvinceBoundaryGeoJSON(province) {
  const slug = provinceSlugOf(province);
  const localPath = path.join(DATA_DIR, "geojson", slug, `${slug}.geojson`);

  let geojson = readJsonFile(localPath);
  if (geojson?.features?.length) return geojson;

  // Tải từ upstream nếu thiếu file tỉnh
  const remote = await downloadJson(`${GEOJSON_BASE}/${slug}/${slug}.geojson`);
  if (remote?.features?.length) {
    try {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, JSON.stringify(remote));
    } catch (err) {
      console.warn("[geo-api] save province boundary:", err.message);
    }
    return remote;
  }

  // Fallback: gộp wards đã có sẵn local
  const merged = buildProvinceFromWards(slug, province);
  if (merged) {
    try {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, JSON.stringify(merged));
    } catch {}
  }
  return merged;
}

/** GET /api/geo/provinces */
function getProvinces(req, res) {
  try {
    const units = loadFullUnits();
    const provinces = units.map((p) => ({
      code: p.Code,
      name: p.Name,
      fullName: p.FullName,
      nameEn: p.NameEn,
      fullNameEn: p.FullNameEn,
      codeName: p.CodeName,
      administrativeUnit: p.AdministrativeUnitShortName
    }));
    res.json(provinces);
  } catch (err) {
    console.error("[geo-api] getProvinces:", err.message);
    res.status(500).json({ error: "Không thể truy xuất danh sách tỉnh/thành phố." });
  }
}

/** GET /api/geo/wards?province_code=01 */
function getWards(req, res) {
  try {
    const { province_code } = req.query;
    if (!province_code) {
      return res.status(400).json({ error: "Thiếu tham số province_code." });
    }

    const units = loadFullUnits();
    const province = units.find((p) => p.Code === province_code);
    if (!province) {
      return res.status(404).json({ error: "Không tìm thấy tỉnh/thành phố với mã này." });
    }

    const wards = (province.Wards || []).map((w) => ({
      code: w.Code,
      name: w.Name,
      fullName: w.FullName,
      nameEn: w.NameEn,
      fullNameEn: w.FullNameEn,
      codeName: w.CodeName,
      provinceCode: w.ProvinceCode,
      administrativeUnit: w.AdministrativeUnitShortName
    }));

    res.json(wards);
  } catch (err) {
    console.error("[geo-api] getWards:", err.message);
    res.status(500).json({ error: "Không thể truy xuất danh sách phường/xã." });
  }
}

/**
 * GET /api/geo/ward-boundary/:code
 * Returns GeoJSON FeatureCollection for a single ward.
 * Boundary fetched from per-ward GeoJSON files on-demand.
 */
function getWardBoundary(req, res) {
  try {
    const { code } = req.params;
    if (!code || !/^\d+$/.test(code)) {
      return res.status(400).json({ error: "Mã phường/xã không hợp lệ." });
    }

    // Normalize: leading zeros may differ; try as-is first
    const cacheKey = code;
    if (_wardBoundaryCache[cacheKey]) {
      return res.json(_wardBoundaryCache[cacheKey]);
    }

    // Find which province this ward belongs to by scanning full_units.json
    const units = loadFullUnits();
    let foundWard = null;
    let foundProvinceCode = null;
    let foundProvinceSlug = null;

    for (const province of units) {
      const ward = (province.Wards || []).find(
        (w) => w.Code === code || w.Code === code.replace(/^0+/, "")
      );
      if (ward) {
        foundWard = ward;
        foundProvinceCode = province.Code;
        // Repo folder: "{code}_{codename}" e.g., "01_ha_noi"
        foundProvinceSlug = `${province.Code}_${province.CodeName}`;
        break;
      }
    }

    if (!foundWard) {
      return res.status(404).json({ error: "Không tìm thấy phường/xã với mã này." });
    }

    // Build ward slug from ward CodeName (e.g., "00103_tay_ho")
    const wardSlugFile = `${foundWard.Code}_${foundWard.CodeName}.geojson`;
    const boundaryPath = path.join(DATA_DIR, "geojson", foundProvinceSlug, "wards", wardSlugFile);

    let geojson;
    if (fs.existsSync(boundaryPath)) {
      const raw = fs.readFileSync(boundaryPath, "utf8");
      geojson = JSON.parse(raw);
    } else {
      // Fallback: build minimal bbox from properties if boundary file missing
      // Return empty FeatureCollection — client will handle gracefully
      geojson = {
        type: "FeatureCollection",
        features: [],
        properties: {
          code: foundWard.Code,
          name: foundWard.Name,
          fullName: foundWard.FullName,
          provinceCode: foundProvinceCode
        }
      };
      console.warn(`[geo-api] Ward boundary file not found: ${boundaryPath}`);
    }

    // Cache result
    _wardBoundaryCache[cacheKey] = geojson;
    res.json(geojson);
  } catch (err) {
    console.error("[geo-api] getWardBoundary:", err.message);
    res.status(500).json({ error: "Không thể truy xuất ranh giới phường/xã." });
  }
}

/**
 * GET /api/geo/ward-info/:code
 * Returns metadata about a ward (name, province, area) without GeoJSON boundary.
 * Lightweight endpoint for UI preview before full boundary load.
 */
function getWardInfo(req, res) {
  try {
    const { code } = req.params;
    if (!code || !/^\d+$/.test(code)) {
      return res.status(400).json({ error: "Mã phường/xã không hợp lệ." });
    }

    const units = loadFullUnits();
    for (const province of units) {
      const ward = (province.Wards || []).find(
        (w) => w.Code === code || w.Code === code.replace(/^0+/, "")
      );
      if (ward) {
        return res.json({
          code: ward.Code,
          name: ward.Name,
          fullName: ward.FullName,
          nameEn: ward.NameEn,
          fullNameEn: ward.FullNameEn,
          provinceCode: province.Code,
          provinceName: province.Name,
          provinceFullName: province.FullName,
          administrativeUnit: ward.AdministrativeUnitShortName,
          // areaKm2 will be populated from ward boundary properties after boundary is loaded
          areaKm2: null
        });
      }
    }

    res.status(404).json({ error: "Không tìm thấy phường/xã với mã này." });
  } catch (err) {
    console.error("[geo-api] getWardInfo:", err.message);
    res.status(500).json({ error: "Không thể truy xuất thông tin phường/xã." });
  }
}

/** GET /api/geo/province-info/:code */
function getProvinceInfo(req, res) {
  try {
    const { code } = req.params;
    if (!code || !/^\d+$/.test(code)) {
      return res.status(400).json({ error: "Mã tỉnh/thành không hợp lệ." });
    }
    const province = findProvinceByCode(code);
    if (!province) {
      return res.status(404).json({ error: "Không tìm thấy tỉnh/thành phố với mã này." });
    }
    res.json({
      code: province.Code,
      name: province.Name,
      fullName: province.FullName,
      nameEn: province.NameEn,
      fullNameEn: province.FullNameEn,
      codeName: province.CodeName,
      administrativeUnit: province.AdministrativeUnitShortName,
      wardCount: Array.isArray(province.Wards) ? province.Wards.length : 0,
      level: "province"
    });
  } catch (err) {
    console.error("[geo-api] getProvinceInfo:", err.message);
    res.status(500).json({ error: "Không thể truy xuất thông tin tỉnh/thành." });
  }
}

/**
 * GET /api/geo/province-boundary/:code
 * Ranh giới tỉnh/thành — dùng để preview map khi mới chọn tỉnh (chưa chọn phường/xã).
 */
async function getProvinceBoundary(req, res) {
  try {
    const { code } = req.params;
    if (!code || !/^\d+$/.test(code)) {
      return res.status(400).json({ error: "Mã tỉnh/thành không hợp lệ." });
    }

    if (_provinceBoundaryCache[code]) {
      return res.json(_provinceBoundaryCache[code]);
    }

    const province = findProvinceByCode(code);
    if (!province) {
      return res.status(404).json({ error: "Không tìm thấy tỉnh/thành phố với mã này." });
    }

    const geojson = await loadProvinceBoundaryGeoJSON(province);
    if (!geojson?.features?.length) {
      return res.status(404).json({
        error: "Chưa có dữ liệu ranh giới tỉnh/thành. Hãy tải geo data hoặc chọn Phường/Xã."
      });
    }

    _provinceBoundaryCache[code] = geojson;
    // Alias code variants
    _provinceBoundaryCache[province.Code] = geojson;
    res.json(geojson);
  } catch (err) {
    console.error("[geo-api] getProvinceBoundary:", err.message);
    res.status(500).json({ error: "Không thể truy xuất ranh giới tỉnh/thành." });
  }
}

module.exports = {
  getProvinces,
  getWards,
  getWardBoundary,
  getWardInfo,
  getProvinceInfo,
  getProvinceBoundary
};
