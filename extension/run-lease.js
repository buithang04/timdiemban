(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TimDiemBanRunLease = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalize(source) {
    const value = source && typeof source === "object" ? source : {};
    const nested = value.lease && typeof value.lease === "object" ? value.lease : {};
    const data = value.data && typeof value.data === "object" ? value.data : {};
    const runId = String(
      value.runId || nested.runId || data.runId || data.searchId || value.searchId || ""
    ).trim();
    const rawGeneration =
      value.cellGeneration ?? nested.cellGeneration ?? data.cellGeneration;
    const cellGeneration = Number(rawGeneration);

    if (!runId || !Number.isSafeInteger(cellGeneration) || cellGeneration < 1) return null;
    return { runId, cellGeneration };
  }

  function same(left, right) {
    const a = normalize(left);
    const b = normalize(right);
    return Boolean(a && b && a.runId === b.runId && a.cellGeneration === b.cellGeneration);
  }

  function acceptsMessage(activeLease, message, senderTabId, mapsTabId) {
    if (!same(activeLease, message)) return false;
    if (mapsTabId == null || senderTabId == null) return false;
    return Number(senderTabId) === Number(mapsTabId);
  }

  return { normalize, same, acceptsMessage };
});
