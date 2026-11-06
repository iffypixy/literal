import assert from "node:assert/strict";
import { test } from "node:test";
import { velocityOf } from "#/web/lib/velocity.ts";

test("a steady drag moves at its own speed", () => {
  const samples = [
    { positionPx: 0, timeMs: 0 },
    { positionPx: 10, timeMs: 10 },
    { positionPx: 20, timeMs: 20 },
  ];

  const velocity = velocityOf(samples, 20);

  assert.equal(velocity, 1000);
});

test("a pause before a flick isn't counted in its speed", () => {
  // Held still for 300ms, which sends nothing, then flicked 50px in 50ms.
  const samples = [
    { positionPx: 0, timeMs: 0 },
    { positionPx: 16, timeMs: 300 },
    { positionPx: 33, timeMs: 316 },
    { positionPx: 50, timeMs: 350 },
  ];

  const velocity = velocityOf(samples, 350);

  assert.equal(velocity, 680);
});

test("a drag held still before it's let go has stopped", () => {
  const samples = [
    { positionPx: 0, timeMs: 0 },
    { positionPx: 100, timeMs: 100 },
  ];

  const velocity = velocityOf(samples, 400);

  assert.equal(velocity, 0);
});
