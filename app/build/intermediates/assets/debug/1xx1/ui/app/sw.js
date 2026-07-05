// 1XX1 Service Worker — Offline First
const CACHE = '1xx1-v1.0.0';
const STATIC = ['/', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // API + SSE istekleri → network only
  if (e.request.url.includes('/events') ||
      e.request.url.includes('/api/') ||
      e.request.url.includes('/search') ||
      e.request.url.includes('/metrics') ||
      e.request.url.includes('/health')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/') ?? new Response('Offline', { status: 503 }));
    })
  );
});
