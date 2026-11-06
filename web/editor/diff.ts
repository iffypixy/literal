/** Pure text arithmetic for binding.ts: what changed between two texts, and where positions go after a change. */

import type * as Y from "yjs";

export type Delta = Y.YTextEvent["delta"];

/** A change to a text: `removed` characters at `at` gave way to `inserted`. */
export type Change = { at: number; removed: number; inserted: string };

/**
 * Everything between the two texts' common start and end. Never splits a surrogate pair, which would put half an
 * emoji into the doc. Where repeated characters allow more than one answer, the change ends at `caret`, where it was
 * typed. The change almost always sits just before `caret`, so the common start and end are first checked there in
 * one comparison each, and typing in a long note doesn't walk the whole text.
 */
export function diff(before: string, after: string, caret: number): Change | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  const typedAt = caret - Math.max(0, after.length - before.length);

  const startGuess = Math.min(limit, Math.max(0, typedAt));
  let start = before.slice(0, startGuess) === after.slice(0, startGuess) ? startGuess : 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;

  const tailGuess = Math.min(limit, Math.max(0, after.length - caret));
  let tail = before.slice(before.length - tailGuess) === after.slice(after.length - tailGuess) ? tailGuess : 0;
  while (tail < limit && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) {
    tail++;
  }

  // The common start and end may overlap in a run of repeated characters; any split of the run is as small.
  const kept = Math.min(limit, start + tail);
  let at = Math.min(start, Math.max(kept - tail, typedAt));
  if (at > 0 && isHighSurrogate(before.charCodeAt(at - 1))) at--;
  let end = Math.min(tail, limit - at);
  if (end > 0 && isLowSurrogate(after.charCodeAt(after.length - end))) end--;

  return { at, removed: before.length - at - end, inserted: after.slice(at, after.length - end) };
}

/** Text inserted before `index` pushes it along; text inserted right at it goes after it. */
export function shift(index: number, delta: Delta): number {
  let at = 0;
  let moved = index;
  for (const op of delta) {
    if (at > index) break;
    if (op.retain !== undefined) {
      at += op.retain;
    } else if (typeof op.insert === "string") {
      if (at < index) moved += op.insert.length;
    } else if (op.delete !== undefined) {
      moved -= Math.max(0, Math.min(op.delete, index - at));
      at += op.delete;
    }
  }
  return moved;
}

/**
 * Where `index` in a textarea lands in the text it shows, when `deltas` reached the text but not the textarea, and the
 * textarea's own `change` went into the text after them. Inside the change, a position keeps its place in it.
 */
export function landingOf(index: number, deltas: Delta[], change?: Change): number {
  if (!change || index <= change.at) return shiftAll(index, deltas);
  const changeEnd = change.at + change.inserted.length;
  if (index < changeEnd) return shiftAll(change.at, deltas) + index - change.at;
  return shiftAll(index - changeEnd + change.at + change.removed, deltas) - change.removed + change.inserted.length;
}

/** Where the last change in `delta` ends, in the new text. */
export function end(delta: Delta): number {
  let at = 0;
  let last = 0;
  for (const op of delta) {
    if (op.retain !== undefined) at += op.retain;
    else if (typeof op.insert === "string") last = at += op.insert.length;
    else last = at;
  }
  return last;
}

function shiftAll(index: number, deltas: Delta[]): number {
  let moved = index;
  for (const delta of deltas) moved = shift(moved, delta);
  return moved;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
