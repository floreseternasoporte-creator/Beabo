/* Drex service worker — mínimo para instalabilidad de la PWA.
   Estrategia: network-first para navegación/HTML y JS (nunca bloquea updates),
   cache-first con versión para estáticos inmutables (iconos, logo, manifest).
   NOTA: las rutas son relativas ('./...') porque la app vive en un subpath
   (/Beabo/). Con rutas absolutas ('/...') el precache pedía el root del
   dominio (404) y cache.addAll() fallaba EN BLOQUE: la instalación nunca
   completaba, skipWaiting jamás corría y la PWA instalada quedaba congelada
   en la versión vieja. */
const DREX_SW_VERSION = 'drex-v7';
const DREX_STATIC_ASSETS = [
  './',
  './index.html',
  './drex-cloud.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './drex-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(DREX_SW_VERSION)
      .then(cache =>
        // Cada recurso se guarda por separado: si uno falla (404, sin red),
        // los demás igual quedan en caché. cache.addAll() rechazaba TODO por
        // un solo fallo y dejaba la instalación a medias.
        Promise.all(DREX_STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
      )
      .catch(() => {})
      // skipWaiting SIEMPRE, aunque el precache falle: lo importante es que
      // el worker nuevo tome el control y su estrategia network-first deje
      // pasar las actualizaciones.
      .then(() => self.skipWaiting())
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

// Red primero con respaldo a caché: la app sigue abriendo sin conexión,
// pero una versión nueva siempre llega en cuanto hay red.
function networkFirst(req, cacheKey) {
  return fetch(req)
    .then(res => {
      const copy = res.clone();
      caches.open(DREX_SW_VERSION).then(cache => cache.put(cacheKey, copy)).catch(() => {});
      return res;
    })
    .catch(() => caches.match(cacheKey));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navegación / HTML: red primero, fallback a caché. Así una versión nueva
  // de index.html siempre llega sin que la caché la bloquee.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, req));
    return;
  }

  // JavaScript de la plataforma: red primero. El SW anterior (drex-v1) usaba
  // cache-first para TODO y congelaba drex-cloud.js en la primera versión
  // descargada: los arreglos de la plataforma nunca llegaban a la PWA
  // instalada. El cambio de versión invalida esa caché vieja.
  try {
    if (new URL(req.url).pathname.endsWith('.js')) {
      event.respondWith(networkFirst(req, req));
      return;
    }
  } catch (e) { /* sigue al fallback de estáticos */ }

  // Estáticos inmutables (iconos, imágenes): caché primero, red como respaldo.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(DREX_SW_VERSION).then(cache => cache.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
