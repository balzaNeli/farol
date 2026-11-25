import assert from "node:assert/strict";
import test from "node:test";

import {
  canRestartIce,
  connectionReducer,
  failureEvent,
  initialConnection,
  MAX_ICE_RESTARTS,
  type ConnectionState,
} from "../src/viewer/connection.ts";

function apply(events: Parameters<typeof connectionReducer>[1][]): ConnectionState {
  return events.reduce(connectionReducer, initialConnection);
}

test("the first failure asks for exactly one ICE restart", () => {
  const state = apply(["failed"]);
  assert.deepEqual(state, { phase: "reconnecting", restarts: 1 });
});

test("a second failure while reconnecting goes straight to the reconnect screen", () => {
  assert.deepEqual(apply(["failed", "failed"]), { phase: "lost", restarts: 1 });
});

test("a failed restart times out into the reconnect screen", () => {
  assert.deepEqual(apply(["failed", "timeout"]), { phase: "lost", restarts: 1 });
  assert.deepEqual(apply(["timeout"]), initialConnection);
});

test("recovery resets the budget for the next failure", () => {
  assert.deepEqual(apply(["failed", "connected", "failed"]), {
    phase: "reconnecting",
    restarts: 1,
  });
  assert.deepEqual(apply(["failed", "timeout", "connected"]), {
    phase: "connected",
    restarts: 0,
  });
});

test("canRestartIce follows the two-restart budget", () => {
  assert.equal(MAX_ICE_RESTARTS, 2);
  assert.equal(canRestartIce(0), true);
  assert.equal(canRestartIce(1), true);
  assert.equal(canRestartIce(2), false);
});

test("checking re-arms a restart without spending the budget", () => {
  assert.deepEqual(apply(["failed", "checking"]), {
    phase: "reconnecting",
    restarts: 1,
    rearmed: true,
  });
  assert.deepEqual(apply(["failed", "checking", "failed"]), {
    phase: "reconnecting",
    restarts: 2,
  });

  assert.deepEqual(apply(["checking", "checking"]), initialConnection);
  assert.deepEqual(apply(["connected", "checking"]), { phase: "connected", restarts: 0 });
  assert.deepEqual(apply(["failed", "failed", "checking"]), { phase: "lost", restarts: 1 });

  const lost = apply(["failed", "failed", "checking"]);
  assert.equal("rearmed" in lost, false);
});

test("a third failure after re-arming exhausts the budget into lost", () => {
  assert.deepEqual(apply(["failed", "checking", "failed", "checking", "failed"]), {
    phase: "lost",
    restarts: 2,
  });
  assert.deepEqual(apply(["failed", "checking", "failed", "checking", "failed", "failed"]), {
    phase: "lost",
    restarts: 2,
  });
});

test("a timeout after the second restart goes to lost and keeps the count", () => {
  assert.deepEqual(apply(["failed", "checking", "failed", "checking", "timeout"]), {
    phase: "lost",
    restarts: 2,
  });
  assert.deepEqual(apply(["failed", "checking", "timeout"]), {
    phase: "lost",
    restarts: 1,
  });
});

test("connected clears rearmed and the restart budget from reconnecting", () => {
  const state = apply(["failed", "checking", "connected"]);
  assert.deepEqual(state, { phase: "connected", restarts: 0 });
  assert.equal("rearmed" in state, false);
});

test("a duplicate failed before checking is ignored and keeps the second restart", () => {
  assert.equal(failureEvent(false), "failed");
  assert.equal(failureEvent(true), "duplicate");

  const first = apply(["failed"]);
  assert.deepEqual(connectionReducer(first, "duplicate"), first);

  // O duplicado do outro handler não gasta o segundo restart, mesmo sem "checking".
  assert.deepEqual(apply(["failed", "duplicate", "checking", "failed"]), {
    phase: "reconnecting",
    restarts: 2,
  });
});
