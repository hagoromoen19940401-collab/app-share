/* =========================================================
   js/settings.js
   設定画面（職員管理 / アプリ管理）

   ・登録済み職員の一覧表示   … appshare_staff_list()
   ・職員の追加               … appshare_staff_add()
   ・登録済みアプリの一覧表示 … appshare_apps_list(token)
   ・アプリの追加             … appshare_app_add(token, name, url, description)
   テーブルへの直接の読み書きは行わない（RPC経由のみ）
   ========================================================= */

(function (global) {
  'use strict';

  var Util = global.AppShareUtil;
  var Api  = global.AppShareSupabase;

  var els = {};        // modal / body / openButton
  var isOpen = false;
  var lastFocused = null;
  var hooks = {};      // getToken / isLoggedIn / onAppsChanged / onRequireLogin

  /* ---------------------------------------------------------
     画面の組み立て
     --------------------------------------------------------- */
  function bodyHtml() {
    return '' +
      '<section class="settings-section">' +
        '<div class="settings-section__head">' +
          '<div>' +
            '<h3 class="settings-section__title">職員管理</h3>' +
            '<p class="settings-section__note">コメントを書くときに使う職員を登録します。</p>' +
          '</div>' +
          '<button class="button button--ghost" type="button" id="staffAddToggle">' +
            '<span class="button__icon" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>' +
            '</span>' +
            '<span>職員を追加</span>' +
          '</button>' +
        '</div>' +

        '<div class="staff-form" id="staffFormArea" hidden>' +
          '<div class="field">' +
            '<label class="field__label" for="staffName">職員名</label>' +
            '<input class="field__input" id="staffName" type="text" maxlength="30" autocomplete="off" ' +
                   'placeholder="例）山田">' +
          '</div>' +
          '<div class="field">' +
            '<label class="field__label" for="staffPassword">パスワード</label>' +
            '<input class="field__input field__input--short" id="staffPassword" type="password" ' +
                   'inputmode="numeric" maxlength="4" autocomplete="new-password" placeholder="••••">' +
            '<p class="field__hint">4桁の数字で入力してください。</p>' +
          '</div>' +
          '<div class="staff-form__actions">' +
            '<button class="button" type="button" id="staffSubmit">登録</button>' +
            '<button class="button button--quiet" type="button" id="staffCancel">閉じる</button>' +
          '</div>' +
        '</div>' +

        '<div class="inline-notice" id="staffMessage" hidden>' +
          '<span class="inline-notice__icon" aria-hidden="true" id="staffMessageIcon"></span>' +
          '<span id="staffMessageText"></span>' +
        '</div>' +

        '<div class="settings-subhead">' +
          '<h4 class="section-title">登録済みの職員</h4>' +
          '<span class="settings-count" id="staffCount"></span>' +
        '</div>' +
        '<div id="staffListArea"></div>' +
      '</section>' +

      '<section class="settings-section settings-section--split">' +
        '<div class="settings-section__head">' +
          '<div>' +
            '<h3 class="settings-section__title">アプリ管理</h3>' +
            '<p class="settings-section__note">共有したいWebアプリを登録します。登録すると左の一覧に並びます。</p>' +
          '</div>' +
          '<button class="button button--ghost" type="button" id="appAddToggle">' +
            '<span class="button__icon" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>' +
            '</span>' +
            '<span>アプリを追加</span>' +
          '</button>' +
        '</div>' +

        '<div class="staff-form" id="appFormArea" hidden>' +
          '<div class="field">' +
            '<label class="field__label" for="appName">アプリ名</label>' +
            '<input class="field__input" id="appName" type="text" maxlength="100" autocomplete="off" ' +
                   'placeholder="例）勤務表">' +
          '</div>' +
          '<div class="field">' +
            '<label class="field__label" for="appUrl">URL</label>' +
            '<input class="field__input" id="appUrl" type="url" maxlength="2000" autocomplete="off" ' +
                   'inputmode="url" placeholder="https://...">' +
            '<p class="field__hint">http:// または https:// で始まるURLを入力してください。</p>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field__label" for="appDescription">説明（任意）</label>' +
            '<textarea class="field__input field__textarea" id="appDescription" rows="2" ' +
                      'maxlength="1000" wrap="soft" placeholder="どんなアプリかを簡単に"></textarea>' +
          '</div>' +
          '<div class="staff-form__actions">' +
            '<button class="button" type="button" id="appSubmit">登録</button>' +
            '<button class="button button--quiet" type="button" id="appCancel">閉じる</button>' +
          '</div>' +
        '</div>' +

        '<div class="inline-notice" id="appMessage" hidden>' +
          '<span class="inline-notice__icon" aria-hidden="true" id="appMessageIcon"></span>' +
          '<span id="appMessageText"></span>' +
        '</div>' +

        '<div class="settings-subhead">' +
          '<h4 class="section-title">登録済みのアプリ</h4>' +
          '<span class="settings-count" id="appCountLabel"></span>' +
        '</div>' +
        '<div id="appListArea"></div>' +
      '</section>';
  }

  var ICON_OK    = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_ALERT = '<svg viewBox="0 0 24 24"><path d="M12 4.5l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/></svg>';

  /* ---------------------------------------------------------
     メッセージ表示（alertは使わない）
     --------------------------------------------------------- */
  function showMessageIn(prefix, text, kind) {
    var box  = document.getElementById(prefix + 'Message');
    var icon = document.getElementById(prefix + 'MessageIcon');
    var body = document.getElementById(prefix + 'MessageText');
    if (!box) { return; }

    box.className = 'inline-notice' + (kind === 'ok' ? ' inline-notice--ok' : '');
    icon.innerHTML = kind === 'ok' ? ICON_OK : ICON_ALERT;
    body.textContent = text;
    box.hidden = false;
  }

  function clearMessageIn(prefix) {
    var box = document.getElementById(prefix + 'Message');
    if (box) { box.hidden = true; }
  }

  function showMessage(text, kind) { showMessageIn('staff', text, kind); }
  function clearMessage() { clearMessageIn('staff'); }

  /* ---------------------------------------------------------
     職員一覧
     --------------------------------------------------------- */
  function renderStaffList(rows) {
    var area  = document.getElementById('staffListArea');
    var count = document.getElementById('staffCount');
    if (!area) { return; }

    count.textContent = rows.length ? rows.length + '名' : '';

    if (!rows.length) {
      area.innerHTML = '' +
        '<div class="empty">' +
          '<p class="empty__text">まだ職員が登録されていません。<br>「職員を追加」から登録してください。</p>' +
        '</div>';
      return;
    }

    area.innerHTML = '<ul class="staff-list">' + rows.map(function (row) {
      return '' +
        '<li class="staff-item">' +
          '<span class="staff-item__avatar" aria-hidden="true">' +
            Util.escapeHtml(Util.initial(row.display_name)) +
          '</span>' +
          '<span class="staff-item__name">' + Util.escapeHtml(row.display_name) + '</span>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function loadStaffList() {
    var area = document.getElementById('staffListArea');
    if (area) {
      area.innerHTML = '<div class="empty"><p class="empty__text">読み込んでいます…</p></div>';
    }

    return Api.staffList().then(renderStaffList).catch(function (error) {
      if (area) {
        area.innerHTML = '<div class="empty"><p class="empty__text">' +
          Util.escapeHtml('職員一覧を取得できませんでした。' + error.message) + '</p></div>';
      }
    });
  }

  /* ---------------------------------------------------------
     職員の追加
     --------------------------------------------------------- */
  function toggleForm(show) {
    var area = document.getElementById('staffFormArea');
    if (!area) { return; }
    area.hidden = !show;
    if (show) {
      clearMessage();
      document.getElementById('staffName').focus();
    }
  }

  function submitStaff() {
    var nameInput = document.getElementById('staffName');
    var passInput = document.getElementById('staffPassword');
    var button    = document.getElementById('staffSubmit');

    var name = nameInput.value.trim();
    var pass = passInput.value;

    // 画面側でも先に確認する（保存時の判定はSupabase側でも行う）
    if (!name) {
      showMessage('職員名を入力してください。', 'error');
      nameInput.focus();
      return;
    }
    if (!/^[0-9]{4}$/.test(pass)) {
      showMessage('パスワードは4桁の数字で入力してください。', 'error');
      passInput.focus();
      return;
    }

    button.disabled = true;
    button.textContent = '登録中…';
    clearMessage();

    Api.staffAdd(name, pass).then(function (result) {
      if (!result.ok) {
        showMessage(result.message || '登録できませんでした。', 'error');
        return;
      }
      showMessage(result.staff_name + ' さんを登録しました。', 'ok');
      nameInput.value = '';
      passInput.value = '';
      nameInput.focus();
      return loadStaffList();
    }).catch(function (error) {
      showMessage('登録できませんでした。' + error.message, 'error');
    }).then(function () {
      button.disabled = false;
      button.textContent = '登録';
    });
  }

  /* ---------------------------------------------------------
     アプリ管理
     --------------------------------------------------------- */
  function renderAppList(rows) {
    var area  = document.getElementById('appListArea');
    var count = document.getElementById('appCountLabel');
    if (!area) { return; }

    count.textContent = rows.length ? rows.length + '件' : '';

    if (!rows.length) {
      area.innerHTML = '' +
        '<div class="empty">' +
          '<p class="empty__text">まだアプリが登録されていません。<br>「アプリを追加」から登録してください。</p>' +
        '</div>';
      return;
    }

    area.innerHTML = '<ul class="app-reg-list">' + rows.map(function (row) {
      return '' +
        '<li class="app-reg-item">' +
          '<span class="app-reg-item__body">' +
            '<span class="app-reg-item__name">' + Util.escapeHtml(row.name) + '</span>' +
            '<span class="app-reg-item__url">' + Util.escapeHtml(row.url) + '</span>' +
            (row.description
              ? '<span class="app-reg-item__desc">' + Util.escapeHtml(row.description) + '</span>' : '') +
          '</span>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function loadAppList() {
    var area = document.getElementById('appListArea');
    if (area) {
      area.innerHTML = '<div class="empty"><p class="empty__text">読み込んでいます…</p></div>';
    }

    if (!hooks.isLoggedIn || !hooks.isLoggedIn()) {
      if (area) {
        area.innerHTML = '' +
          '<div class="empty">' +
            '<p class="empty__text">アプリの一覧と登録にはログインが必要です。</p>' +
            '<button class="button" type="button" id="appLoginButton">ログイン</button>' +
          '</div>';
        var loginButton = document.getElementById('appLoginButton');
        if (loginButton) {
          loginButton.addEventListener('click', function () {
            close();
            if (hooks.onRequireLogin) { hooks.onRequireLogin(); }
          });
        }
      }
      var toggle = document.getElementById('appAddToggle');
      if (toggle) { toggle.disabled = true; }
      return Promise.resolve();
    }

    return Api.appsList(hooks.getToken()).then(renderAppList).catch(function (error) {
      if (area) {
        area.innerHTML = '<div class="empty"><p class="empty__text">' +
          Util.escapeHtml('アプリ一覧を取得できませんでした。' + error.message) + '</p></div>';
      }
    });
  }

  function toggleAppForm(show) {
    var area = document.getElementById('appFormArea');
    if (!area) { return; }
    area.hidden = !show;
    if (show) {
      clearMessageIn('app');
      document.getElementById('appName').focus();
    }
  }

  function submitApp() {
    var nameInput = document.getElementById('appName');
    var urlInput  = document.getElementById('appUrl');
    var descInput = document.getElementById('appDescription');
    var button    = document.getElementById('appSubmit');

    var name = nameInput.value.trim();
    var url  = urlInput.value.trim();
    var desc = descInput.value.trim();

    // 画面側でも先に確認する（保存時の判定はSupabase側でも行う）
    if (!name) {
      showMessageIn('app', 'アプリ名を入力してください。', 'error');
      nameInput.focus();
      return;
    }
    if (!url) {
      showMessageIn('app', 'URLを入力してください。', 'error');
      urlInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showMessageIn('app', 'URLは http:// または https:// で始まる形で入力してください。', 'error');
      urlInput.focus();
      return;
    }

    button.disabled = true;
    button.textContent = '登録中…';
    clearMessageIn('app');

    Api.appAdd(hooks.getToken(), name, url, desc).then(function (result) {
      if (!result.ok) {
        showMessageIn('app', result.message || '登録できませんでした。', 'error');
        return;
      }
      showMessageIn('app', result.app_name + ' を登録しました。', 'ok');
      nameInput.value = '';
      urlInput.value = '';
      descInput.value = '';
      nameInput.focus();

      if (hooks.onAppsChanged) { hooks.onAppsChanged(); }   // 左のアプリ一覧もすぐ更新
      return loadAppList();
    }).catch(function (error) {
      showMessageIn('app', '登録できませんでした。' + error.message, 'error');
    }).then(function () {
      button.disabled = false;
      button.textContent = '登録';
    });
  }

  /* ---------------------------------------------------------
     開閉
     --------------------------------------------------------- */
  function open() {
    if (isOpen) { return; }
    lastFocused = document.activeElement;
    isOpen = true;

    els.modal.hidden = false;
    els.body.innerHTML = bodyHtml();
    bindBody();

    if (!Api.isReady()) {
      showMessage('Supabaseに接続できませんでした。通信状態をご確認ください。', 'error');
      renderStaffList([]);
      renderAppList([]);
      return;
    }
    loadStaffList();
    loadAppList();
  }

  function close() {
    if (!isOpen) { return; }
    isOpen = false;
    els.modal.hidden = true;
    els.body.innerHTML = '';
    if (lastFocused && lastFocused.focus) { lastFocused.focus(); }
  }

  function bindBody() {
    document.getElementById('staffAddToggle').addEventListener('click', function () {
      var area = document.getElementById('staffFormArea');
      toggleForm(area.hidden);
    });
    document.getElementById('staffCancel').addEventListener('click', function () {
      toggleForm(false);
    });
    document.getElementById('staffSubmit').addEventListener('click', submitStaff);

    // パスワード欄は数字だけにする
    var pass = document.getElementById('staffPassword');
    pass.addEventListener('input', function () {
      pass.value = pass.value.replace(/[^0-9]/g, '').slice(0, 4);
    });

    // Enterでも登録できるようにする
    document.getElementById('staffFormArea').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitStaff();
      }
    });

    // --- アプリ管理 ---
    document.getElementById('appAddToggle').addEventListener('click', function () {
      var area = document.getElementById('appFormArea');
      toggleAppForm(area.hidden);
    });
    document.getElementById('appCancel').addEventListener('click', function () {
      toggleAppForm(false);
    });
    document.getElementById('appSubmit').addEventListener('click', submitApp);

    // 説明欄は改行できるようにするため、Enterでの送信は名前とURLの欄だけ
    ['appName', 'appUrl'].forEach(function (id) {
      document.getElementById(id).addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitApp();
        }
      });
    });
  }

  /* ---------------------------------------------------------
     公開する処理
     --------------------------------------------------------- */
  var Settings = {
    init: function (options) {
      els.modal = options.modalEl;
      els.body  = options.bodyEl;
      hooks = options.hooks || {};

      options.openButton.addEventListener('click', open);

      els.modal.addEventListener('click', function (event) {
        if (event.target.closest('[data-close]')) { close(); }
      });

      global.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && isOpen) { close(); }
      });
    },
    open: open,
    close: close
  };

  global.AppShareSettings = Settings;
})(window);
