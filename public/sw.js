// Wing OS service worker.
// Strategy:
//   - /api/*        network only (never cache authed API data)
//   - static assets cache-first (icons, fonts, _next/static)
//   - navigations   network-first with a cached fallback
const STATIC_CACHE = "wing-os-static-v1";
const STATIC_PATTERNS = [/^\/_next\/static\//, /^\/icon-\d+\.png$/, /^\/manifest\.json$/, /^\/favicon\.ico$/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(["/manifest.json", "/icon-192.png", "/icon-512.png"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never cache API responses (they are authed and live).
  if (url.pathname.startsWith("/api/")) return;

  // Static assets: cache-first.
  if (STATIC_PATTERNS.some((re) => re.test(url.pathname))) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(event.request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Navigations: network-first, fall back to any cached copy when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request).then((hit) => hit || caches.match("/")))
    );
  }
});
