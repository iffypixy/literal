import assert from "node:assert/strict";
import { test } from "node:test";
import { velocityOf } from "./velocity.ts";

test("a steady drag moves at its own speed", () => {
  const samples = [
    { at: 0, time: 0 },
    { at: 10, time: 10 },
    { at: 20, time: 20 },
  ];

  const velocity = velocityOf(samples, 20);

  assert.equal(velocity, 1000);
});

test("a pause before a flick isn't counted in its speed", () => {
  // Held still for 300ms, which sends nothing, then flicked 50px in 50ms.
  const samples = [
    { at: 0, time: 0 },
    { at: 16, time: 300 },
    { at: 33, time: 316 },
    { at: 50, time: 350 },
  ];

  const velocity = velocityOf(samples, 350);

  assert.equal(velocity, 680);
});

test("a drag held still before it's let go has stopped", () => {
  const samples = [
    { at: 0, time: 0 },
    { at: 100, time: 100 },
  ];

  const velocity = velocityOf(samples, 400);

  assert.equal(velocity, 0);
});
