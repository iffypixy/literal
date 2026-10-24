import { flushSync, mount } from "svelte";
import App from "./App.svelte";

const early = document.querySelector<HTMLTextAreaElement>(".early");
mount(App, { target: document.body });
flushSync();
if (early) handOver(early);

// iOS Safari only shows a button's :active press on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // After load, so installing the cache never competes with the first paint.
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}

/**
 * Moves what was typed on index.html's stand-in page into the editor, as if typed there, and puts the cursor
 * where it was. Only on the blank page: an address with a note opens that note instead.
 */
function handOver(early: HTMLTextAreaElement) {
  const editor = document.querySelector<HTMLTextAreaElement>(".editor:not(.early)");
  const focused = document.activeElement === early;
  if (editor && early.value && location.pathname === "/") {
    editor.value = early.value;
    editor.setSelectionRange(early.selectionStart, early.selectionEnd);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
  early.remove();
  if (focused) editor?.focus();
}
