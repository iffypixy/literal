import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.body });

// iOS Safari only shows a button's :active press on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // After load, so installing the cache never competes with the first paint.
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
