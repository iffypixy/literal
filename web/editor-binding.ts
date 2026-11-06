import * as Y from "yjs";
import { diff, end, landingOf, type Change, type Delta } from "#/web/editor-diff.ts";
import { isApple } from "#/web/lib/device.ts";
import { pressed } from "#/web/lib/keyboard.ts";

// The origin of the changes this textarea makes, so they aren't echoed back into it.
const Typed = "typed";
// Typing within this long undoes as one step.
const UndoStepMs = 600;

/**
 * Keeps a textarea and a Yjs text the same until unbound. Words already in the textarea, bound to an empty text, count
 * as typed, which is how a new note starts.
 */
export function bind(area: HTMLTextAreaElement, text: Y.Text): () => void {
  if (!text.doc) throw new Error("bind: the text is in no document");
  const doc = text.doc;
  // Undo undoes only what was typed here.
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([Typed]), captureTimeout: UndoStepMs });
  // What the textarea showed when it was last in step with the text.
  let shown = "";
  // Changes from elsewhere, waiting for the textarea to be free.
  let held: Delta[] = [];
  let composing = false;
  // A composition's end, put off a moment. A new one may start before it comes.
  let ending: ReturnType<typeof setTimeout> | undefined;

  if (text.length === 0 && area.value) {
    type();
  } else {
    shown = text.toString();
    area.value = shown;
  }

  function type() {
    // Changes held mid-composition are placed against what the textarea showed when they came. Until they show, what's
    // composed waits, and goes in as one change when the composition ends.
    if (composing && held.length) return;
    const change = diff(shown, area.value, area.selectionEnd);
    shown = area.value;
    if (!change) return;

    // Text that arrived mid-composition sits in the Yjs text but not yet on screen.
    const at = landingOf(change.at, held);
    doc.transact(() => {
      if (change.removed) text.delete(at, change.removed);
      if (change.inserted) text.insert(at, change.inserted);
    }, Typed);
    release(change);
  }

  function receive(event: Y.YTextEvent, transaction: Y.Transaction) {
    if (transaction.origin === Typed) return;
    // Mid-composition the textarea can't be touched; while the tab is hidden nobody sees it, and a long note would be
    // redrawn for every word another tab types. Both wait.
    if (composing || document.hidden) {
      held.push(event.delta);
      return;
    }
    if (transaction.origin === undo) showUndone(event.delta);
    else show([event.delta]);
  }

  // Carries the selection over the changes, and over the textarea's own `change` made since they came.
  function show(deltas: Delta[], change?: Change) {
    const scroll = area.scrollTop;
    const start = landingOf(area.selectionStart, deltas, change);
    const finish = landingOf(area.selectionEnd, deltas, change);
    const direction = area.selectionDirection;
    shown = text.toString();
    area.value = shown;
    area.setSelectionRange(start, finish, direction);
    area.scrollTop = scroll;
  }

  // Moving the caret to the end of what was undone also scrolls it into view.
  function showUndone(delta: Delta) {
    shown = text.toString();
    area.value = shown;
    const caret = end(delta);
    area.setSelectionRange(caret, caret);
  }

  function release(change?: Change) {
    if (!held.length) return;
    const deltas = held;
    held = [];
    show(deltas, change);
  }

  function handleKeyDown(event: KeyboardEvent) {
    // Read-only while the next note loads, and these would change this one regardless.
    if (area.readOnly) return;
    const redo = pressed(event, "Mod+Shift+Z") || (!isApple && pressed(event, "Mod+Y"));
    if (pressed(event, "Mod+Z")) {
      event.preventDefault();
      undo.undo();
    } else if (redo) {
      event.preventDefault();
      undo.redo();
    } else if (pressed(event, "Tab")) {
      event.preventDefault();
      area.setRangeText("\t", area.selectionStart, area.selectionEnd, "end");
      type();
    }
  }

  // Undo from the menu, the context menu, or shaking the phone.
  function handleBeforeInput(event: InputEvent) {
    if (!event.inputType.startsWith("history")) return;
    event.preventDefault();
    // A browser keeps one undo history for the whole page, so ⌘Z in another field arrives here once that field has
    // nothing left to undo. Only an undo meant for the note may touch it.
    if (document.activeElement !== area) return;
    if (event.inputType === "historyUndo") undo.undo();
    else undo.redo();
  }

  function handleCompositionStart() {
    clearTimeout(ending);
    composing = true;
  }

  function handleCompositionEnd() {
    // Some browsers send the composition's last input right after this event, so changes wait until it lands.
    ending = setTimeout(() => {
      composing = false;
      type();
      release();
    });
  }

  function handleVisibilityChange() {
    if (!document.hidden && !composing) release();
  }

  const listening = new AbortController();
  const { signal } = listening;
  text.observe(receive);
  area.addEventListener("input", type, { signal });
  area.addEventListener("keydown", handleKeyDown, { signal });
  area.addEventListener("beforeinput", handleBeforeInput, { signal });
  area.addEventListener("compositionstart", handleCompositionStart, { signal });
  area.addEventListener("compositionend", handleCompositionEnd, { signal });
  document.addEventListener("visibilitychange", handleVisibilityChange, { signal });

  return () => {
    clearTimeout(ending);
    listening.abort();
    text.unobserve(receive);
    undo.destroy();
  };
}
