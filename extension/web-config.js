/**
 * Helpers URL trang kết quả — dùng TIMDIEMBAN_CONFIG (app-config.js)
 */
function getAppOrigin() {
  const origin = String(globalThis.TIMDIEMBAN_CONFIG?.APP_ORIGIN || "").replace(/\/$/, "");
  return origin || "https://findmap.vn";
}

function getAppOriginLabel() {
  return getAppOrigin();
}

function getConfiguredWebOrigins() {
  const base = getAppOrigin();
  const origins = new Set([base]);
  if (base.includes("localhost")) {
    origins.add(base.replace("localhost", "127.0.0.1"));
  } else if (base.includes("127.0.0.1")) {
    origins.add(base.replace("127.0.0.1", "localhost"));
  }
  try {
    const u = new URL(base);
    if (u.hostname.startsWith("www.")) {
      origins.add(`${u.protocol}//${u.hostname.slice(4)}${u.port ? `:${u.port}` : ""}`);
    } else if (
      u.protocol === "https:" &&
      !u.hostname.includes("localhost") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
    ) {
      origins.add(`${u.protocol}//www.${u.hostname}${u.port ? `:${u.port}` : ""}`);
    }
    if (u.hostname === "findmap.vn" || u.hostname.endsWith(".findmap.vn")) {
      origins.add(`${u.protocol}//findmap.vn`);
      origins.add(`${u.protocol}//www.findmap.vn`);
      origins.add(`${u.protocol}//app.findmap.vn`);
    }
  } catch {}
  // Alias prod luôn có — popup extension vẫn mở đúng kể cả đang sync local
  origins.add("https://findmap.vn");
  origins.add("https://www.findmap.vn");
  origins.add("https://app.findmap.vn");
  return [...origins];
}

function resolveWebUrlCandidates(webUrl) {
  const requested = String(webUrl || "").replace(/\/$/, "");
  const list = requested ? [requested, ...getConfiguredWebOrigins()] : getConfiguredWebOrigins();
  return [...new Set(list.filter(Boolean))];
}

function getMapsAutoFocusMinutes() {
  const n = Number(globalThis.TIMDIEMBAN_CONFIG?.MAPS_AUTO_FOCUS_MINUTES);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

function getMapsAutoReopenMax() {
  const n = Number(globalThis.TIMDIEMBAN_CONFIG?.MAPS_AUTO_REOPEN_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}
