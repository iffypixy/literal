import * as Y from "yjs";
import { Apple } from "#web/device.ts";
import { pressed } from "#web/shortcuts.ts";
import { diff, end, shift, type Delta } from "./diff.ts";

/** Marks the changes this textarea makes, so they aren't echoed back into it. */
const Typed = Symbol("typed");
/** Typing within this many milliseconds undoes as one step. */
const UndoStep = 600;

/**
 * Keeps a textarea and a Yjs text the same, both ways. Typing goes into the text as the smallest change;
 * changes from elsewhere go into the textarea without moving the cursor. Undo only undoes what was typed here.
 *
 * If the text is empty and the textarea isn't, the textarea's content counts as typed: that's how a new note starts.
 */
export function bind(area: HTMLTextAreaElement, text: Y.Text): () => void {
  if (!text.doc) throw new Error("bind: the text is in no document");
  const doc = text.doc;
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([Typed]), captureTimeout: UndoStep });
  /** What the textarea showed when it was last in step with the text. */
  let shown = "";
  /** Changes from elsewhere, waiting for the textarea to be free. */
  let held: Delta[] = [];
  let composing = false;

  if (text.length === 0 && area.value) {
    type();
  } else {
    shown = text.toString();
    area.value = shown;
  }

  function type() {
    const change = diff(shown, area.value, area.selectionEnd);
    shown = area.value;
    if (!change) return;
    // Text that arrived mid-composition sits in the Yjs text but not yet on screen.
    const at = held.reduce((index, delta) => shift(index, delta), change.at);
    doc.transact(() => {
      if (change.removed) text.delete(at, change.removed);
      if (change.inserted) text.insert(at, change.inserted);
    }, Typed);
  }

  function receive(event: Y.YTextEvent, transaction: Y.Transaction) {
    if (transaction.origin === Typed) return;
    const delta = event.delta;
    // Mid-composition the textarea can't be touched; while the tab is hidden nobody sees it, and a long note
    // would be redrawn for every word another tab types. Both wait.
    if (composing || document.hidden) {
      held.push(delta);
      return;
    }
    show([delta], transaction.origin === undo ? end(delta) : null);
  }

  /** Carries the selection over the changes, or puts it at `caret` after an undo. */
  function show(deltas: Delta[], caret: number | null) {
    const scroll = area.scrollTop;
    let start = area.selectionStart;
    let finish = area.selectionEnd;
    for (const delta of deltas) {
      start = shift(start, delta);
      finish = shift(finish, delta);
    }
    const direction = area.selectionDirection;
    shown = text.toString();
    area.value = shown;
    if (caret === null) {
      area.setSelectionRange(start, finish, direction);
      area.scrollTop = scroll;
    } else {
      // Moving the caret also scrolls it into view: an undo shows what it undid.
      area.setSelectionRange(caret, caret);
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (pressed(event, "Mod+Z")) {
      event.preventDefault();
      undo.undo();
    } else if (pressed(event, "Mod+Shift+Z") || (!Apple && pressed(event, "Mod+Y"))) {
      event.preventDefault();
      undo.redo();
    } else if (pressed(event, "Tab")) {
      event.preventDefault();
      area.setRangeText("\t", area.selectionStart, area.selectionEnd, "end");
      type();
    }
  }

  // Undo from the menu, the context menu, or shaking the phone.
  function onBeforeInput(event: InputEvent) {
    // A browser keeps one undo history for the whole page: ⌘Z in another field, once that field has nothing
    // left to undo, arrives here. Only an undo meant for the note may touch it.
    if (event.inputType.startsWith("history") && document.activeElement !== area) {
      event.preventDefault();
      return;
    }
    if (event.inputType === "historyUndo") {
      event.preventDefault();
      undo.undo();
    } else if (event.inputType === "historyRedo") {
      event.preventDefault();
      undo.redo();
    }
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd() {
    // Some browsers send the composition's last input right after this event: changes keep waiting until it lands.
    setTimeout(() => {
      composing = false;
      release();
    });
  }

  function onVisibilityChange() {
    if (!document.hidden && !composing) release();
  }

  function release() {
    if (!held.length) return;
    const deltas = held;
    held = [];
    show(deltas, null);
  }

  text.observe(receive);
  area.addEventListener("input", type);
  area.addEventListener("keydown", onKeydown);
  area.addEventListener("beforeinput", onBeforeInput);
  area.addEventListener("compositionstart", onCompositionStart);
  area.addEventListener("compositionend", onCompositionEnd);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    text.unobserve(receive);
    area.removeEventListener("input", type);
    area.removeEventListener("keydown", onKeydown);
    area.removeEventListener("beforeinput", onBeforeInput);
    area.removeEventListener("compositionstart", onCompositionStart);
    area.removeEventListener("compositionend", onCompositionEnd);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    undo.destroy();
  };
}
