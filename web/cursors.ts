/** Where the cursor was in each note, and how far it was scrolled. Kept on this device only. */

import * as z from "zod/mini";
import { PositionSchema, type Position } from "#/web/editor.tsx";
import { attempt } from "#/web/lib/attempt.ts";
import * as storage from "#/web/lib/storage.ts";

const CursorsSchema = z.array(z.tuple([z.string(), PositionSchema]));

const Key = "cursors";
const MaxKept = 200;

// Newest last.
const cursors = new Map<string, Position>(saved());

export function recall(id: string): Position | undefined {
  return cursors.get(id);
}

export function remember(id: string, position: Position) {
  cursors.delete(id);
  cursors.set(id, position);
  for (const oldest of cursors.keys()) {
    if (cursors.size <= MaxKept) break;
    cursors.delete(oldest);
  }
  storage.write(Key, JSON.stringify([...cursors]));
}

function saved(): [string, Position][] {
  const value: unknown = attempt(() => JSON.parse(storage.read(Key) ?? "[]"), undefined);
  return CursorsSchema.safeParse(value).data ?? [];
}
