/**
 * Deleting a note, with a toast to undo it. Deletes in a row share the toast, and one Undo brings them all back.
 * Right after a delete, ⌘Z undoes it too, wherever the cursor is, until something is typed.
 */

import * as notes from "#web/notes/notes.ts";
import { quoted } from "#web/notes/search.ts";
import { dismiss, runAction, toast } from "#web/ui/toast.tsx";
import { touch } from "./device.ts";
import { plural } from "./format.ts";
import { pressed, Shortcuts } from "./shortcuts.ts";

/** Notes deleted while the current toast shows, each with what puts it back on screen. */
let deleted: { id: string; reopen: () => void }[] = [];
let undoable = false;

/** `reopen` runs once Undo has brought the note back. */
export function deleteNote(id: string, reopen: () => void) {
  // Named, since Delete acts on whichever row is highlighted, which may not be the note you're in.
  const name = quoted(notes.find(id)?.text ?? "");
  void notes.remove(id);
  if (deleted.length) dismiss();
  deleted.push({ id, reopen });
  const batch = deleted;
  const what = batch.length > 1 ? plural(batch.length, "note") : name;
  toast(what ? `Deleted ${what}` : "Note deleted", {
    action: {
      label: "Undo",
      keys: touch.matches ? undefined : Shortcuts.undo,
      run: () => {
        settled();
        void Promise.all(batch.map((note) => notes.restore(note.id))).then(() => {
          for (const note of batch) note.reopen();
        });
      },
    },
    onExpire: () => {
      settled();
      for (const note of batch) notes.settle(note.id);
    },
  });
  // Set after the toast, because showing it expires the last one, which clears this.
  undoable = true;
}

function settled() {
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
