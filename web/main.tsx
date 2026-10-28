import { render } from "solid-js/web";
import { App } from "./app.tsx";
import { installed } from "./device.ts";

const early = document.querySelector(".early");
if (!(early instanceof HTMLTextAreaElement)) throw new Error("start: index.html's stand-in page is missing");
// Words typed on the stand-in page at a note's address would have nowhere to go: they start a note of their own.
if (early.value.trim() && location.pathname !== "/") history.replaceState(null, "", "/");
render(() => <App />, document.body);
handOver(early);

// iOS Safari only shows a button's :active press on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

// Installed, Literal asks to keep its storage even when the device runs short of space: the notes live there.
if (installed.matches) void navigator.storage?.persist();

// iOS doesn't shrink the page for the keyboard; this keeps the end of the text above it. A pinch zoom shrinks what's
// visible too, but not the page: scaled back, it leaves the page its size.
const viewport = window.visualViewport;
viewport?.addEventListener("resize", () => {
  document.documentElement.style.setProperty("--viewport-height", `${viewport.height * viewport.scale}px`);
});

/** Moves what was typed on the stand-in page into the editor, as if typed there, with the cursor where it was. */
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
