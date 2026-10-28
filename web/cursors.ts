/** Where the cursor was in each note, and how far it was scrolled: kept on this device only. */

import type { Position } from "./editor/editor.tsx";
import * as storage from "./storage.ts";

const Key = "cursors";
const Kept = 200;

/** Newest last. */
const cursors = new Map<string, Position>(saved());

export function recall(id: string): Position | undefined {
  return cursors.get(id);
}

export function remember(id: string, position: Position) {
  cursors.delete(id);
  cursors.set(id, position);
  for (const oldest of cursors.keys()) {
    if (cursors.size <= Kept) break;
    cursors.delete(oldest);
  }
  storage.write(Key, JSON.stringify([...cursors]));
}

function saved(): [string, Position][] {
  let value: unknown;
  try {
    value = JSON.parse(storage.read(Key) ?? "[]");
  } catch {
    return []; // garbled: forget the cursors, keep the app
  }
  return Array.isArray(value) ? value.filter(isCursor) : [];
}

function isCursor(entry: unknown): entry is [string, Position] {
  if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) return false;
  const position: unknown[] = entry[1];
  return (position.length === 2 || position.length === 3) && position.every((at) => typeof at === "number");
}
