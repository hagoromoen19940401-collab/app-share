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

  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'あぷりんく', {
      body: data.body || '新しいコメントがあります',
      icon: './assets/icon-192.png',
      tag: 'appshare-chat',
      renotify: true
    }),
    updateBadge(data.badge)
  ]));
});

/* 未読の合計をアプリアイコンのバッジへ反映する。
   件数が届いていない通知・対応していない端末では何もしない */
function updateBadge(count) {
  var nav = self.navigator;
  if (typeof count !== 'number' || !isFinite(count) || count < 0) { return Promise.resolve(); }
  if (!nav || !nav.setAppBadge || !nav.clearAppBadge) { return Promise.resolve(); }

  try {
    return Promise.resolve(count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge())
      .catch(function () { /* 反映できなくても通知は表示する */ });
  } catch (e) {
    return Promise.resolve();
  }
}

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
