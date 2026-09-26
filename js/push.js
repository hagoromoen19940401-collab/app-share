/* =========================================================
   あぷりんく : チャット通知（Web Push）

   ・通知のON/OFFは、職員ログイン済みの本人だけが操作できる
     （設定パスワードは不要）
   ・端末の登録は Supabase の appshare_push_subscriptions に
     職員ごと・端末ごとに保存する
   ・iPhone / iPad は iOS 16.4 以降、ホーム画面に追加したアプリでのみ使える
   ========================================================= */
(function (global) {
  'use strict';

  // VAPID 公開鍵（秘密鍵は Supabase の secrets にだけ置く）
  var VAPID_PUBLIC_KEY = 'BBFDaHgwiVbP6fS0N93VHXFr519sm7SmnpnszFk2-oQ_CWN8MJWwCX_yY6ltc55pHn2UzFIYoVP8XzO_zxS-o1I';

  var Api  = global.AppShareSupabase;
  var Util = global.AppShareUtil;

  var busy = false;
  var area = null;
  var options = {};

  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in global && 'Notification' in global;
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return global.navigator.standalone === true ||
      (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches);
  }

  function session() {
    return global.AppShareAuth ? global.AppShareAuth.getSession() : null;
  }

  function toKey(base64url) {
    var padded = (base64url + '===='.slice(base64url.length % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = global.atob(padded);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) { out[i] = raw.charCodeAt(i); }
    return out;
  }

  function registration() {
    return navigator.serviceWorker.register('./sw.js', { scope: './' }).then(function () {
      return navigator.serviceWorker.ready;
    });
  }

  /** この端末で登録済みの購読（なければ null） */
  function currentSubscription() {
    if (!isSupported()) { return Promise.resolve(null); }
    return navigator.serviceWorker.getRegistration('./').then(function (reg) {
      return reg ? reg.pushManager.getSubscription() : null;
    }).catch(function () { return null; });
  }

  /* ---------------------------------------------------------
     ON / OFF
     --------------------------------------------------------- */
  function enable() {
    var s = session();
    if (!s) { return Promise.reject(new Error('ログインが必要です')); }

    // iPhone では、ボタンを押した直後に許可を求める必要がある
    return global.Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        throw new Error('通知が許可されませんでした。端末の設定から「あぷりんく」の通知を許可してください。');
      }
      return registration();
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        return existing || reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: toKey(VAPID_PUBLIC_KEY)
        });
      });
    }).then(function (sub) {
      var data = sub.toJSON();
      return Api.pushSubscribe(s.token, data.endpoint, data.keys.p256dh, data.keys.auth);
    }).then(function (result) {
      if (!result.ok) { throw new Error(result.message || '通知を登録できませんでした'); }
    });
  }

  /** 通知をOFFにする。token を渡した場合はそのトークンで解除する（ログアウト時） */
  function disable(token) {
    var t = token || (session() && session().token);
    return currentSubscription().then(function (sub) {
      if (!sub) { return; }
      var removing = t
        ? Api.pushUnsubscribe(t, sub.endpoint).catch(function () { /* 端末側の解除は続ける */ })
        : Promise.resolve();
      return removing.then(function () { return sub.unsubscribe(); });
    });
  }

  /** 投稿に成功したら呼ぶ。失敗しても投稿には影響させない */
  function notify(commentId) {
    var s = session();
    if (!s || !commentId) { return; }
    Api.pushNotify(s.token, commentId).catch(function () { /* 通知の失敗は無視する */ });
  }

  /* ---------------------------------------------------------
     設定画面の「チャット通知」欄
     --------------------------------------------------------- */
  function sectionHtml(inner) {
    return '' +
      '<section class="settings-section">' +
        '<div class="settings-section__head">' +
          '<div>' +
            '<h3 class="settings-section__title">チャット通知</h3>' +
            '<p class="settings-section__note">新しいコメントが投稿されたら、この端末に通知します。' +
              '自分の投稿は通知されません。</p>' +
          '</div>' +
        '</div>' +
        inner +
        '<div class="inline-notice" id="pushMessage" hidden>' +
          '<span id="pushMessageText"></span>' +
        '</div>' +
      '</section>';
  }

  function showMessage(text, kind) {
    var box = document.getElementById('pushMessage');
    if (!box) { return; }
    box.className = 'inline-notice' + (kind === 'ok' ? ' inline-notice--ok' : '');
    document.getElementById('pushMessageText').textContent = text;
    box.hidden = false;
  }

  function note(text) {
    return '<div class="empty"><p class="empty__text">' + Util.escapeHtml(text) + '</p></div>';
  }

  /** 欄を描き直す。描き終わったら resolve する */
  function render() {
    if (!area || !document.body.contains(area)) { return Promise.resolve(); }

    if (!session()) {
      area.innerHTML = sectionHtml(
        '<div class="empty">' +
          '<p class="empty__text">通知を使うにはログインが必要です。</p>' +
          '<button class="button" type="button" id="pushLoginButton">ログイン</button>' +
        '</div>');
      document.getElementById('pushLoginButton').addEventListener('click', function () {
        if (options.onRequireLogin) { options.onRequireLogin(); }
      });
      return Promise.resolve();
    }

    if (!isSupported()) {
      area.innerHTML = sectionHtml(note(isIos() && !isStandalone()
        ? 'iPhone / iPad では、Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面のアイコンから開くと通知を使えます。'
        : 'この端末・ブラウザは通知に対応していません。'));
      return Promise.resolve();
    }

    area.innerHTML = sectionHtml(note('確認しています…'));

    return currentSubscription().then(function (sub) {
      if (!area || !document.body.contains(area)) { return; }
      var on = !!sub && global.Notification.permission === 'granted';
      var denied = global.Notification.permission === 'denied';

      area.innerHTML = sectionHtml(
        '<div class="staff-form__actions">' +
          '<span class="settings-count">' + (on ? '通知：ON' : '通知：OFF') + '</span>' +
          (on
            ? '<button class="button button--ghost" type="button" id="pushToggle" data-on="1"' +
                (busy ? ' disabled' : '') + '>通知をオフにする</button>'
            : '<button class="button" type="button" id="pushToggle"' +
                (busy || denied ? ' disabled' : '') + '>通知を有効にする</button>') +
        '</div>' +
        (denied && !on
          ? '<p class="field__hint">通知がブロックされています。端末の設定から「あぷりんく」の通知を許可してください。</p>'
          : ''));

      document.getElementById('pushToggle').addEventListener('click', onToggle);
    });
  }

  function onToggle(event) {
    if (busy) { return; }
    var turnOff = event.currentTarget.getAttribute('data-on') === '1';
    busy = true;
    event.currentTarget.disabled = true;

    var action = turnOff ? disable() : enable();
    // 描き直した後にメッセージを出す
    action.then(function () {
      busy = false;
      return render().then(function () {
        showMessage(turnOff ? '通知をオフにしました。' : '通知を有効にしました。', 'ok');
      });
    }).catch(function (error) {
      busy = false;
      return render().then(function () {
        showMessage((turnOff ? '通知をオフにできませんでした。' : '通知を有効にできませんでした。') +
                    (error && error.message ? error.message : ''), 'error');
      });
    });
  }

  /** 設定画面に「チャット通知」欄を置く */
  function mount(element, opts) {
    area = element;
    options = opts || {};
    render();
  }

  global.AppSharePush = {
    mount: mount,
    notify: notify,
    disable: disable
  };
})(window);
