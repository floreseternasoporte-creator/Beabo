// ============================================================
// FIREBASE CLOUD MESSAGING - SERVICE WORKER
// Beabo / Drex - Notificaciones Push
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

// Configuración Firebase (misma que en index.html)
firebase.initializeApp({
  apiKey: "AIzaSyC9v2qp6zGtmvsFiOknlmTHnN6zZY1RLcI",
  authDomain: "ggggg-f2508.firebaseapp.com",
  databaseURL: "https://ggggg-f2508-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ggggg-f2508",
  storageBucket: "ggggg-f2508.firebasestorage.app",
  messagingSenderId: "120837533638",
  appId: "1:120837533638:web:dab060eedf39a6d19f4cc7",
  measurementId: "G-T6F45PFWRP"
});

const messaging = firebase.messaging();

// Manejar notificaciones en background (cuando la app está cerrada o en segundo plano)
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Notificación en background recibida:', payload);

  const notificationTitle = payload.notification?.title || 'Beabo';
  const notificationOptions = {
    body: payload.notification?.body || 'Tienes una nueva notificación',
    icon: payload.notification?.icon || '/ashhhh.ico',
    badge: '/ashhhh.ico',
    vibrate: [200, 100, 200, 100, 200],
    tag: 'beabo-notification',
    renotify: true,
    data: payload.data || {},
    actions: [
      {
        action: 'open',
        title: 'Ver',
      }
    ]
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Manejar clic en la notificación
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'open' || !event.action) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
    );
  }
});
