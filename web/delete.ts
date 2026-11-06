/**
 * Deleting a note, with a toast to undo it. Deletes in a row share the toast, and one Undo brings them all back.
 * Right after a delete, ⌘Z undoes it too, wherever the cursor is, until something is typed.
 */

import * as notes from "#web/notes/notes.ts";
import { quoted } from "#web/notes/search.ts";
import { dismiss, runAction, toast } from "#web/ui/toast.tsx";
import { plural } from "./format.ts";
import { pressed, Shortcuts } from "./shortcuts.ts";

/** A deleted note, with what puts it back on screen. */
type Deleted = { id: string; reopen: () => void };

/** Notes deleted while the current toast shows. */
let deleted: Deleted[] = [];
let undoable = false;

/** `reopen` runs once Undo has brought the note back. A note that wasn't deleted gets no toast. */
export async function deleteNote(id: string, reopen: () => void) {
  // Named, since Delete acts on whichever row is highlighted, which may not be the note you're in.
  const name = quoted(notes.find(id)?.text ?? "");
  if (!(await notes.remove(id))) return;
  if (deleted.length) dismiss();
  deleted.push({ id, reopen });
  const batch = deleted;
  const what = batch.length > 1 ? plural(batch.length, "note") : name;
  toast(what ? `Deleted ${what}` : "Note deleted", {
    action: {
      label: "Undo",
      keys: Shortcuts.undo,
      run: () => void undo(batch),
    },
    onExpire: () => {
      endBatch();
      for (const note of batch) notes.settle(note.id);
    },
  });
  undoable = true;
}

async function undo(batch: Deleted[]) {
  endBatch();
  for (const note of batch) if (await notes.restore(note.id)) note.reopen();
}

function endBatch() {
  deleted = [];
  undoable = false;
}

// Captured, so right after a delete ⌘Z reaches the note before the editor's own undo does.
addEventListener(
  "keydown",
  (event) => {
    if (!undoable || !pressed(event, Shortcuts.undo)) return;
    event.preventDefault();
    event.stopPropagation();
    runAction();
  },
  true,
);

addEventListener("input", () => (undoable = false));
