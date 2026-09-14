/* Beabo service worker — mínimo para instalabilidad de la PWA.
   Estrategia: network-first para navegación/HTML y JS (nunca bloquea updates),
   cache-first con versión para estáticos inmutables (iconos, logo, manifest).
   NOTA: las rutas son relativas ('./...') porque la app vive en un subpath
   (/Beabo/). Con rutas absolutas ('/...') el precache pedía el root del
   dominio (404) y cache.addAll() fallaba EN BLOQUE: la instalación nunca
   completaba, skipWaiting jamás corría y la PWA instalada quedaba congelada
   en la versión vieja. */
const BEABO_SW_VERSION = 'beabo-v7';
const BEABO_STATIC_ASSETS = [
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
    caches.open(BEABO_SW_VERSION)
      .then(cache =>
        // Cada recurso se guarda por separado: si uno falla (404, sin red),
        // los demás igual quedan en caché. cache.addAll() rechazaba TODO por
        // un solo fallo y dejaba la instalación a medias.
        Promise.all(BEABO_STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
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
        keys.filter(k => k !== BEABO_SW_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

// Aviso de versión a las pestañas (ver fetch handler): se limita a un chequeo
// cada 2 minutos para no generar tráfico.
let beaboLastBuildNotified = '';
let beaboLastBuildCheck = 0;
function beaboBroadcastBuild() {
  try {
    const now = Date.now();
    if (now - beaboLastBuildCheck < 120000) return;
    beaboLastBuildCheck = now;
    fetch('./version.json', { cache: 'no-store' })
      .then(res => (res && res.ok) ? res.json() : null)
      .then(data => {
        const build = data && data.build ? String(data.build) : '';
        if (!build || build === beaboLastBuildNotified) return;
        beaboLastBuildNotified = build;
        self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
          clients.forEach(c => {
            try { c.postMessage({ type: 'BEABO_BUILD', build }); } catch (e) {}
          });
        }).catch(() => {});
      })
      .catch(() => {});
  } catch (e) {}
}

// Red primero con respaldo a caché: la app sigue abriendo sin conexión,
// pero una versión nueva siempre llega en cuanto hay red.
function networkFirst(req, cacheKey) {
  return fetch(req)
    .then(res => {
      const copy = res.clone();
      caches.open(BEABO_SW_VERSION).then(cache => cache.put(cacheKey, copy)).catch(() => {});
      return res;
    })
    .catch(() => caches.match(cacheKey));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // version.json: SIEMPRE red, nunca se guarda en caché. Es la señal que usa
  // el actualizador para saber si hay un despliegue nuevo; si el worker la
  // cacheara, la píldora "Nueva versión disponible" jamás aparecería.
  try {
    if (new URL(req.url).pathname.endsWith('/version.json')) {
      event.respondWith(fetch(req));
      return;
    }
  } catch (e) { /* sigue al flujo normal */ }

  // Aviso de versión a las pestañas: el JS de una pestaña vieja puede tener
  // sus temporizadores congelados (iOS en segundo plano), pero el worker se
  // actualiza solo con cada navegación. Cuando detecta un build nuevo en
  // version.json, se lo anuncia a todas las pestañas para que muestren la
  // píldora de actualización aunque su propio chequeo no haya corrido.
  beaboBroadcastBuild();

  // Navegación / HTML: red primero, fallback a caché. Así una versión nueva
  // de index.html siempre llega sin que la caché la bloquee.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, req));
    return;
  }

  // JavaScript de la plataforma: red primero. El SW anterior (beabo-v6) usaba
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
      caches.open(BEABO_SW_VERSION).then(cache => cache.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
