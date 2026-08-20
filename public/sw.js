// Wing OS service worker.
// Strategy (network-first so a new deploy is ALWAYS picked up):
//   - /api/*        network only (never cache authed API data)
//   - everything    network-first; cache is only an OFFLINE fallback
// Bump CACHE_VERSION on any strategy change to purge old caches.
const CACHE_VERSION = "wing-os-v4";
const OFFLINE_ASSETS = ["/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(OFFLINE_ASSETS)));
  // Activate this new worker immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Let the page tell a waiting worker to take over now.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Authed, live API data: always straight to network, never cached.
  if (url.pathname.startsWith("/api/")) return;

  // Everything else: network-first. Serve fresh on every load; fall back to
  // cache only when the network is unavailable (offline). Hashed _next assets
  // and the app shell therefore always reflect the latest deploy.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((hit) => hit || caches.match("/manifest.json"))
      )
  );
});

// ── Web push (24/7 watchdog alerts) ──────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Wing OS" }; }
  const title = data.title || "Wing OS";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || "wing-os",
      data: { url: data.url || "/mission" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/mission";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) { w.focus(); w.navigate(url); return; }
      }
      return clients.openWindow(url);
    })
  );
});
