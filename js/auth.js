/* =========================================================
   js/auth.js
   職員ログイン

   ・職員一覧   … appshare_staff_list()
   ・ログイン   … appshare_login(p_staff_id, p_pin)
     ※ Supabase側の引数名は p_pin のままだが、
        画面の表記はすべて「パスワード」で統一する

   ブラウザに保存するのは
     セッショントークン / 職員表示名 / 有効期限
   の3つだけ。パスワードは保存しない。
   ========================================================= */

(function (global) {
  'use strict';

  var Util = global.AppShareUtil;
  var Api  = global.AppShareSupabase;

  var SESSION_KEY = 'app-share/session';

  var els = {};            // modal / body
  var isOpen = false;
  var lastFocused = null;
  var onChange = null;     // ログイン状態が変わったときに呼ぶ
  var onOpenSettings = null;
  var staffCache = [];

  /* ---------------------------------------------------------
     セッションの保存と取り出し
     --------------------------------------------------------- */
  function readRaw() {
    try {
      var raw = global.localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeRaw(value) {
    try {
      if (value === null) {
        global.localStorage.removeItem(SESSION_KEY);
      } else {
        global.localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 有効なセッションを返す。期限切れなら破棄して null */
  function getSession() {
    var s = readRaw();
    if (!s || !s.token || !s.displayName || !s.expiresAt) { return null; }

    var expires = new Date(s.expiresAt).getTime();
    if (!expires || expires <= Date.now()) {
      writeRaw(null);
      return null;
    }
    return s;
  }

  function isLoggedIn() { return !!getSession(); }

  function currentName() {
    var s = getSession();
    return s ? s.displayName : '';
  }

  function logout() {
    writeRaw(null);
    if (onChange) { onChange(null); }
  }

  /* ---------------------------------------------------------
     画面
     --------------------------------------------------------- */
  var ICON_ALERT = '<svg viewBox="0 0 24 24"><path d="M12 4.5l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/></svg>';
  var ICON_INFO  = '<svg viewBox="0 0 24 24"><path d="M12 20.5a8.5 8.5 0 100-17 8.5 8.5 0 000 17z"/><path d="M12 11v5.5"/><path d="M12 7.6v.2"/></svg>';

  function loadingHtml() {
    return '<div class="empty"><p class="empty__text">職員一覧を読み込んでいます…</p></div>';
  }

  /** 職員が0人のとき */
  function emptyHtml() {
    return '' +
      '<div class="inline-notice">' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_INFO + '</span>' +
        '<span>職員がまだ登録されていません。設定から職員を登録してください。</span>' +
      '</div>' +
      '<div class="login-form__actions">' +
        '<button class="button" type="button" id="loginOpenSettings">設定を開く</button>' +
      '</div>';
  }

  function formHtml(staff) {
    var options = staff.map(function (row) {
      return '<option value="' + Util.escapeHtml(row.id) + '">' +
             Util.escapeHtml(row.display_name) + '</option>';
    }).join('');

    return '' +
      '<div class="field">' +
        '<label class="field__label" for="loginStaff">職員</label>' +
        '<select class="field__input field__select" id="loginStaff">' + options + '</select>' +
      '</div>' +
      '<div class="field">' +
        '<label class="field__label" for="loginPassword">パスワード</label>' +
        '<input class="field__input field__input--short" id="loginPassword" type="password" ' +
               'inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">' +
        '<p class="field__hint">4桁の数字で入力してください。</p>' +
      '</div>' +
      '<div class="inline-notice" id="loginMessage" hidden>' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_ALERT + '</span>' +
        '<span id="loginMessageText"></span>' +
      '</div>' +
      '<div class="login-form__actions">' +
        '<button class="button" type="button" id="loginSubmit">ログイン</button>' +
      '</div>';
  }

  function showMessage(text) {
    var box  = document.getElementById('loginMessage');
    var body = document.getElementById('loginMessageText');
    if (!box) { return; }
    body.textContent = text;
    box.hidden = false;
  }

  function clearMessage() {
    var box = document.getElementById('loginMessage');
    if (box) { box.hidden = true; }
  }

  /* ---------------------------------------------------------
     職員一覧の取得と描画
     --------------------------------------------------------- */
  function renderStaff(staff) {
    staffCache = staff;

    if (!staff.length) {
      els.body.innerHTML = emptyHtml();
      var settingsButton = document.getElementById('loginOpenSettings');
      if (settingsButton) {
        settingsButton.addEventListener('click', function () {
          close();
          if (onOpenSettings) { onOpenSettings(); }
        });
      }
      return;
    }

    els.body.innerHTML = formHtml(staff);

    var pass = document.getElementById('loginPassword');
    pass.addEventListener('input', function () {
      pass.value = pass.value.replace(/[^0-9]/g, '').slice(0, 4);
    });

    els.body.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    document.getElementById('loginSubmit').addEventListener('click', submit);
    document.getElementById('loginStaff').focus();
  }

  function loadStaff() {
    els.body.innerHTML = loadingHtml();

    if (!Api.isReady()) {
      els.body.innerHTML = '<div class="inline-notice">' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_ALERT + '</span>' +
        '<span>Supabaseに接続できませんでした。通信状態をご確認ください。</span></div>';
      return;
    }

    Api.staffList().then(renderStaff).catch(function (error) {
      els.body.innerHTML = '<div class="inline-notice">' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_ALERT + '</span>' +
        '<span>' + Util.escapeHtml('職員一覧を取得できませんでした。' + error.message) + '</span></div>';
    });
  }

  /* ---------------------------------------------------------
     ログイン
     --------------------------------------------------------- */
  function submit() {
    var select = document.getElementById('loginStaff');
    var pass   = document.getElementById('loginPassword');
    var button = document.getElementById('loginSubmit');
    if (!select || !pass) { return; }

    var staffId  = select.value;
    var password = pass.value;

    if (!staffId) {
      showMessage('職員を選んでください。');
      return;
    }
    if (!/^[0-9]{4}$/.test(password)) {
      showMessage('パスワードは4桁の数字で入力してください。');
      pass.focus();
      return;
    }

    button.disabled = true;
    button.textContent = '確認中…';
    clearMessage();

    // Supabase側の引数名は p_pin（画面表記はパスワード）
    Api.rpc('appshare_login', { p_staff_id: staffId, p_pin: password })
      .then(function (rows) {
        var result = (rows && rows[0]) || { ok: false, message: 'ログインできませんでした' };

        if (!result.ok) {
          showMessage(result.message || 'ログインできませんでした。');
          pass.value = '';
          pass.focus();
          return;
        }

        var saved = writeRaw({
          token: result.token,
          displayName: result.display_name,
          expiresAt: result.expires_at
        });

        if (!saved) {
          showMessage('ログイン情報を保存できませんでした。ブラウザの設定をご確認ください。');
          return;
        }

        pass.value = '';
        close();
        if (onChange) { onChange(getSession()); }
      })
      .catch(function (error) {
        showMessage('ログインできませんでした。' + error.message);
      })
      .then(function () {
        if (button) {
          button.disabled = false;
          button.textContent = 'ログイン';
        }
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
    loadStaff();
  }

  function close() {
    if (!isOpen) { return; }
    isOpen = false;
    els.modal.hidden = true;
    els.body.innerHTML = '';
    if (lastFocused && lastFocused.focus) { lastFocused.focus(); }
  }

  /* ---------------------------------------------------------
     公開する処理
     --------------------------------------------------------- */
  var Auth = {
    init: function (options) {
      els.modal      = options.modalEl;
      els.body       = options.bodyEl;
      onChange       = options.onChange;
      onOpenSettings = options.onOpenSettings;

      options.openButton.addEventListener('click', open);
      options.logoutButton.addEventListener('click', logout);

      els.modal.addEventListener('click', function (event) {
        if (event.target.closest('[data-close]')) { close(); }
      });

      global.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && isOpen) { close(); }
      });

      // 開いたままでも期限切れに気づけるよう、1分ごとに確認する
      global.setInterval(function () {
        var stored = readRaw();
        if (stored && !getSession() && onChange) { onChange(null); }
      }, 60000);
    },

    open: open,
    close: close,
    logout: logout,
    getSession: getSession,
    isLoggedIn: isLoggedIn,
    currentName: currentName
  };

  global.AppShareAuth = Auth;
})(window);
