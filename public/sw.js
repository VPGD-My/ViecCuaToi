// Service worker của Việc của tôi: nhận thông báo đẩy và mở đúng việc khi chạm vào.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { title: 'Việc của tôi', body: event.data ? event.data.text() : '' };
  }
  const scope = self.registration.scope;
  const url = new URL(d.taskId ? './#task-' + d.taskId : './', scope).href;
  event.waitUntil(
    self.registration.showNotification(d.title || 'Việc của tôi', {
      body: d.body || '',
      tag: d.tag,
      renotify: Boolean(d.tag),
      icon: new URL('icon-192.png', scope).href,
      badge: new URL('icon-192.png', scope).href,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) {
          await w.focus();
          w.postMessage({ type: 'open-task', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
