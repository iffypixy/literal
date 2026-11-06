// Precaches the whole app at install, so it opens instantly and with no network.
// The build fills in Version and Files (see vite.config.ts).
const Version = "__VERSION__";
const Files = ["__FILES__"];

self.addEventListener("install", (event) => event.waitUntil(install()));
self.addEventListener("activate", (event) => event.waitUntil(activate()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // Every address is the app's one page, except the few pages of their own (the terms and privacy policy).
  const page = Files.includes(url.pathname) ? url.pathname : "/";
  event.respondWith(respond(request.mode === "navigate" ? page : request, request));
});

async function install() {
  const cache = await caches.open(Version);
  await cache.addAll(Files);
  await self.skipWaiting();
}

async function activate() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== Version).map((key) => caches.delete(key)));
  await self.clients.claim();
}

async function respond(key, request) {
  // Scripts and stylesheets are requested with an Origin header the cached copies were fetched without.
  const hit = await caches.match(key, { cacheName: Version, ignoreVary: true });
  return hit ?? fetch(request);
}
