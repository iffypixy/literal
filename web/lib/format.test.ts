import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, plural } from "#/web/lib/format.ts";

const Now = new Date(2026, 10, 6, 15, 30).getTime();

test("an edit under a minute old was just now", () => {
  assert.equal(ago(Now - 59_000, Now), "Just now");
});

test("an edit under an hour old is counted in minutes", () => {
  assert.equal(ago(Now - 5 * 60_000, Now), "5m");
});

test("an edit earlier today shows its time", () => {
  assert.match(ago(new Date(2026, 10, 6, 9, 5).getTime(), Now), /9:05/);
});

test("an edit the day before is yesterday, however late it was", () => {
  assert.equal(ago(new Date(2026, 10, 5, 23, 59).getTime(), Now), "Yesterday");
});

test("an edit earlier this year shows its day", () => {
  assert.equal(ago(new Date(2026, 2, 4).getTime(), Now), "Mar 4");
});

test("an edit from another year shows its year too", () => {
  assert.equal(ago(new Date(2025, 2, 4).getTime(), Now), "Mar 4, 2025");
});

test("one of a thing is singular", () => {
  assert.equal(plural(1, "note"), "1 note");
});

test("a count of things is plural, with separators", () => {
  assert.equal(plural(2000, "note"), "2,000 notes");
});
