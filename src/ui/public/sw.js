// VibePortal service worker: shows pushed notices (task finished, needs you, quota)
// with the page closed, and brings the dashboard back when one is tapped.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {
    n = { title: 'VibePortal', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    (async () => {
      // the dashboard in front already shows it as a toast
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
      await self.registration.showNotification(n.title || 'VibePortal', {
        body: n.body || '',
        tag: n.tag || undefined,
        renotify: !!n.tag,
        icon: 'icon.png',
        badge: 'icon.png',
        requireInteraction: n.level === 'warning' || n.level === 'critical',
        data: { taskId: n.taskId },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL('./', self.registration.scope).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((w) => w.url.startsWith(target));
      if (open) return open.focus();
      return self.clients.openWindow(target);
    })(),
  );
});
