import assert from "node:assert";
import { canAppend, isRetired } from "../wal.js";
import { step, close } from "../compact.js";
import { render } from "../app.js";

const base = {
  state: { checkpoint: 0, segments: [], retired: [], reclaimed: [], applied: [] },
  events: [], budget: 1,
  stale_error_code: "E_STALE_SEGMENT", backward_error_code: "E_BACKWARD_CHECKPOINT",
  event_error_code: "E_BAD_EVENT"
};

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok " + name); } catch (e) { failed += 1; console.log("FAIL " + name + " :: " + e.message); }
}

check("canAppend returns a flag", () => {
  assert.strictEqual(typeof canAppend(base.state, 1), "boolean");
});

check("isRetired returns a flag", () => {
  assert.strictEqual(typeof isRetired(base.state, 1), "boolean");
});

check("step returns a state", () => {
  assert.strictEqual(typeof step(base).state, "object");
});

check("close returns a state", () => {
  assert.strictEqual(typeof close(base).state, "object");
});

check("render counts events", () => {
  assert.strictEqual(typeof render(base).count, "number");
});

console.log("5 cases, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
