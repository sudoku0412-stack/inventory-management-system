self.addEventListener('push', event => {
  event.waitUntil((async () => {
    // A service worker has no page-bound active Shop context. Keep its push
    // generic so it cannot make an unpinned cross-Shop notification request.
    await self.registration.showNotification('Medicine expiry reminder', { body: 'Open Medicine Tracker to review items due in the next 30 days.', data: { url: '/#notifications' } });
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
