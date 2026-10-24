/**
 * Keeps Literal up to date. A new version installs in the background, then takes over while the page is hidden
 * and nothing is open on it, so nobody sees it happen or loses what they were in the middle of.
 */
export function stayUpToDate(busy: () => boolean) {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const workers = navigator.serviceWorker;
  // The first version to run this page installs itself; only one after it is an update.
  let controlled = Boolean(workers.controller);
  let ready = false;

  // After load, so installing the cache never competes with the first paint.
  addEventListener("load", () => {
    void workers.register("/sw.js").then((registration) => {
      // Coming back to Literal asks for a new version.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void registration.update();
      });
    });
  });

  workers.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    ready = true;
    takeOver();
  });
  // Added after App's own listener, which saves and rescues everything as the page hides: that runs first.
  document.addEventListener("visibilitychange", takeOver);

  function takeOver() {
    if (ready && document.hidden && !busy()) location.reload();
  }
}
