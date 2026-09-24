/* =========================================================
   js/settings.js
   設定画面（今回は「職員管理」のみ）

   ・登録済み職員の一覧表示   … appshare_staff_list()
   ・職員の追加               … appshare_staff_add()
   テーブルへの直接の読み書きは行わない（RPC経由のみ）
   ========================================================= */

(function (global) {
  'use strict';

  var Util = global.AppShareUtil;
  var Api  = global.AppShareSupabase;

  var els = {};        // modal / body / openButton
  var isOpen = false;
  var lastFocused = null;

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
      '</section>';
  }

  var ICON_OK    = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_ALERT = '<svg viewBox="0 0 24 24"><path d="M12 4.5l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/></svg>';

  /* ---------------------------------------------------------
     メッセージ表示（alertは使わない）
     --------------------------------------------------------- */
  function showMessage(text, kind) {
    var box  = document.getElementById('staffMessage');
    var icon = document.getElementById('staffMessageIcon');
    var body = document.getElementById('staffMessageText');
    if (!box) { return; }

    box.className = 'inline-notice' + (kind === 'ok' ? ' inline-notice--ok' : '');
    icon.innerHTML = kind === 'ok' ? ICON_OK : ICON_ALERT;
    body.textContent = text;
    box.hidden = false;
  }

  function clearMessage() {
    var box = document.getElementById('staffMessage');
    if (box) { box.hidden = true; }
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
      return;
    }
    loadStaffList();
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
  }

  /* ---------------------------------------------------------
     公開する処理
     --------------------------------------------------------- */
  var Settings = {
    init: function (options) {
      els.modal = options.modalEl;
      els.body  = options.bodyEl;

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
