// Keeps scan images on this device: once an image file has been downloaded it is served from the
// device's storage, so reopening a scan is instant. files.json and pages always come from the site.
const CACHE = "scan-files-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith("/files/") || u.pathname.endsWith("/files.json")) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(u.pathname);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok && res.status === 200) cache.put(u.pathname, res.clone()).catch(() => {});
    return res;
  })());
});
