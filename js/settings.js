/* =========================================================
   js/settings.js
   設定画面（自分のアカウント / 職員管理 / アプリ管理）

   設定画面は施設で共有する4桁の「設定パスワード」で保護する。
   確認できた場合だけ 30分有効の settings_token を受け取り、
   職員登録とアプリ登録はその token をSupabaseへ渡して検証させる。
   設定パスワードそのものは保存しない。

   ・登録済み職員の一覧表示   … appshare_staff_list()
   ・職員の追加               … appshare_staff_add()
   ・登録済みアプリの一覧表示 … appshare_apps_list(token)
   ・アプリの追加             … appshare_app_add(token, name, url, description)
   ・自分のパスワード変更     … appshare_password_change(token, 現在, 新しい)
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

  // 設定用トークン（sessionStorage に置く。ブラウザを閉じると消える）
  var SETTINGS_KEY = 'app-share/settings-session';
  var settingsSession = null;   // { token, expiresAt }
  var gateBusy = false;
  var deletingStaffId = null;   // 削除の確認を出している職員
  var staffBusy = false;        // 削除の通信中
  var staffCache = [];          // 表示中の職員一覧
  var deletingAppId = null;     // 削除の確認を出しているアプリ
  var appBusy = false;          // アプリ削除の通信中
  var appCache = [];            // 表示中のアプリ一覧

  /* ---------------------------------------------------------
     画面の組み立て
     --------------------------------------------------------- */
  function accountHtml() {
    var loggedIn = !!(hooks.isLoggedIn && hooks.isLoggedIn());
    var name = (hooks.getDisplayName && hooks.getDisplayName()) || '';

    if (!loggedIn) {
      return '' +
        '<section class="settings-section">' +
          '<div class="settings-section__head">' +
            '<div>' +
              '<h3 class="settings-section__title">自分のアカウント</h3>' +
              '<p class="settings-section__note">ログインすると、自分のパスワードを変更できます。</p>' +
            '</div>' +
          '</div>' +
          '<div class="empty">' +
            '<p class="empty__text">ログインしていません。</p>' +
            '<button class="button" type="button" id="accountLoginButton">ログイン</button>' +
          '</div>' +
        '</section>';
    }

    return '' +
      '<section class="settings-section">' +
        '<div class="settings-section__head">' +
          '<div>' +
            '<h3 class="settings-section__title">自分のアカウント</h3>' +
            '<p class="settings-section__note">ログイン中の職員のパスワードを変更できます。</p>' +
          '</div>' +
          '<button class="button button--ghost" type="button" id="passwordToggle">' +
            '<span>パスワード変更</span>' +
          '</button>' +
        '</div>' +

        '<div class="account-box">' +
          '<span class="staff-item__avatar" aria-hidden="true">' + Util.escapeHtml(Util.initial(name)) + '</span>' +
          '<span class="account-box__body">' +
            '<span class="account-box__label">ログイン中</span>' +
            '<span class="account-box__name">' + Util.escapeHtml(name) + '</span>' +
          '</span>' +
        '</div>' +

        '<div class="staff-form" id="passwordFormArea" hidden>' +
          '<div class="field">' +
            '<label class="field__label" for="currentPassword">現在のパスワード</label>' +
            '<input class="field__input field__input--short" id="currentPassword" type="password" ' +
                   'inputmode="numeric" maxlength="4" autocomplete="current-password" placeholder="••••">' +
          '</div>' +
          '<div class="field">' +
            '<label class="field__label" for="newPassword">新しいパスワード</label>' +
            '<input class="field__input field__input--short" id="newPassword" type="password" ' +
                   'inputmode="numeric" maxlength="4" autocomplete="new-password" placeholder="••••">' +
            '<p class="field__hint">4桁の数字で入力してください。</p>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field__label" for="newPasswordConfirm">新しいパスワード（確認）</label>' +
            '<input class="field__input field__input--short" id="newPasswordConfirm" type="password" ' +
                   'inputmode="numeric" maxlength="4" autocomplete="new-password" placeholder="••••">' +
          '</div>' +
          '<div class="staff-form__actions">' +
            '<button class="button" type="button" id="passwordSubmit">変更する</button>' +
            '<button class="button button--quiet" type="button" id="passwordCancel">閉じる</button>' +
          '</div>' +
          '<p class="field__hint">変更すると、他の端末では改めてログインが必要になります。' +
            'この端末はそのまま使えます。</p>' +
        '</div>' +

        '<div class="inline-notice" id="passwordMessage" hidden>' +
          '<span class="inline-notice__icon" aria-hidden="true" id="passwordMessageIcon"></span>' +
          '<span id="passwordMessageText"></span>' +
        '</div>' +
      '</section>';
  }

  function bodyHtml() {
    return '' +
      accountHtml() +
      '<section class="settings-section settings-section--split">' +
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
     設定用トークンの保持
     設定パスワードそのものは保存しない
     --------------------------------------------------------- */
  function readSettingsSession() {
    try {
      var raw = global.sessionStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeSettingsSession(value) {
    try {
      if (value === null) {
        global.sessionStorage.removeItem(SETTINGS_KEY);
      } else {
        global.sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      }
    } catch (e) { /* 保存できなくても、その場では使える */ }
  }

  /** 有効な設定用トークン。期限切れなら null */
  function settingsToken() {
    if (!settingsSession) { settingsSession = readSettingsSession(); }
    if (!settingsSession || !settingsSession.token) { return null; }

    var expires = new Date(settingsSession.expiresAt).getTime();
    if (!expires || expires <= Date.now()) {
      settingsSession = null;
      writeSettingsSession(null);
      return null;
    }
    return settingsSession.token;
  }

  function keepSettingsSession(token, validUntil) {
    settingsSession = { token: token, expiresAt: validUntil };
    writeSettingsSession(settingsSession);
  }

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
      var id = Util.escapeHtml(row.id);
      var busy = staffBusy && deletingStaffId === row.id;

      var actions = (deletingStaffId === row.id)
        ? '<span class="staff-item__confirm">' +
            Util.escapeHtml(row.display_name) + ' さんを削除しますか？<br>この操作は元に戻せません。' +
          '</span>' +
          '<span class="staff-item__actions">' +
            '<button class="comment__action comment__action--danger" type="button" ' +
                    'data-staff-delete-yes="' + id + '"' + (busy ? ' disabled' : '') + '>' +
              (busy ? '削除中…' : '削除する') + '</button>' +
            '<button class="comment__action" type="button" data-staff-delete-no="1">キャンセル</button>' +
          '</span>'
        : '<span class="staff-item__actions">' +
            '<button class="comment__action" type="button" data-staff-delete="' + id + '">削除</button>' +
          '</span>';

      return '' +
        '<li class="staff-item' + (deletingStaffId === row.id ? ' staff-item--confirm' : '') + '">' +
          '<span class="staff-item__avatar" aria-hidden="true">' +
            Util.escapeHtml(Util.initial(row.display_name)) +
          '</span>' +
          '<span class="staff-item__name">' + Util.escapeHtml(row.display_name) + '</span>' +
          actions +
        '</li>';
    }).join('') + '</ul>';

    // 一覧の枠は描き直しても同じ要素なので、クリック処理は一度だけ付ける
    if (!area.dataset.staffBound) {
      area.dataset.staffBound = '1';
      area.addEventListener('click', handleStaffListClick);
    }
  }

  function reRenderStaffList() {
    renderStaffList(staffCache);
  }

  function loadStaffList() {
    var area = document.getElementById('staffListArea');
    if (area) {
      area.innerHTML = '<div class="empty"><p class="empty__text">読み込んでいます…</p></div>';
    }

    return Api.staffList().then(function (rows) {
      staffCache = rows;
      renderStaffList(rows);
    }).catch(function (error) {
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

    var gate = settingsToken();
    if (!gate) {
      showMessage('設定パスワードの確認が必要です。設定を開き直してください。', 'error');
      button.disabled = false;
      button.textContent = '登録';
      return;
    }

    Api.staffAdd(gate, name, pass).then(function (result) {
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
     自分のアカウント（パスワード変更）
     --------------------------------------------------------- */
  function togglePasswordForm(show) {
    var area = document.getElementById('passwordFormArea');
    if (!area) { return; }
    area.hidden = !show;
    if (show) {
      clearMessageIn('password');
      document.getElementById('currentPassword').focus();
    }
  }

  function clearPasswordInputs() {
    ['currentPassword', 'newPassword', 'newPasswordConfirm'].forEach(function (id) {
      var input = document.getElementById(id);
      if (input) { input.value = ''; }
    });
  }

  function submitPassword() {
    var current = document.getElementById('currentPassword');
    var next    = document.getElementById('newPassword');
    var confirm = document.getElementById('newPasswordConfirm');
    var button  = document.getElementById('passwordSubmit');
    if (!current || !next || !confirm) { return; }

    // 画面側でも先に確認する（保存時の判定はSupabase側でも行う）
    if (!/^[0-9]{4}$/.test(current.value)) {
      showMessageIn('password', '現在のパスワードを4桁の数字で入力してください。', 'error');
      current.focus();
      return;
    }
    if (!/^[0-9]{4}$/.test(next.value)) {
      showMessageIn('password', '新しいパスワードは4桁の数字で入力してください。', 'error');
      next.focus();
      return;
    }
    if (next.value !== confirm.value) {
      showMessageIn('password', '新しいパスワードが一致しません', 'error');
      confirm.value = '';
      confirm.focus();
      return;                                  // ここではRPCを呼ばない
    }

    button.disabled = true;
    button.textContent = '変更中…';
    clearMessageIn('password');

    Api.passwordChange(hooks.getToken(), current.value, next.value).then(function (result) {
      if (!result.ok) {
        showMessageIn('password', result.message || '変更できませんでした。', 'error');
        return;
      }
      showMessageIn('password', 'パスワードを変更しました', 'ok');
      clearPasswordInputs();
      current.focus();
    }).catch(function (error) {
      showMessageIn('password', '変更できませんでした。' + error.message, 'error');
    }).then(function () {
      button.disabled = false;
      button.textContent = '変更する';
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
      var id = Util.escapeHtml(row.id);
      var confirming = deletingAppId === row.id;
      var busy = appBusy && confirming;

      var actions = confirming
        ? '<span class="app-reg-item__confirm">' +
            Util.escapeHtml(row.name) + ' を削除しますか？<br>' +
            'このアプリのチャット・写真・確認履歴もすべて削除されます。<br>' +
            'この操作は元に戻せません。' +
          '</span>' +
          '<span class="staff-item__actions">' +
            '<button class="comment__action comment__action--danger" type="button" ' +
                    'data-app-delete-yes="' + id + '"' + (busy ? ' disabled' : '') + '>' +
              (busy ? '削除中…' : '削除する') + '</button>' +
            '<button class="comment__action" type="button" data-app-delete-no="1"' +
                    (busy ? ' disabled' : '') + '>キャンセル</button>' +
          '</span>'
        : '<span class="staff-item__actions">' +
            '<button class="comment__action" type="button" data-app-delete="' + id + '">削除</button>' +
          '</span>';

      return '' +
        '<li class="app-reg-item' + (confirming ? ' app-reg-item--confirm' : '') + '">' +
          '<span class="app-reg-item__body">' +
            '<span class="app-reg-item__name">' + Util.escapeHtml(row.name) + '</span>' +
            '<span class="app-reg-item__url">' + Util.escapeHtml(row.url) + '</span>' +
            (row.description
              ? '<span class="app-reg-item__desc">' + Util.escapeHtml(row.description) + '</span>' : '') +
          '</span>' +
          actions +
        '</li>';
    }).join('') + '</ul>';

    // 一覧の枠は描き直しても同じ要素なので、クリック処理は一度だけ付ける
    if (!area.dataset.appBound) {
      area.dataset.appBound = '1';
      area.addEventListener('click', handleAppListClick);
    }
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

    return Api.appsList(hooks.getToken()).then(function (rows) {
      appCache = rows;
      renderAppList(rows);
    }).catch(function (error) {
      if (area) {
        area.innerHTML = '<div class="empty"><p class="empty__text">' +
          Util.escapeHtml('アプリ一覧を取得できませんでした。' + error.message) + '</p></div>';
      }
    });
  }

  /* ---------------------------------------------------------
     アプリの削除
     --------------------------------------------------------- */
  function handleAppListClick(event) {
    var yes = event.target.closest('[data-app-delete-yes]');
    if (yes) { deleteApp(yes.getAttribute('data-app-delete-yes')); return; }

    if (appBusy) { return; }

    if (event.target.closest('[data-app-delete-no]')) {
      deletingAppId = null;
      clearMessageIn('app');
      renderAppList(appCache);
      return;
    }

    var ask = event.target.closest('[data-app-delete]');
    if (ask) {
      deletingAppId = ask.getAttribute('data-app-delete');
      clearMessageIn('app');
      renderAppList(appCache);
    }
  }

  function deleteApp(appId) {
    if (appBusy) { return; }

    var gate = settingsToken();
    if (!gate) {
      showMessageIn('app', '設定パスワードの確認が必要です。設定を開き直してください。', 'error');
      return;
    }

    appBusy = true;
    clearMessageIn('app');
    renderAppList(appCache);

    var token = hooks.getToken();

    Api.appDelete(token, gate, appId).then(function (result) {
      if (!result.ok) {
        showMessageIn('app', result.message || '削除できませんでした。', 'error');
        return;
      }

      deletingAppId = null;

      // Storage の写真本体を消す（DBからは削除済み。失敗しても削除自体は完了）
      return Api.imageDeleteAll(token, result.image_paths || []).then(function () {
        showMessageIn('app', result.app_name + ' を削除しました。', 'ok');
      }, function () {
        showMessageIn('app', result.app_name + ' を削除しました。（写真の一部を削除できませんでした）', 'ok');
      }).then(function () {
        if (hooks.onAppsChanged) { hooks.onAppsChanged(); }   // 左のアプリ一覧もすぐ更新
        return loadAppList();
      });
    }).catch(function (error) {
      showMessageIn('app', '削除できませんでした。' + error.message, 'error');
    }).then(function () {
      appBusy = false;
      renderAppList(appCache);
    });
  }

  /* ---------------------------------------------------------
     職員の削除
     --------------------------------------------------------- */
  function handleStaffListClick(event) {
    var yes = event.target.closest('[data-staff-delete-yes]');
    if (yes) { deleteStaff(yes.getAttribute('data-staff-delete-yes')); return; }

    if (event.target.closest('[data-staff-delete-no]')) {
      deletingStaffId = null;
      clearMessage();
      reRenderStaffList();
      return;
    }

    var ask = event.target.closest('[data-staff-delete]');
    if (ask) {
      if (staffBusy) { return; }
      deletingStaffId = ask.getAttribute('data-staff-delete');
      clearMessage();
      reRenderStaffList();
    }
  }

  function deleteStaff(staffId) {
    if (staffBusy) { return; }

    var gate = settingsToken();
    if (!gate) {
      showMessage('設定パスワードの確認が必要です。設定を開き直してください。', 'error');
      return;
    }

    staffBusy = true;
    clearMessage();
    reRenderStaffList();

    Api.staffDelete(gate, staffId).then(function (result) {
      if (!result.ok) {
        showMessage(result.message || '削除できませんでした。', 'error');
        return;
      }

      showMessage(result.staff_name + ' さんを削除しました。', 'ok');
      deletingStaffId = null;

      // 自分自身を削除した場合は、ログアウト状態に戻す
      if (hooks.onStaffDeleted) { hooks.onStaffDeleted(staffId); }

      return loadStaffList();
    }).catch(function (error) {
      showMessage('削除できませんでした。' + error.message, 'error');
    }).then(function () {
      staffBusy = false;
      reRenderStaffList();
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

    var gateToken = settingsToken();
    if (!gateToken) {
      showMessageIn('app', '設定パスワードの確認が必要です。設定を開き直してください。', 'error');
      button.disabled = false;
      button.textContent = '登録';
      return;
    }

    Api.appAdd(hooks.getToken(), gateToken, name, url, desc).then(function (result) {
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
     設定パスワードの入力画面
     --------------------------------------------------------- */
  function gateHtml(mode) {
    var first = mode === 'init';

    var fields = first
      ? '<div class="field">' +
          '<label class="field__label" for="gateNew">新しい設定パスワード</label>' +
          '<input class="field__input field__input--short" id="gateNew" type="password" ' +
                 'inputmode="numeric" maxlength="4" autocomplete="new-password" placeholder="••••">' +
          '<p class="field__hint">4桁の数字で入力してください。職員全員で共有します。</p>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field__label" for="gateConfirm">確認</label>' +
          '<input class="field__input field__input--short" id="gateConfirm" type="password" ' +
                 'inputmode="numeric" maxlength="4" autocomplete="new-password" placeholder="••••">' +
        '</div>'
      : '<div class="field">' +
          '<label class="field__label" for="gatePassword">設定パスワード</label>' +
          '<input class="field__input field__input--short" id="gatePassword" type="password" ' +
                 'inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">' +
        '</div>';

    return '' +
      '<section class="settings-section">' +
        '<div class="settings-section__head">' +
          '<div>' +
            '<h3 class="settings-section__title">' +
              (first ? '設定パスワードの登録' : '設定パスワード') +
            '</h3>' +
            '<p class="settings-section__note">' +
              (first
                ? 'この端末から、最初の設定パスワードを決めてください。'
                : '職員管理とアプリ管理を開くには、設定パスワードが必要です。') +
            '</p>' +
          '</div>' +
        '</div>' +

        '<div class="staff-form" style="margin-top:16px">' +
          fields +
          '<div class="staff-form__actions">' +
            '<button class="button" type="button" id="gateSubmit">' +
              (first ? '設定する' : '設定を開く') +
            '</button>' +
          '</div>' +
        '</div>' +

        '<div class="inline-notice" id="gateMessage" hidden>' +
          '<span class="inline-notice__icon" aria-hidden="true" id="gateMessageIcon"></span>' +
          '<span id="gateMessageText"></span>' +
        '</div>' +
      '</section>';
  }

  function renderGate(mode) {
    els.body.innerHTML = gateHtml(mode);

    var ids = mode === 'init' ? ['gateNew', 'gateConfirm'] : ['gatePassword'];

    ids.forEach(function (id) {
      var input = document.getElementById(id);
      input.addEventListener('input', function () {
        input.value = input.value.replace(/[^0-9]/g, '').slice(0, 4);
      });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitGate(mode);
        }
      });
    });

    document.getElementById('gateSubmit').addEventListener('click', function () {
      submitGate(mode);
    });
    document.getElementById(ids[0]).focus();
  }

  function submitGate(mode) {
    if (gateBusy) { return; }

    var button = document.getElementById('gateSubmit');

    if (mode === 'init') {
      var next = document.getElementById('gateNew');
      var confirm = document.getElementById('gateConfirm');

      if (!/^[0-9]{4}$/.test(next.value)) {
        showMessageIn('gate', '設定パスワードは4桁の数字で入力してください。', 'error');
        next.focus();
        return;
      }
      if (next.value !== confirm.value) {
        showMessageIn('gate', '設定パスワードが一致しません', 'error');
        confirm.value = '';
        confirm.focus();
        return;
      }

      gateBusy = true;
      button.disabled = true;
      button.textContent = '設定中…';
      clearMessageIn('gate');

      Api.settingsInit(hooks.getToken ? hooks.getToken() : '', next.value).then(function (result) {
        if (!result.ok) {
          showMessageIn('gate', result.message || '設定できませんでした。', 'error');
          return;
        }
        keepSettingsSession(result.settings_token, result.valid_until);
        renderSettings();
      }).catch(function (error) {
        showMessageIn('gate', '設定できませんでした。' + error.message, 'error');
      }).then(function () {
        gateBusy = false;
        if (button) { button.disabled = false; button.textContent = '設定する'; }
      });
      return;
    }

    var input = document.getElementById('gatePassword');
    if (!/^[0-9]{4}$/.test(input.value)) {
      showMessageIn('gate', '設定パスワードは4桁の数字で入力してください。', 'error');
      input.focus();
      return;
    }

    gateBusy = true;
    button.disabled = true;
    button.textContent = '確認中…';
    clearMessageIn('gate');

    Api.settingsUnlock(input.value).then(function (result) {
      if (!result.ok) {
        var message = /しばらく/.test(result.message || '')
          ? '入力回数が多いため、しばらくしてからお試しください'
          : (result.message || '設定パスワードが違います');
        showMessageIn('gate', message, 'error');
        input.value = '';
        input.focus();
        return;
      }
      keepSettingsSession(result.settings_token, result.valid_until);
      renderSettings();
    }).catch(function (error) {
      showMessageIn('gate', '確認できませんでした。' + error.message, 'error');
    }).then(function () {
      gateBusy = false;
      if (button) { button.disabled = false; button.textContent = '設定を開く'; }
    });
  }

  /* ---------------------------------------------------------
     開閉
     --------------------------------------------------------- */
  /** 設定パスワードの確認が済んでいる場合の本体 */
  function renderSettings() {
    deletingStaffId = null;
    staffBusy = false;
    deletingAppId = null;
    appBusy = false;
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

  function open() {
    if (isOpen) { return; }
    lastFocused = document.activeElement;
    isOpen = true;
    els.modal.hidden = false;

    if (!Api.isReady()) {
      els.body.innerHTML = '<section class="settings-section">' +
        '<div class="empty"><p class="empty__text">' +
        'Supabaseに接続できませんでした。通信状態をご確認ください。' +
        '</p></div></section>';
      return;
    }

    // すでに確認済み（30分以内）なら、そのまま設定画面を開く
    if (settingsToken()) {
      renderSettings();
      return;
    }

    els.body.innerHTML = '<section class="settings-section">' +
      '<div class="empty"><p class="empty__text">読み込んでいます…</p></div></section>';

    // 設定パスワードが未登録なら、最初の登録画面を出す
    Api.settingsStatus().then(function (status) {
      renderGate(status.configured ? 'unlock' : 'init');
      if (status.configured && status.locked) {
        showMessageIn('gate', '入力回数が多いため、しばらくしてからお試しください', 'error');
      }
    }).catch(function (error) {
      els.body.innerHTML = '<section class="settings-section">' +
        '<div class="empty"><p class="empty__text">' +
        Util.escapeHtml('設定の状態を確認できませんでした。' + error.message) +
        '</p></div></section>';
    });
  }

  function close() {
    if (!isOpen) { return; }
    isOpen = false;
    els.modal.hidden = true;
    els.body.innerHTML = '';
    if (lastFocused && lastFocused.focus) { lastFocused.focus(); }
  }

  function bindBody() {
    // --- 自分のアカウント ---
    var accountLogin = document.getElementById('accountLoginButton');
    if (accountLogin) {
      accountLogin.addEventListener('click', function () {
        close();
        if (hooks.onRequireLogin) { hooks.onRequireLogin(); }
      });
    }

    var passwordToggle = document.getElementById('passwordToggle');
    if (passwordToggle) {
      passwordToggle.addEventListener('click', function () {
        var area = document.getElementById('passwordFormArea');
        togglePasswordForm(area.hidden);
      });
      document.getElementById('passwordCancel').addEventListener('click', function () {
        togglePasswordForm(false);
      });
      document.getElementById('passwordSubmit').addEventListener('click', submitPassword);

      // 数字だけにする。Enterでも変更できるようにする
      ['currentPassword', 'newPassword', 'newPasswordConfirm'].forEach(function (id) {
        var input = document.getElementById(id);
        input.addEventListener('input', function () {
          input.value = input.value.replace(/[^0-9]/g, '').slice(0, 4);
        });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitPassword();
          }
        });
      });
    }

    // --- 職員管理 ---
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
