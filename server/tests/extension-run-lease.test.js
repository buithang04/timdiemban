const test = require("node:test");
const assert = require("node:assert/strict");

const RunLease = require("../../extension/run-lease");

test("run lease đọc định danh từ message và data", () => {
  assert.deepEqual(RunLease.normalize({ runId: "run-a", cellGeneration: 2 }), {
    runId: "run-a",
    cellGeneration: 2
  });
  assert.deepEqual(RunLease.normalize({ data: { searchId: "run-b", cellGeneration: 4 } }), {
    runId: "run-b",
    cellGeneration: 4
  });
  assert.equal(RunLease.normalize({ runId: "run-a", cellGeneration: 0 }), null);
  assert.equal(RunLease.normalize({ runId: "", cellGeneration: 1 }), null);
});

test("chỉ nhận message đúng phiên, đúng ô và đúng tab Maps", () => {
  const active = { runId: "run-a", cellGeneration: 3 };
  assert.equal(
    RunLease.acceptsMessage(active, { runId: "run-a", cellGeneration: 3 }, 12, 12),
    true
  );
  assert.equal(
    RunLease.acceptsMessage(active, { runId: "run-old", cellGeneration: 3 }, 12, 12),
    false
  );
  assert.equal(
    RunLease.acceptsMessage(active, { runId: "run-a", cellGeneration: 2 }, 12, 12),
    false
  );
  assert.equal(
    RunLease.acceptsMessage(active, { runId: "run-a", cellGeneration: 3 }, 11, 12),
    false
  );
});
