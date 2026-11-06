/**
 * Keeps Literal up to date. A new version installs in the background, then takes over while the page is hidden and
 * nothing is open on it, so nobody sees it happen or loses what they were in the middle of.
 */
export function stayUpToDate(busy: () => boolean) {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const workers = navigator.serviceWorker;
  // The first worker to control this page is the install. Only a later one is an update.
  let controlled = Boolean(workers.controller);
  let ready = false;

  // After load, so installing the cache never competes with the first paint.
  addEventListener("load", async () => {
    const registration = await workers.register("/sw.js");
    // Coming back to Literal asks for a new version.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void registration.update();
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
  // Safe whichever listener runs first, since reloading fires pagehide, where the notes save themselves.
  document.addEventListener("visibilitychange", takeOver);

  function takeOver() {
    if (ready && document.hidden && !busy()) location.reload();
  }
}
