/* Drex service worker — mínimo para instalabilidad de la PWA.
   Estrategia: network-first para navegación/HTML (nunca bloquea updates),
   cache-first con versión para estáticos (iconos, logo, manifest). */
const DREX_SW_VERSION = 'drex-v1';
const DREX_STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/drex-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(DREX_SW_VERSION)
      .then(cache => cache.addAll(DREX_STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== DREX_SW_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navegación / HTML: red primero, fallback a caché. Así una versión nueva
  // de index.html siempre llega sin que la caché la bloquee.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(DREX_SW_VERSION).then(cache => cache.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Estáticos: caché primero, red como respaldo.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(DREX_SW_VERSION).then(cache => cache.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
