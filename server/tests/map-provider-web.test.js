const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");
const mapProvider = require(path.join(rootDir, "web", "map-provider.js"));

test("Findmap web map mặc định dùng OpenFreeMap vector và giữ fallback OSM", () => {
  const previousConfig = globalThis.TIMDIEMBAN_CONFIG;
  try {
    delete globalThis.TIMDIEMBAN_CONFIG;
    assert.equal(mapProvider.normalizeProvider(" OPENFREEMAP "), "openfreemap");
    assert.equal(mapProvider.normalizeProvider("openstreetmap"), "openstreetmap");
    assert.equal(mapProvider.normalizeProvider("khong-hop-le"), "openfreemap");

    const modern = mapProvider.resolveConfig({});
    assert.equal(modern.provider, "openfreemap");
    assert.equal(modern.type, "vector");
    assert.equal(modern.styleUrl, "https://tiles.openfreemap.org/styles/liberty");
    assert.equal(modern.fallbackUrl, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");

    const legacy = mapProvider.resolveConfig({ provider: "openstreetmap" });
    assert.equal(legacy.provider, "openstreetmap");
    assert.equal(legacy.type, "raster");
    assert.equal(legacy.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  } finally {
    if (previousConfig === undefined) delete globalThis.TIMDIEMBAN_CONFIG;
    else globalThis.TIMDIEMBAN_CONFIG = previousConfig;
  }
});

test("map-provider được nạp trước map.js và map.js delegate lớp nền", () => {
  const html = read("web", "index.html");
  const webMap = read("web", "map.js");
  const providerAt = html.indexOf("/map-provider.js");
  const mapAt = html.indexOf("/map.js");

  assert.ok(providerAt >= 0, "index.html phải nạp map-provider.js");
  assert.ok(mapAt > providerAt, "map-provider.js phải nạp trước map.js");
  assert.match(webMap, /TimDiemBanMapProvider\.addBaseLayer\(map, window\.TIMDIEMBAN_CONFIG \|\| \{\}, L\)/);
});

test("khi MapLibre chưa sẵn sàng, provider trả về lớp OSM để bản đồ không trắng", () => {
  const toggled = [];
  const added = [];
  const container = {
    classList: {
      toggle: (name, value) => toggled.push([name, value])
    },
    dataset: {}
  };
  const map = {
    getContainer: () => container
  };
  const leaflet = {
    tileLayer: (url, options) => ({
      url,
      options,
      addTo(target) {
        added.push(target);
        return this;
      }
    })
  };

  const layer = mapProvider.addBaseLayer(map, {}, leaflet);

  assert.equal(layer.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(added.length, 1);
  assert.equal(container.dataset.mapProvider, "openstreetmap");
  assert.ok(toggled.some(([name, value]) => name === "tdb-map-openstreetmap" && value === true));
});

test("web có trạng thái giữ màn hình khi quét chính hoặc quét lại đang chạy", () => {
  const webSearch = read("web", "search.js");
  const webApp = read("web", "app.js");
  const style = read("web", "style.css");

  assert.match(webSearch, /tdb-search-running/);
  assert.match(webSearch, /tdb-search-paused/);
  assert.match(webSearch, /aria-busy/);
  assert.match(webApp, /tdb-rescan-running/);
  assert.match(style, /Findmap đang giữ phiên quét/);
  assert.match(style, /Đang quét lại điểm thiếu/);
});
