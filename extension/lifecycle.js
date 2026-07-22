(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.TimDiemBanLifecycle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WATCHDOG_ALARM = "findmap_durable_work_watchdog";
  const WATCHDOG_PERIOD_MINUTES = 0.5;
  const CHECKPOINT_VERSION = 2;
  const MAX_CHECKPOINT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

  function isFreshTimestamp(value, now = Date.now()) {
    const timestamp = Number(value || 0);
    return (
      timestamp > 0 &&
      timestamp <= now + MAX_CLOCK_SKEW_MS &&
      now - timestamp <= MAX_CHECKPOINT_AGE_MS
    );
  }

  function isRecoverableScrapeCheckpoint(checkpoint, now = Date.now()) {
    const totalCells = Number(checkpoint?.totalCells);
    const gridIndex = Number(checkpoint?.gridIndex || 0);
    return Boolean(
      checkpoint?.running &&
        checkpoint?.searchParams?.searchId &&
        Array.isArray(checkpoint.gridPoints) &&
        Number.isSafeInteger(totalCells) &&
        totalCells > 0 &&
        Number.isSafeInteger(gridIndex) &&
        gridIndex >= 0 &&
        gridIndex <= totalCells &&
        checkpoint.gridPoints.length >= totalCells &&
        isFreshTimestamp(checkpoint.savedAt || checkpoint.lastHeartbeat, now)
    );
  }

  function nextPendingCell(checkpoint) {
    const total = Math.max(0, Number(checkpoint?.totalCells) || 0);
    const completed = new Set(
      Array.isArray(checkpoint?.completedCells) ? checkpoint.completedCells.map(Number) : []
    );
    let next = Math.max(0, Number(checkpoint?.gridIndex) || 0);
    while (next < total && completed.has(next)) next += 1;
    return next;
  }

  function isRecoverableRescanCheckpoint(checkpoint, now = Date.now()) {
    const placeIndex = Number(checkpoint?.placeIndex);
    return Boolean(
      checkpoint?.running &&
        checkpoint?.webUrl &&
        Array.isArray(checkpoint.places) &&
        checkpoint.places.length > 0 &&
        Number.isSafeInteger(placeIndex) &&
        placeIndex >= 0 &&
        placeIndex <= checkpoint.places.length &&
        isFreshTimestamp(checkpoint.savedAt || checkpoint.lastHeartbeat, now)
    );
  }

  return {
    WATCHDOG_ALARM,
    WATCHDOG_PERIOD_MINUTES,
    CHECKPOINT_VERSION,
    MAX_CHECKPOINT_AGE_MS,
    MAX_CLOCK_SKEW_MS,
    isRecoverableScrapeCheckpoint,
    nextPendingCell,
    isRecoverableRescanCheckpoint
  };
});
