// Precaches the whole app at install, so it opens instantly and with no network.
// The build fills in VERSION and FILES (see vite.config.ts).
const VERSION = "__VERSION__";
const FILES = ["__FILES__"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sync") return;
  // Every page of the app is the same single page.
  const key = request.mode === "navigate" ? page(url.pathname) : request;
  // Scripts and fonts are requested with an Origin header the cached copies were fetched without.
  event.respondWith(caches.match(key, { cacheName: VERSION, ignoreVary: true }).then((hit) => hit ?? fetch(request)));
});

function page(path) {
  return path === "/privacy" || path === "/terms" ? path : "/";
}
