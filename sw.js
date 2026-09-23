/* Drex service worker — mínimo para instalabilidad de la PWA.
   Estrategia: network-first para navegación/HTML y JS (nunca bloquea updates),
   cache-first con versión para estáticos inmutables (iconos, logo, manifest).
   NOTA: las rutas son relativas ('./...') porque la app vive en un subpath
   (/Beabo/). Con rutas absolutas ('/...') el precache pedía el root del
   dominio (404) y cache.addAll() fallaba EN BLOQUE: la instalación nunca
   completaba, skipWaiting jamás corría y la PWA instalada quedaba congelada
   en la versión vieja. */
const DREX_SW_VERSION = 'drex-v15'; // v15: timeout en network-first (drex-i18n.js colgado ya no retrasa DOMContentLoaded, 2026-09-23)
const DREX_STATIC_ASSETS = [
  './',
  './index.html',
  './drex-cloud.js',
  './drex-i18n.js',
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
// FIX: solo se cachean respuestas OK (antes un 404/500 quedaba guardado y se
// servía offline como si fuera la app). En navegación offline sin copia en
// caché, fallback final a ./index.html para que las rutas profundas abran la
// app en vez de quedarse en blanco (los .js sin caché siguen fallando como
// error de red: servirles HTML rompería el parseo).
// PERF 2026-09-23: timeout para network-first. drex-i18n.js pesa ~619 KB y
// carga con defer; si su fetch queda colgado (red lenta), el navegador puede
// retrasar DOMContentLoaded/load aunque el script no bloquee el parse. Con el
// timeout se sirve la copia en caché y la app arranca en <timeout> en vez de
// quedarse esperando a la red. `var` (no const) para poder afinarlo en tests.
var DREX_NETWORK_TIMEOUT_MS = 10000;
function fetchWithTimeout(req, ms) {
  ms = ms || DREX_NETWORK_TIMEOUT_MS;
  var abort = null;
  try { abort = new AbortController(); } catch (_) { /* SW antiguos */ }
  var fetchP;
  try {
    fetchP = abort ? fetch(req, { signal: abort.signal }) : fetch(req);
  } catch (e) {
    fetchP = Promise.reject(e);
  }
  var timeoutP = new Promise(function (_, reject) {
    setTimeout(function () {
      if (abort) { try { abort.abort(); } catch (_) {} }
      reject(new Error('network-timeout'));
    }, ms);
  });
  var raced = Promise.race([fetchP, timeoutP]);
  // Evita rejection sin manejar si la red responde DESPUÉS del timeout.
  fetchP.catch(function () {});
  return raced;
}

function networkFirst(req, cacheKey) {
  const isNavigate = req.mode === 'navigate';
  return fetchWithTimeout(req)
    .then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(DREX_SW_VERSION).then(cache => cache.put(cacheKey, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(cacheKey).then(cached => {
      if (cached) return cached;
      if (isNavigate) return caches.match('./index.html');
      return undefined;
    }));
}

// ============================================================
// Web Push (2026-09-19): muestra la notificación aunque Drex esté
// cerrada y abre la app en la sección correcta al tocarla.
// El backend (Lambda drex-push-sender) envía {title, body, url, tag}.
// ============================================================
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Drex';
  let iconUrl = 'icon-192.png';
  try { iconUrl = new URL('icon-192.png', self.registration.scope).href; } catch (_) {}
  const options = {
    body: data.body || '',
    icon: iconUrl,
    badge: iconUrl,
    tag: data.tag || 'drex-notif',
    renotify: true,
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  let targetUrl = target;
  try { targetUrl = new URL(target, self.registration.scope).href; } catch (_) {}
  // R10-1 (push hijack): data.url se arma en el backend con el appRoot que
  // escribe el cliente; una suscripcion plantada puede traer un origen
  // atacante. Solo se navega dentro del origen de la app; si no coincide,
  // se cae a la raiz de la app ('./'). Los push legitimos siempre apuntan
  // al origen de la app, asi que su comportamiento no cambia.
  try {
    if (new URL(targetUrl).origin !== self.location.origin) {
      targetUrl = new URL('./', self.registration.scope).href;
    }
  } catch (_) { targetUrl = new URL('./', self.registration.scope).href; }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        try {
          if ('focus' in c) {
            // Si ya hay una ventana de Drex, la enfoca y le pide navegar.
            c.focus();
            try { c.postMessage({ type: 'drex-push-open', url: targetUrl }); } catch (_) {}
            return;
          }
        } catch (_) {}
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

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
  // Solo se guardan respuestas OK u opacas (cross-origin sin CORS): un 404 no
  // debe envenenar la caché.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(DREX_SW_VERSION).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
