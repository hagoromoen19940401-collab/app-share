/* =========================================================
   js/chat.js
   コメント（チャット）機能

   保存先は Supabase。テーブルへは直接アクセスせず、RPC経由で読み書きする。
   ・取得 … appshare_comments_list(p_token, p_app_id, p_limit)
   ・投稿 … appshare_comment_add(p_token, p_app_id, p_body)

   投稿者名・staff_id・日時・状態はSupabase側で決まる。
   ブラウザからは指定しない（なりすまし防止のため）。

   ログイン中かつチャットタブを開いている間だけ、約5秒ごとに再取得する。
   ========================================================= */

(function (global) {
  'use strict';

  var POLL_INTERVAL = 5000;   // 5秒
  var FETCH_LIMIT   = 200;

  /* ---------------------------------------------------------
     共通ユーティリティ（他のファイルからも使用）
     --------------------------------------------------------- */
  var Util = {
    /** HTML に埋め込む前に必ず通す */
    escapeHtml: function (value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /** 2026-09-25 → 2026/09/25 */
    formatDate: function (isoDate) {
      if (!isoDate) { return '—'; }
      var parts = String(isoDate).split('-');
      if (parts.length !== 3) { return String(isoDate); }
      return parts[0] + '/' + parts[1] + '/' + parts[2];
    },

    /** 投稿日時 → 9/25 10:30（年が違う場合は年も表示） */
    formatDateTime: function (isoString) {
      var date = new Date(isoString);
      if (isNaN(date.getTime())) { return ''; }
      var now = new Date();
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var text = (date.getMonth() + 1) + '/' + date.getDate() +
                 ' ' + date.getHours() + ':' + pad(date.getMinutes());
      if (date.getFullYear() !== now.getFullYear()) {
        text = date.getFullYear() + '/' + text;
      }
      return text;
    },

    /** アバター用の1文字 */
    initial: function (name) {
      var trimmed = String(name || '').trim();
      return trimmed ? trimmed.charAt(0) : '?';
    }
  };

  /* ---------------------------------------------------------
     localStorage ラッパー
     --------------------------------------------------------- */
  var Storage = {
    read: function (key, fallback) {
      try {
        var raw = global.localStorage.getItem(key);
        if (!raw) { return fallback; }
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    write: function (key, value) {
      try {
        global.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  /* ---------------------------------------------------------
     【旧】端末内に保存していたコメント
     Supabaseへ移行したため、表示にも投稿にも使用しない。
     過去のデータを消さないために読み出しだけ残してある。
     --------------------------------------------------------- */
  var LEGACY_KEY_PREFIX = 'app-share/comments/';
  var LEGACY_USER_KEY   = 'app-share/user-name';

  var LegacyStore = {
    key: function (appId) { return LEGACY_KEY_PREFIX + appId; },
    list: function (appId) {
      var items = Storage.read(this.key(appId), []);
      return Array.isArray(items) ? items : [];
    },
    count: function (appId) { return this.list(appId).length; },
    userName: function () {
      var name = Storage.read(LEGACY_USER_KEY, '');
      return typeof name === 'string' ? name : '';
    }
  };

  /* ---------------------------------------------------------
     状態
     --------------------------------------------------------- */
  var els = {};            // listEl / composerEl / scrollEl
  var hooks = {};          // getToken / isLoggedIn / onRequireLogin /
                           // onCountsChanged / onSessionExpired

  var currentAppId = null;
  var isActive     = false;   // チャットタブを表示しているか
  var timer        = null;
  var inFlight     = false;
  var isPosting    = false;

  var cache      = {};        // appId -> コメントの配列
  var counts     = {};        // appId -> 件数
  var loadedOnce = {};        // appId -> 一度でも取得できたか
  var listError  = '';
  var postError  = '';
  var signature  = '';        // 表示中の内容。変わらなければ描画し直さない

  function isLoggedIn() { return !!(hooks.isLoggedIn && hooks.isLoggedIn()); }
  function token()      { return hooks.getToken ? hooks.getToken() : ''; }

  function isAuthError(error) {
    return !!error && /ログインが必要です/.test(error.message || '');
  }

  /* ---------------------------------------------------------
     描画
     --------------------------------------------------------- */
  var ICON_ALERT = '<svg viewBox="0 0 24 24"><path d="M12 4.5l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/></svg>';

  function noticeHtml(text) {
    return '' +
      '<div class="inline-notice inline-notice--tight">' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_ALERT + '</span>' +
        '<span>' + Util.escapeHtml(text) + '</span>' +
      '</div>';
  }

  function statusBadge(status) {
    var labels = global.AppShareData.commentStatus;
    var label = labels[status] || labels.pending || status;
    var suffix = status === 'done' ? ' comment__status--done'
               : status === 'checking' ? ' comment__status--checking'
               : '';
    return '<span class="comment__status' + suffix + '">' + Util.escapeHtml(label) + '</span>';
  }

  function commentHtml(comment) {
    return '' +
      '<article class="comment">' +
        '<div class="comment__avatar" aria-hidden="true">' + Util.escapeHtml(Util.initial(comment.author)) + '</div>' +
        '<div class="comment__body">' +
          '<div class="comment__head">' +
            '<span class="comment__author">' + Util.escapeHtml(comment.author) + '</span>' +
            '<time class="comment__time">' + Util.escapeHtml(Util.formatDateTime(comment.created_at)) + '</time>' +
            statusBadge(comment.status) +
          '</div>' +
          '<p class="comment__text">' + Util.escapeHtml(comment.body) + '</p>' +
        '</div>' +
      '</article>';
  }

  function loginPromptHtml() {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon"><svg viewBox="0 0 24 24"><path d="M6.5 10.5h11v9h-11z"/><path d="M9 10.5V8a3 3 0 016 0v2.5"/></svg></div>' +
        '<p class="empty__text">コメントを見る・投稿するにはログインしてください</p>' +
        '<button class="button" type="button" id="commentLoginButton">ログイン</button>' +
      '</div>';
  }

  function emptyHtml() {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon"><svg viewBox="0 0 24 24"><path d="M4 5.5h16v10.5H9.5L5.5 19.5V16H4z"/></svg></div>' +
        '<p class="empty__text">まだコメントはありません。気づいた点を書き込んでください。</p>' +
      '</div>';
  }

  function atBottom() {
    if (!els.scrollEl) { return true; }
    var gap = els.scrollEl.scrollHeight - els.scrollEl.scrollTop - els.scrollEl.clientHeight;
    return gap < 80;
  }

  function scrollToBottom() {
    if (els.scrollEl) { els.scrollEl.scrollTop = els.scrollEl.scrollHeight; }
  }

  function currentRows() {
    return (currentAppId && cache[currentAppId]) || [];
  }

  function buildSignature(rows) {
    return [
      isLoggedIn() ? '1' : '0',
      currentAppId || '',
      listError,
      rows.map(function (row) { return row.id; }).join(',')
    ].join('|');
  }

  function renderList(force) {
    var rows = currentRows();
    var next = buildSignature(rows);
    if (!force && next === signature) { return; }   // 変化がなければ描き直さない

    var keepBottom = atBottom();
    signature = next;

    var body;
    if (!isLoggedIn()) {
      body = loginPromptHtml();
    } else if (listError && !rows.length) {
      body = noticeHtml(listError);
    } else if (!rows.length) {
      body = loadedOnce[currentAppId] ? emptyHtml() : loadingHtml();
    } else {
      body = (listError ? noticeHtml(listError) : '') +
             '<div class="comment-list">' + rows.map(commentHtml).join('') + '</div>';
    }

    els.listEl.innerHTML = '' +
      '<div class="comments__head">' +
        '<h2 class="section-title">コメント</h2>' +
        '<span class="comments__count">' + (isLoggedIn() ? rows.length + '件' : '') + '</span>' +
      '</div>' + body;

    var loginButton = document.getElementById('commentLoginButton');
    if (loginButton) {
      loginButton.addEventListener('click', function () {
        if (hooks.onRequireLogin) { hooks.onRequireLogin(); }
      });
    }

    if (keepBottom && rows.length) { scrollToBottom(); }
  }

  function loadingHtml() {
    return '<div class="empty"><p class="empty__text">コメントを読み込んでいます…</p></div>';
  }

  /* ---------------------------------------------------------
     入力欄
     --------------------------------------------------------- */
  function renderComposer() {
    els.composerEl.innerHTML = '' +
      '<div class="composer__error inline-notice inline-notice--tight" id="composerError" hidden>' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_ALERT + '</span>' +
        '<span id="composerErrorText"></span>' +
      '</div>' +
      '<div class="composer__box" id="composerBox">' +
        '<textarea class="composer__input" id="commentInput" rows="1" ' +
          'placeholder="このアプリについてのコメントを入力" aria-label="コメント本文"></textarea>' +
        '<button class="button composer__send" id="commentSend" type="button" disabled>送信</button>' +
      '</div>' +
      '<p class="composer__hint" id="composerHint">コメントは職員全員に共有されます（Command + Enter でも送信できます）。</p>';

    var box   = document.getElementById('composerBox');
    var input = document.getElementById('commentInput');
    var send  = document.getElementById('commentSend');

    function autoResize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }

    function updateSendState() {
      send.disabled = isPosting || !isLoggedIn() || input.value.trim() === '';
    }

    input.addEventListener('input', function () {
      autoResize();
      updateSendState();
    });
    input.addEventListener('focus', function () { box.classList.add('is-focus'); });
    input.addEventListener('blur',  function () { box.classList.remove('is-focus'); });
    input.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    send.addEventListener('click', submit);

    els.composerEl.autoResize      = autoResize;
    els.composerEl.updateSendState = updateSendState;
  }

  function updateComposerState() {
    var input = document.getElementById('commentInput');
    var send  = document.getElementById('commentSend');
    var hint  = document.getElementById('composerHint');
    if (!input || !send) { return; }

    var loggedIn = isLoggedIn();
    input.disabled = !loggedIn || isPosting;
    input.placeholder = loggedIn
      ? 'このアプリについてのコメントを入力'
      : 'ログインするとコメントを投稿できます';
    send.disabled = isPosting || !loggedIn || input.value.trim() === '';
    send.textContent = isPosting ? '送信中…' : '送信';

    if (hint) {
      hint.textContent = loggedIn
        ? 'コメントは職員全員に共有されます（Command + Enter でも送信できます）。'
        : 'コメントの閲覧・投稿にはログインが必要です。';
    }
  }

  function showPostError(text) {
    postError = text || '';
    var box  = document.getElementById('composerError');
    var body = document.getElementById('composerErrorText');
    if (!box || !body) { return; }
    if (!postError) { box.hidden = true; return; }
    body.textContent = postError;
    box.hidden = false;
  }

  /* ---------------------------------------------------------
     取得
     --------------------------------------------------------- */
  function fetchComments() {
    if (!currentAppId || !isLoggedIn() || inFlight) { return Promise.resolve(); }

    var appId = currentAppId;
    inFlight = true;

    return global.AppShareSupabase.rpc('appshare_comments_list', {
      p_token:  token(),
      p_app_id: appId,
      p_limit:  FETCH_LIMIT
    }).then(function (rows) {
      if (appId !== currentAppId) { return; }      // 表示中のアプリが変わっていたら捨てる
      cache[appId]      = rows || [];
      counts[appId]     = cache[appId].length;
      loadedOnce[appId] = true;
      listError = '';
      renderList();
      if (hooks.onCountsChanged) { hooks.onCountsChanged(); }
    }).catch(function (error) {
      if (isAuthError(error)) {
        if (hooks.onSessionExpired) { hooks.onSessionExpired(); }
        return;
      }
      if (appId !== currentAppId) { return; }
      listError = 'コメントを取得できませんでした。' + (error.message || '');
      renderList(true);
    }).then(function () {
      inFlight = false;
    });
  }

  /* ---------------------------------------------------------
     投稿
     --------------------------------------------------------- */
  function submit() {
    var input = document.getElementById('commentInput');
    if (!input) { return; }

    var text = input.value.trim();
    if (!text) { return; }

    if (!isLoggedIn()) {
      showPostError('コメントを投稿するにはログインしてください。');
      if (hooks.onRequireLogin) { hooks.onRequireLogin(); }
      return;
    }

    var appId = currentAppId;
    isPosting = true;
    showPostError('');
    updateComposerState();

    // 投稿者名・日時・状態はSupabase側で決まる
    global.AppShareSupabase.rpc('appshare_comment_add', {
      p_token:  token(),
      p_app_id: appId,
      p_body:   text
    }).then(function (rows) {
      var row = rows && rows[0];
      if (!row) { throw new Error('保存結果を受け取れませんでした'); }

      cache[appId] = (cache[appId] || []).filter(function (item) {
        return item.id !== row.id;               // 念のため重複を避ける
      }).concat([row]);
      counts[appId]     = cache[appId].length;
      loadedOnce[appId] = true;
      listError = '';

      input.value = '';
      if (els.composerEl.autoResize) { els.composerEl.autoResize(); }

      if (appId === currentAppId) {
        renderList();
        scrollToBottom();
      }
      if (hooks.onCountsChanged) { hooks.onCountsChanged(); }
    }).catch(function (error) {
      if (isAuthError(error)) {
        showPostError('ログインの有効期限が切れました。もう一度ログインしてください。');
        if (hooks.onSessionExpired) { hooks.onSessionExpired(); }
        return;
      }
      // 端末ごとに内容が食い違わないよう、失敗した投稿は端末内に保存しない
      showPostError('コメントを送信できませんでした。' + (error.message || ''));
    }).then(function () {
      isPosting = false;
      updateComposerState();
    });
  }

  /* ---------------------------------------------------------
     5秒ごとの再取得
     --------------------------------------------------------- */
  function canPoll() {
    return isActive && isLoggedIn() && !!currentAppId &&
           !(global.document && global.document.hidden);
  }

  function stopPolling() {
    if (timer) {
      global.clearInterval(timer);
      timer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!canPoll()) { return; }
    timer = global.setInterval(function () {
      if (!canPoll()) { stopPolling(); return; }
      fetchComments();
    }, POLL_INTERVAL);
  }

  function syncPolling(fetchNow) {
    if (canPoll()) {
      if (fetchNow) { fetchComments(); }
      startPolling();
    } else {
      stopPolling();
    }
  }

  /* ---------------------------------------------------------
     公開する処理
     --------------------------------------------------------- */
  var Chat = {
    util: Util,

    /** 旧データ（localStorage）の参照のみ。表示・投稿には使わない */
    legacy: LegacyStore,

    /** サイドバーやタブに出す件数。取得前は null */
    countFor: function (appId) {
      return Object.prototype.hasOwnProperty.call(counts, appId) ? counts[appId] : null;
    },

    init: function (options) {
      els.listEl     = options.listEl;
      els.composerEl = options.composerEl;
      els.scrollEl   = options.scrollEl || null;
      hooks = options.hooks || {};

      renderComposer();
      updateComposerState();

      // 画面を裏にしている間は取得を止める
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          syncPolling(!global.document.hidden);
        });
      }
    },

    /** 表示するアプリを切り替える */
    show: function (appId) {
      currentAppId = appId;
      listError = '';
      showPostError('');

      var input = document.getElementById('commentInput');
      if (input) {
        input.value = '';
        input.style.height = 'auto';
      }
      updateComposerState();
      renderList(true);
      syncPolling(true);
    },

    /** チャットタブを表示しているかどうか */
    setActive: function (active) {
      isActive = !!active;
      syncPolling(true);
    },

    /** ログイン状態が変わったとき */
    onAuthChange: function () {
      if (!isLoggedIn()) {
        cache = {};
        counts = {};
        loadedOnce = {};
        listError = '';
        showPostError('');
        stopPolling();
      }
      updateComposerState();
      renderList(true);
      syncPolling(true);
      if (hooks.onCountsChanged) { hooks.onCountsChanged(); }
    },

    refresh: function () { return fetchComments(); }
  };

  global.AppShareUtil = Util;
  global.AppShareChat = Chat;
})(window);
