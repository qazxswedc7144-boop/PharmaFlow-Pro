
const CACHE_NAME = 'pharmaflow-v8-cache-fix';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((key) => caches.delete(key))
    )).catch(err => console.error("[SW] Activate cleanup failed:", err))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const isDev = self.location.hostname === 'localhost' || 
                self.location.hostname.includes('127.0.0.1') || 
                self.location.hostname.includes('ais-dev');
                
  if (isDev) {
    // Completely bypass caching in development
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for HTML navigate requests so index.html is always fresh
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', cacheCopy)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Network-first for JS bundles & assets to prevent stale dynamic chunk hashes
  if (event.request.destination === 'script' || event.request.url.includes('/assets/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pharma-sync-task') {
    event.waitUntil(processBackgroundSync());
  }
});

async function processBackgroundSync() {
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'TRIGGER_SYNC' });
  });
  return Promise.resolve();
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientList => {
      if (clientList.length > 0) return clientList[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
