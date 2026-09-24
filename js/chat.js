/* =========================================================
   js/chat.js
   コメント（チャット）機能
   ・アプリごとに localStorage へ保存する
   ・保存キー : app-share/comments/<アプリID>
   ・将来は Cloudflare D1 + API に置き換える想定
   ========================================================= */

(function (global) {
  'use strict';

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
     Safari のプライベートブラウズでも落ちないようにする
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

  var COMMENT_KEY_PREFIX = 'app-share/comments/';

  /* ---------------------------------------------------------
     コメントの保存・取得
     --------------------------------------------------------- */
  var CommentStore = {
    key: function (appId) {
      return COMMENT_KEY_PREFIX + appId;
    },

    /** 指定アプリのコメント一覧（古い順） */
    list: function (appId) {
      var items = Storage.read(this.key(appId), []);
      return Array.isArray(items) ? items : [];
    },

    count: function (appId) {
      return this.list(appId).length;
    },

    /**
     * コメントを追加する
     * status は今回すべて既定値（未対応）。将来ここを切り替えられるようにする。
     */
    add: function (appId, author, text) {
      var comment = {
        id: 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        appId: appId,
        author: author,
        text: text,
        createdAt: new Date().toISOString(),
        status: global.AppShareData.defaultCommentStatus
      };
      var items = this.list(appId);
      items.push(comment);
      var saved = Storage.write(this.key(appId), items);
      return saved ? comment : null;
    },

    /**
     * 対応状態を変更する（構造の準備のみ。今回の画面からは呼び出していない）
     * 使用例: AppShareChat.store.setStatus('shift', 'c-...', 'done')
     */
    setStatus: function (appId, commentId, status) {
      if (!global.AppShareData.commentStatus[status]) { return false; }
      var items = this.list(appId);
      var changed = false;
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === commentId) {
          items[i].status = status;
          changed = true;
          break;
        }
      }
      return changed ? Storage.write(this.key(appId), items) : false;
    }
  };

  /* ---------------------------------------------------------
     表示名の保存・取得
     --------------------------------------------------------- */
  var USER_KEY = 'app-share/user-name';

  var UserName = {
    get: function () {
      var name = Storage.read(USER_KEY, '');
      return typeof name === 'string' ? name : '';
    },
    set: function (name) {
      return Storage.write(USER_KEY, String(name || '').trim());
    }
  };

  /* ---------------------------------------------------------
     コメント欄の描画
     --------------------------------------------------------- */

  var els = {};          // listEl / composerEl
  var currentAppId = null;
  var hooks = {};        // getUserName / requireUserName / onPosted

  function statusBadge(status) {
    var labels = global.AppShareData.commentStatus;
    var label = labels[status] || labels.open;
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
            '<time class="comment__time">' + Util.escapeHtml(Util.formatDateTime(comment.createdAt)) + '</time>' +
            statusBadge(comment.status) +
          '</div>' +
          '<p class="comment__text">' + Util.escapeHtml(comment.text) + '</p>' +
        '</div>' +
      '</article>';
  }

  function emptyHtml() {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon"><svg viewBox="0 0 24 24"><path d="M4 5.5h16v10.5H9.5L5.5 19.5V16H4z"/></svg></div>' +
        '<p class="empty__text">まだコメントはありません。気づいた点を書き込んでください。</p>' +
      '</div>';
  }

  function renderList() {
    var comments = CommentStore.list(currentAppId);
    var body = comments.length
      ? '<div class="comment-list">' + comments.map(commentHtml).join('') + '</div>'
      : emptyHtml();

    els.listEl.innerHTML = '' +
      '<div class="comments__head">' +
        '<h2 class="section-title">コメント</h2>' +
        '<span class="comments__count">' + comments.length + '件</span>' +
      '</div>' + body;
  }

  function renderComposer() {
    els.composerEl.innerHTML = '' +
      '<div class="composer__box" id="composerBox">' +
        '<textarea class="composer__input" id="commentInput" rows="1" ' +
          'placeholder="このアプリについてのコメントを入力" aria-label="コメント本文"></textarea>' +
        '<button class="button composer__send" id="commentSend" type="button" disabled>送信</button>' +
      '</div>' +
      '<p class="composer__hint">コメントはこの端末に保存されます（Command + Enter でも送信できます）。</p>';

    var box = document.getElementById('composerBox');
    var input = document.getElementById('commentInput');
    var send = document.getElementById('commentSend');

    function autoResize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }

    function updateSendState() {
      send.disabled = input.value.trim() === '';
    }

    input.addEventListener('input', function () {
      autoResize();
      updateSendState();
    });
    input.addEventListener('focus', function () { box.classList.add('is-focus'); });
    input.addEventListener('blur', function () { box.classList.remove('is-focus'); });
    input.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    send.addEventListener('click', submit);

    function submit() {
      var text = input.value.trim();
      if (!text) { return; }

      var author = hooks.getUserName ? hooks.getUserName() : '';
      if (!author) {
        if (hooks.requireUserName) { hooks.requireUserName(); }
        return;
      }

      var comment = CommentStore.add(currentAppId, author, text);
      if (!comment) {
        if (hooks.onError) { hooks.onError('コメントを保存できませんでした。ブラウザの設定をご確認ください。'); }
        return;
      }

      input.value = '';
      autoResize();
      updateSendState();
      renderList();
      if (hooks.onPosted) { hooks.onPosted(currentAppId); }
    }
  }

  /* ---------------------------------------------------------
     公開する処理
     --------------------------------------------------------- */
  var Chat = {
    util: Util,
    store: CommentStore,
    userName: UserName,

    /** 初期化（app.js から1回だけ呼ぶ） */
    init: function (options) {
      els.listEl = options.listEl;
      els.composerEl = options.composerEl;
      hooks = options.hooks || {};
      renderComposer();
    },

    /** 表示するアプリを切り替える */
    show: function (appId) {
      currentAppId = appId;
      renderList();
      var input = document.getElementById('commentInput');
      if (input) {
        input.value = '';
        input.style.height = 'auto';
        var send = document.getElementById('commentSend');
        if (send) { send.disabled = true; }
      }
    },

    /** 再描画（外部から状態を変えたとき用） */
    refresh: function () {
      if (currentAppId) { renderList(); }
    }
  };

  global.AppShareUtil = Util;
  global.AppShareChat = Chat;
})(window);
