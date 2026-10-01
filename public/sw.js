// App shell cache. Network first so a deploy is picked up immediately; the cached copy is only used when the network fails.
// API, admin and Cloudflare Access paths and every non-GET request are never touched. Redirected responses (an Access login) are never cached.
const SHELL_CACHE = 'medicine-shell-v1';
const PRECACHE = ['/', '/index.html', '/app.js', '/greeting.js', '/shop-client.js', '/shop-creation-client.js', '/owner-promotion-client.js', '/member-removal-client.js', '/owner-demotion-client.js', '/ownership-transfer-client.js', '/shop-leave-client.js', '/shop-deletion-client.js', '/deleted-shops-client.js', '/email-preferences-client.js', '/inventory-export-client.js', '/options-client.js', '/overview-client.js', '/barcode-client.js', '/info-tips.js', '/profile-tabs.js', '/zxing-detector.js', '/shop-invitations-client.js', '/change-feed-client.js', '/offline-store.js', '/offline-queue.js', '/restock-client.js', '/styles.css'];
const STATIC_FILE = /\.(?:js|css|png|svg|ico|webmanifest|json)$/;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(PRECACHE.map(path => cache.add(new Request(path, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('medicine-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && !response.redirected) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true }) || (request.mode === 'navigate' ? await cache.match('/index.html') : null);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || /^\/(?:api|admin|cdn-cgi)\//.test(url.pathname)) return;
  if (request.mode === 'navigate' || STATIC_FILE.test(url.pathname)) event.respondWith(networkFirst(request));
});

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    // A service worker has no page-bound active Shop context. Keep its push
    // generic so it cannot make an unpinned cross-Shop notification request.
    await self.registration.showNotification('Expiry reminder', { body: 'Open the Inventory Management System to review items due in the next 30 days.', data: { url: '/#notifications' } });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/#notifications';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
