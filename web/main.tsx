import { render } from "solid-js/web";
import { App } from "#/web/app.tsx";
import { installed } from "#/web/lib/device.ts";

const early = document.querySelector(".early");
if (!(early instanceof HTMLTextAreaElement)) throw new Error("start: index.html's stand-in page is missing");
// Text typed before the app loaded, at a note's address, goes into a new note instead.
if (early.value.trim() && location.pathname !== "/") history.replaceState(null, "", "/");
render(() => <App />, document.body);
handOver(early);

// iOS Safari only shows a button's :active press on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

// Once installed, ask the browser to keep Literal's storage when space runs low, since that's where the notes live.
if (installed.matches) void navigator.storage?.persist();

// iOS doesn't shrink the page for the keyboard, so the page takes the visible height to keep the text above it.
// Pinch-zoom shrinks the visible height too, which multiplying by the zoom undoes.
const viewport = window.visualViewport;
viewport?.addEventListener("resize", () => {
  document.documentElement.style.setProperty("--viewport-height", `${viewport.height * viewport.scale}px`);
});

// Moves what was typed before the app loaded into the real editor, cursor and all, as if typed there.
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
