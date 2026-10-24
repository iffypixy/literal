import { render } from "solid-js/web";
import { App } from "./app.tsx";
import { installed } from "./device.ts";

const early = document.querySelector(".early");
// Words typed on the stand-in page at a note's address would have nowhere to go: they start a note of their own.
if (early instanceof HTMLTextAreaElement && early.value.trim() && location.pathname !== "/") {
  history.replaceState(null, "", "/");
}
render(() => <App />, document.body);
if (early instanceof HTMLTextAreaElement) handOver(early);

// iOS Safari only shows a button's :active press on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

// Installed, Literal asks to keep its storage even when the device runs short of space: the notes live there.
if (installed.matches) void navigator.storage?.persist();

/**
 * Moves what was typed on index.html's stand-in page into the editor, as if typed there, and puts the cursor
 * where it was. Only on the blank page: an address with a note opens that note instead.
 */
function handOver(early: HTMLTextAreaElement) {
  const editor = document.querySelector(".editor:not(.early)");
  if (!(editor instanceof HTMLTextAreaElement)) throw new Error("hand over: the editor isn't there");
  const focused = document.activeElement === early;
  if (early.value && location.pathname === "/") {
    editor.value = early.value;
    editor.setSelectionRange(early.selectionStart, early.selectionEnd);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
  early.remove();
  if (focused) editor.focus();
}
