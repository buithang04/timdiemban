(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TimDiemBanMapProvider = api;
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const OPENSTREETMAP = "openstreetmap";
  const OPENFREEMAP = "openfreemap";

  const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const MAPLIBRE_CSS_URL = "https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css";
  const MAPLIBRE_JS_URL = "https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js";
  const MAPLIBRE_LEAFLET_URL =
    "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js";
  const MAPLIBRE_CSS_INTEGRITY =
    "sha384-Nq6PQ+9vJPvw7U/VfDELyrWoGQMsy0gi6QShhaSrGzkpF5KkM40csg2leky+YMTd";
  const MAPLIBRE_JS_INTEGRITY =
    "sha384-/L1njH4bbgNt9Uk3HwJ272N9fxJzRBQCxhtwGkZiqgl+Nxpq2ETUNZhNMNV1RgyW";
  const MAPLIBRE_LEAFLET_INTEGRITY =
    "sha384-LIxE/QjpJKC2A91yD40ZisdYtFbgAjl58jqpo9/MUZNgwhqsTfzwrTlqv6nDdzzB";

  const OSM_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const OFM_ATTRIBUTION =
    '&copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> · Data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  let dependenciesLoading = false;
  let dependencyCallbacks = [];
  let stylesheetState = "idle";
  let stylesheetCallbacks = [];

  function normalizeProvider(value) {
    value = String(value || "").toLowerCase().trim();
    if (value === OPENSTREETMAP) return OPENSTREETMAP;
    return OPENFREEMAP;
  }

  function configuredProvider(settings) {
    const globalConfig =
      typeof globalThis !== "undefined" && globalThis.TIMDIEMBAN_CONFIG
        ? globalThis.TIMDIEMBAN_CONFIG
        : {};
    return (
      settings?.provider ||
      settings?.mapProvider ||
      settings?.MAP_PROVIDER ||
      globalConfig.MAP_PROVIDER ||
      globalConfig.MAP_TILE_PROVIDER ||
      OPENFREEMAP
    );
  }

  function resolveConfig(settings) {
    const provider = normalizeProvider(configuredProvider(settings));
    if (provider === OPENSTREETMAP) {
      return {
        provider: OPENSTREETMAP,
        type: "raster",
        url: OSM_URL,
        attribution: OSM_ATTRIBUTION
      };
    }
    return {
      provider: OPENFREEMAP,
      type: "vector",
      styleUrl: OFM_STYLE_URL,
      fallbackUrl: OSM_URL,
      fallbackAttribution: OSM_ATTRIBUTION,
      attribution: OFM_ATTRIBUTION
    };
  }

  function addOpenStreetMapLayer(map, leaflet) {
    return leaflet
      .tileLayer(OSM_URL, {
        attribution: OSM_ATTRIBUTION,
        maxNativeZoom: 19,
        maxZoom: 22,
        updateWhenIdle: true,
        keepBuffer: 2
      })
      .addTo(map);
  }

  function documentHead() {
    if (typeof document === "undefined") return null;
    if (document.head) return document.head;
    const heads = document.getElementsByTagName("head");
    return heads && heads.length ? heads[0] : null;
  }

  function finishStylesheetLoading(success, link) {
    stylesheetState = success ? "ready" : "idle";
    if (!success && link && link.parentNode) {
      link.parentNode.removeChild(link);
    }
    const callbacks = stylesheetCallbacks.slice();
    stylesheetCallbacks = [];
    callbacks.forEach((callback) => callback(success));
  }

  function ensureMapLibreStylesheet(callback) {
    const head = documentHead();
    if (!head) {
      callback(false);
      return;
    }
    if (stylesheetState === "ready") {
      callback(true);
      return;
    }
    stylesheetCallbacks.push(callback);
    if (stylesheetState === "loading") return;

    stylesheetState = "loading";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = MAPLIBRE_CSS_URL;
    link.integrity = MAPLIBRE_CSS_INTEGRITY;
    link.crossOrigin = "anonymous";
    link.onload = () => finishStylesheetLoading(true, link);
    link.onerror = () => finishStylesheetLoading(false, link);
    head.appendChild(link);
  }

  function loadScript(url, integrity, callback) {
    const head = documentHead();
    if (!head) {
      callback(false);
      return;
    }
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = url;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = () => callback(true);
    script.onerror = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      callback(false);
    };
    head.appendChild(script);
  }

  function finishDependencyLoading(success) {
    dependenciesLoading = false;
    const callbacks = dependencyCallbacks.slice();
    dependencyCallbacks = [];
    callbacks.forEach((item) => {
      item.callback(success && typeof item.leaflet.maplibreGL === "function");
    });
  }

  function ensureMapLibreDependencies(leaflet, callback) {
    if (typeof window === "undefined" || !documentHead()) {
      callback(false);
      return;
    }

    dependencyCallbacks.push({ leaflet, callback });
    if (dependenciesLoading) return;
    dependenciesLoading = true;

    ensureMapLibreStylesheet((stylesheetReady) => {
      if (!stylesheetReady) {
        finishDependencyLoading(false);
        return;
      }
      if (typeof leaflet.maplibreGL === "function") {
        finishDependencyLoading(true);
        return;
      }
      if (!window.L) window.L = leaflet;

      const loadBridge = () => {
        loadScript(MAPLIBRE_LEAFLET_URL, MAPLIBRE_LEAFLET_INTEGRITY, finishDependencyLoading);
      };

      if (window.maplibregl) {
        loadBridge();
        return;
      }
      loadScript(MAPLIBRE_JS_URL, MAPLIBRE_JS_INTEGRITY, (success) => {
        if (!success || !window.maplibregl) {
          finishDependencyLoading(false);
          return;
        }
        loadBridge();
      });
    });
  }

  function setMapProviderClass(map, provider) {
    const container = typeof map?.getContainer === "function" ? map.getContainer() : null;
    if (!container?.classList) return;
    container.classList.toggle("tdb-map-openfreemap", provider === OPENFREEMAP);
    container.classList.toggle("tdb-map-openstreetmap", provider === OPENSTREETMAP);
    container.dataset.mapProvider = provider;
  }

  function addOpenFreeMapLayer(map, leaflet, fallbackLayer) {
    let vectorLayer;
    let failed = false;

    function removeLayer(layer) {
      if (!layer || typeof map.removeLayer !== "function") return;
      try {
        map.removeLayer(layer);
      } catch {}
    }

    function addFallback() {
      if (failed) return;
      failed = true;
      removeLayer(vectorLayer);
      if (!fallbackLayer) {
        fallbackLayer = addOpenStreetMapLayer(map, leaflet);
      }
      setMapProviderClass(map, OPENSTREETMAP);
    }

    try {
      vectorLayer = leaflet
        .maplibreGL({
          style: OFM_STYLE_URL,
          attributionControl: {
            customAttribution: OFM_ATTRIBUTION
          }
        })
        .addTo(map);

      const maplibreMap =
        typeof vectorLayer.getMaplibreMap === "function" ? vectorLayer.getMaplibreMap() : null;

      if (maplibreMap && typeof maplibreMap.on === "function") {
        maplibreMap.on("load", () => {
          removeLayer(fallbackLayer);
          fallbackLayer = null;
          setMapProviderClass(map, OPENFREEMAP);
        });
        maplibreMap.on("error", addFallback);
      } else {
        setMapProviderClass(map, OPENFREEMAP);
      }
      return vectorLayer;
    } catch {
      return fallbackLayer || addOpenStreetMapLayer(map, leaflet);
    }
  }

  function addBaseLayer(map, settings, leaflet) {
    leaflet = leaflet || (typeof window !== "undefined" ? window.L : null);
    if (!map || !leaflet || typeof leaflet.tileLayer !== "function") {
      throw new Error("Leaflet map is required");
    }

    const config = resolveConfig(settings);
    setMapProviderClass(map, config.provider);
    if (config.provider !== OPENFREEMAP) {
      return addOpenStreetMapLayer(map, leaflet);
    }

    const fallbackLayer = addOpenStreetMapLayer(map, leaflet);
    ensureMapLibreDependencies(leaflet, (ready) => {
      if (ready) {
        addOpenFreeMapLayer(map, leaflet, fallbackLayer);
      } else {
        setMapProviderClass(map, OPENSTREETMAP);
      }
    });
    return fallbackLayer;
  }

  return {
    normalizeProvider,
    resolveConfig,
    addBaseLayer
  };
});
