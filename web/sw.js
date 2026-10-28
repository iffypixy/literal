// Precaches the whole app at install, so it opens instantly and with no network.
// The build fills in Version and Files (see vite.config.ts).
const Version = "__VERSION__";
const Files = ["__FILES__"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(Version)
      .then((cache) => cache.addAll(Files))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== Version).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sync") return;
  // Every address is the app's one page, but for the few pages of their own (the terms, the privacy policy).
  const page = Files.includes(url.pathname) ? url.pathname : "/";
  const key = request.mode === "navigate" ? page : request;
  // Scripts and fonts are requested with an Origin header the cached copies were fetched without.
  event.respondWith(caches.match(key, { cacheName: Version, ignoreVary: true }).then((hit) => hit ?? fetch(request)));
});
