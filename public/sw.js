// Mainfeed service worker
// Network-first for everything same-origin (always fresh on reload).
// Cache is offline fallback only. Skips /api/* and third-party.

const CACHE = 'mainfeed-v4';  // bump 2026-05-25 → signup v17 (remove device-camera fallback, in-app recorder only)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.hostname !== self.location.hostname) return;
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for ALL same-origin GETs. Cache is offline fallback only.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
