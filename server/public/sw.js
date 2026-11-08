// Heraxos service worker: push-уведомления
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const RING = [800, 400, 800, 400, 800, 400, 800];

async function closeCall(id) {
  for (const n of await self.registration.getNotifications())
    if (n.data && n.data.kind === 'call' && (!id || n.data.id === id)) n.close();
}

self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil((async () => {
    if (d.kind === 'missed') await closeCall(d.id);
    if (d.kind === 'call') {
      // если приложение уже открыто на экране — там звучит свой рингтон
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = wins.some((c) => c.visibilityState === 'visible');
      await closeCall(d.id); // оставляем только самое свежее уведомление о звонке
      return self.registration.showNotification(d.title || 'Heraxos', {
        body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
        tag: 'call-' + d.id + '-' + (d.n || 0), renotify: true, requireInteraction: true,
        silent: false, vibrate: visible ? [] : RING, data: d,
      });
    }
    return self.registration.showNotification(d.title || 'Heraxos', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
      tag: (d.kind || 'msg') + '-' + (d.from || ''), renotify: true,
      vibrate: d.kind === 'missed' ? [300, 150, 300] : [120], data: d,
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const open = d.kind === 'msg' || d.kind === 'missed' ? d.from : null;
  e.waitUntil((async () => {
    if (d.kind === 'call') await closeCall(d.id);
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { await c.focus(); if (open) c.postMessage({ open }); return; }
    }
    return self.clients.openWindow(open ? '/?chat=' + encodeURIComponent(open) : '/');
  })());
});

self.addEventListener('message', (e) => { if (e.data && e.data.closeCall) e.waitUntil(closeCall(e.data.closeCall === true ? null : e.data.closeCall)); });
