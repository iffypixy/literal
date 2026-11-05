/** Pure text arithmetic for binding.ts: what changed between two texts, and where positions go after a change. */

import type * as Y from "yjs";

export type Delta = Y.YTextEvent["delta"];

/**
 * Everything between the two texts' common start and end. Never splits a surrogate pair, which would put half an
 * emoji into the doc. The change almost always sits just before `caret`, so the common start and end are first
 * checked there in one comparison each, and typing in a long note doesn't walk the whole text.
 */
export function diff(
  before: string,
  after: string,
  caret: number,
): { at: number; removed: number; inserted: string } | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  const grown = Math.max(0, after.length - before.length);
  let start = Math.min(limit, Math.max(0, caret - grown));
  if (before.slice(0, start) !== after.slice(0, start)) start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let tail = Math.min(limit - start, Math.max(0, after.length - caret));
  if (before.slice(before.length - tail) !== after.slice(after.length - tail)) tail = 0;
  while (
    tail < limit - start &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  )
    tail++;
  if (tail > 0 && isLowSurrogate(after.charCodeAt(after.length - tail))) tail--;
  return { at: start, removed: before.length - start - tail, inserted: after.slice(start, after.length - tail) };
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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
