import * as Y from "yjs";
import { letter, mod } from "../keys.ts";

/** The changes a Yjs text event describes, in Yjs' own delta format. */
type Delta = { insert?: unknown; retain?: number; delete?: number }[];

/** Marks the changes this textarea makes, so they aren't echoed back into it. */
const TYPED = Symbol("typed");

/**
 * Keeps a textarea and a Yjs text the same, both ways. Typing goes into the text as the smallest change;
 * changes from elsewhere go into the textarea without moving the cursor. Undo only undoes what was typed here.
 *
 * If the text is empty and the textarea isn't, the textarea's content counts as typed: that's how a new note starts.
 */
export function bind(area: HTMLTextAreaElement, text: Y.Text): () => void {
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([TYPED]), captureTimeout: 600 });
  /** What the textarea showed when it was last in step with the text. */
  let shown = "";
  /** Changes from elsewhere that came in mid-composition, when the textarea can't be touched. */
  let held: Delta[] = [];
  let composing = false;

  if (text.length === 0 && area.value) {
    type();
  } else {
    shown = text.toString();
    area.value = shown;
  }

  function type() {
    const change = diff(shown, area.value);
    shown = area.value;
    if (!change) return;
    // Text that arrived mid-composition sits in the Yjs text but not yet on screen.
    const at = held.reduce((index, delta) => shift(index, delta), change.at);
    text.doc?.transact(() => {
      if (change.removed) text.delete(at, change.removed);
      if (change.inserted) text.insert(at, change.inserted);
    }, TYPED);
  }

  function receive(event: Y.YTextEvent, transaction: Y.Transaction) {
    if (transaction.origin === TYPED) return;
    const delta = event.delta as Delta;
    if (composing) {
      held.push(delta);
      return;
    }
    show([delta], transaction.origin === undo ? end(delta) : null);
  }

  /** Puts the text on screen, carrying the selection over the changes, or to `caret` after an undo. */
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
    if (mod(event) && !event.altKey && letter(event, "z")) {
      event.preventDefault();
      if (event.shiftKey) undo.redo();
      else undo.undo();
    } else if (!event.metaKey && event.ctrlKey && letter(event, "y")) {
      event.preventDefault();
      undo.redo();
    } else if (event.key === "Tab" && !event.shiftKey && !mod(event) && !event.altKey) {
      event.preventDefault();
      area.setRangeText("\t", area.selectionStart, area.selectionEnd, "end");
      type();
    }
  }

  // Undo from the menu, the context menu, or shaking the phone.
  function onBeforeInput(event: InputEvent) {
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
    composing = false;
    if (!held.length) return;
    // Some browsers send the composition's last input right after this event; let it land first.
    setTimeout(() => {
      const deltas = held;
      held = [];
      show(deltas, null);
    });
  }

  text.observe(receive);
  area.addEventListener("input", type);
  area.addEventListener("keydown", onKeydown);
  area.addEventListener("beforeinput", onBeforeInput);
  area.addEventListener("compositionstart", onCompositionStart);
  area.addEventListener("compositionend", onCompositionEnd);

  return () => {
    text.unobserve(receive);
    area.removeEventListener("input", type);
    area.removeEventListener("keydown", onKeydown);
    area.removeEventListener("beforeinput", onBeforeInput);
    area.removeEventListener("compositionstart", onCompositionStart);
    area.removeEventListener("compositionend", onCompositionEnd);
    undo.destroy();
  };
}

/**
 * The one replaced range between two versions of the text: everything between their common start and end.
 * Never splits a surrogate pair, which would put half an emoji into the doc.
 */
function diff(before: string, after: string): { at: number; removed: number; inserted: string } | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let tail = 0;
  while (
    tail < limit - start &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  )
    tail++;
  if (tail > 0 && isLowSurrogate(after.charCodeAt(after.length - tail))) tail--;
  return { at: start, removed: before.length - start - tail, inserted: after.slice(start, after.length - tail) };
}

/** Where `index` ends up after the change. Text inserted before it pushes it along; text inserted right at it goes after it. */
function shift(index: number, delta: Delta): number {
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
function end(delta: Delta): number {
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
