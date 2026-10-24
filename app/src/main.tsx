import { render } from "solid-js/web";
import { App } from "./app.tsx";

const early = document.querySelector<HTMLTextAreaElement>(".early");
render(() => <App />, document.body);
if (early) handOver(early);

// iOS Safari only shows a button's :active press on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // An update, not the first install: a page already had a version of Literal running it.
  const updating = Boolean(navigator.serviceWorker.controller);
  // After load, so installing the cache never competes with the first paint.
  addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").then((registration) => {
      // Coming back to Literal asks for a new version; one installs in the background.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void registration.update();
      });
    });
  });
  // Installed, the new version waits for the page to be hidden to swap in, so nobody sees it happen. App saves and
  // rescues everything as the page hides (its listener was added first, so it runs first).
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updating) return;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) location.reload();
    });
  });
}

// Installed, Literal asks to keep its storage even when the device runs short of space: the notes live there.
if (matchMedia("(display-mode: standalone)").matches) void navigator.storage?.persist();

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
