/* =========================================================
   あぷりんく : Service Worker
   チャット通知（Web Push）の受け取りだけを行う。
   画面のキャッシュはしない（古い画面が残るのを防ぐため）。
   ========================================================= */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

/* 通知を受け取ったら表示する（iPhoneでは必ず表示する必要がある） */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  event.waitUntil(self.registration.showNotification(data.title || 'あぷりんく', {
    body: data.body || '新しいコメントがあります',
    icon: './assets/icon-192.png',
    tag: 'appshare-chat',
    renotify: true
  }));
});

/* 通知を押したら「あぷりんく」を開く（開いていれば前面に出す） */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = self.registration.scope;

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].url.indexOf(url) === 0 && 'focus' in list[i]) { return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
