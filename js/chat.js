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

  var editingId    = null;    // 編集中のコメント
  var editingDraft = '';      // 編集中の本文（再描画で消えないよう保持する）
  var deletingId   = null;    // 削除の確認を表示しているコメント
  var openReadsId  = null;    // 確認者一覧を開いているコメント
  var readsCache   = {};      // commentId -> 確認した職員名の配列
  var busyId       = null;    // 通信中のコメント
  var actionError  = null;    // { id: コメントID, message: 文言 }

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

  /** 確認した職員の人数表示。押すと氏名の一覧を開閉する */
  function readsButtonHtml(comment) {
    var count = comment.confirm_count || 0;
    var open  = openReadsId === comment.id;
    return '<button class="comment__reads' + (open ? ' is-open' : '') + '" type="button" ' +
             'data-action="reads" data-id="' + Util.escapeHtml(comment.id) + '" ' +
             'aria-expanded="' + (open ? 'true' : 'false') + '">' +
             '確認済み ' + count + '人' +
           '</button>';
  }

  /** 確認した職員の氏名 */
  function readersHtml(comment) {
    if (openReadsId !== comment.id) { return ''; }

    var names = readsCache[comment.id];
    if (!names) {
      return '<div class="comment__readers"><span class="comment__readers-note">読み込んでいます…</span></div>';
    }
    if (!names.length) {
      return '<div class="comment__readers"><span class="comment__readers-note">まだ誰も確認していません</span></div>';
    }
    return '<ul class="comment__readers">' + names.map(function (name) {
      return '<li class="comment__reader">' + Util.escapeHtml(name) + '</li>';
    }).join('') + '</ul>';
  }

  function actionsHtml(comment) {
    var id = Util.escapeHtml(comment.id);
    var busy = busyId === comment.id;
    var buttons = '';

    if (comment.is_mine) {
      // 自分の投稿 … 編集と削除
      if (deletingId === comment.id) {
        buttons =
          '<span class="comment__confirm-text">このコメントを削除しますか？</span>' +
          '<button class="comment__action comment__action--danger" type="button" ' +
                  'data-action="delete-yes" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>' +
            (busy ? '削除中…' : '削除する') + '</button>' +
          '<button class="comment__action" type="button" data-action="delete-no" data-id="' + id + '">キャンセル</button>';
      } else {
        buttons =
          '<button class="comment__action" type="button" data-action="edit" data-id="' + id + '">編集</button>' +
          '<button class="comment__action" type="button" data-action="delete" data-id="' + id + '">削除</button>';
      }
    } else if (comment.confirmed_by_me) {
      // 他人の投稿で、自分が確認済み
      buttons = '<span class="comment__checked">確認済み</span>';
    } else {
      // 他人の投稿で、まだ確認していない
      buttons = '<button class="comment__action comment__action--primary" type="button" ' +
                        'data-action="confirm" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>' +
                  (busy ? '記録中…' : '確認しました') + '</button>';
    }

    return '<div class="comment__actions">' + buttons + readsButtonHtml(comment) + '</div>';
  }

  function editorHtml(comment) {
    var id = Util.escapeHtml(comment.id);
    var busy = busyId === comment.id;
    return '' +
      '<div class="comment__editor">' +
        '<textarea class="comment__editor-input" id="commentEditInput" rows="2" wrap="soft" ' +
                  'aria-label="コメントを編集">' + Util.escapeHtml(editingDraft) + '</textarea>' +
        '<div class="comment__actions">' +
          '<button class="comment__action comment__action--primary" type="button" ' +
                  'data-action="edit-save" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>' +
            (busy ? '保存中…' : '保存') + '</button>' +
          '<button class="comment__action" type="button" data-action="edit-cancel" data-id="' + id + '">キャンセル</button>' +
        '</div>' +
      '</div>';
  }

  function commentHtml(comment) {
    var edited = comment.edited_at
      ? '<span class="comment__edited">編集済み</span>' : '';

    var error = (actionError && actionError.id === comment.id)
      ? '<p class="comment__error">' + Util.escapeHtml(actionError.message) + '</p>' : '';

    var main = (editingId === comment.id)
      ? editorHtml(comment)
      : '<p class="comment__text">' + Util.escapeHtml(comment.body) + '</p>' + actionsHtml(comment);

    return '' +
      '<article class="comment' + (comment.is_mine ? ' comment--mine' : '') + '">' +
        '<div class="comment__avatar" aria-hidden="true">' + Util.escapeHtml(Util.initial(comment.author)) + '</div>' +
        '<div class="comment__body">' +
          '<div class="comment__head">' +
            '<span class="comment__author">' + Util.escapeHtml(comment.author) + '</span>' +
            '<time class="comment__time">' + Util.escapeHtml(Util.formatDateTime(comment.created_at)) + '</time>' +
            edited +
          '</div>' +
          main +
          readersHtml(comment) +
          error +
        '</div>' +
      '</article>';
  }

  function loginPromptHtml() {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon"><svg viewBox="0 0 24 24"><path d="M6.5 10.5h11v9h-11z"/><path d="M9 10.5V8a3 3 0 016 0v2.5"/></svg></div>' +
        '<p class="empty__text">コメントを見る・投稿するにはログインしてください</p>' +
        '<button class="button" type="button" data-action="login">ログイン</button>' +
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
      editingId || '',
      deletingId || '',
      openReadsId || '',
      busyId || '',
      actionError ? actionError.id + actionError.message : '',
      rows.map(function (row) {
        return [row.id, row.edited_at || '', row.confirm_count || 0,
                row.confirmed_by_me ? 1 : 0].join(':');
      }).join(',')
    ].join('|');
  }

  function renderList(force) {
    // 編集中は、5秒ごとの再取得で入力内容が消えないように描き直さない
    if (!force && editingId) { return; }

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

    if (keepBottom && rows.length) { scrollToBottom(); }

    // 編集を開始した直後は入力欄へカーソルを移す
    if (editingId) {
      var editInput = document.getElementById('commentEditInput');
      if (editInput && document.activeElement !== editInput) {
        editInput.focus();
        editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      }
    }
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
        '<textarea class="composer__input" id="commentInput" rows="1" wrap="soft" ' +
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
  function fetchComments(force) {
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
      renderList(!!force);
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
        renderList(true);
        scrollToBottom();
      }
      if (hooks.onCountsChanged) { hooks.onCountsChanged(); }

      // 確認状況などの項目を揃えるため、取得し直す
      return fetchComments(true).then(scrollToBottom);
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
     コメントの操作（編集 / 削除 / 確認）
     本人確認はすべてSupabase側のRPCで行う。
     画面側の表示制御は補助にすぎない。
     --------------------------------------------------------- */
  function findComment(commentId) {
    var rows = currentRows();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === commentId) { return rows[i]; }
    }
    return null;
  }

  function setActionError(commentId, message) {
    actionError = message ? { id: commentId, message: message } : null;
  }

  function handleAuthLost() {
    if (hooks.onSessionExpired) { hooks.onSessionExpired(); }
  }

  /** 編集を始める */
  function startEdit(commentId) {
    var comment = findComment(commentId);
    if (!comment || !comment.is_mine) { return; }
    editingId    = commentId;
    editingDraft = comment.body || '';
    deletingId   = null;
    setActionError(null);
    renderList(true);
  }

  function cancelEdit() {
    editingId    = null;
    editingDraft = '';
    renderList(true);
  }

  /** 編集を保存する */
  function saveEdit(commentId) {
    var input = document.getElementById('commentEditInput');
    if (!input) { return; }

    var text = input.value.trim();
    if (!text) {
      setActionError(commentId, 'コメントが入力されていません。');
      editingDraft = input.value;
      renderList(true);
      return;
    }

    editingDraft = input.value;
    busyId = commentId;
    setActionError(null);
    renderList(true);

    global.AppShareSupabase.rpc('appshare_comment_update', {
      p_token: token(),
      p_comment_id: commentId,
      p_body: text
    }).then(function (rows) {
      var result = (rows && rows[0]) || { ok: false, message: '保存できませんでした' };
      if (!result.ok) {
        setActionError(commentId, result.message || '保存できませんでした。');
        return;
      }
      editingId    = null;
      editingDraft = '';
      setActionError(null);
      return fetchComments(true);
    }).catch(function (error) {
      if (isAuthError(error)) { handleAuthLost(); return; }
      setActionError(commentId, 'コメントを保存できませんでした。' + (error.message || ''));
    }).then(function () {
      busyId = null;
      renderList(true);
    });
  }

  /** 削除の確認を出す */
  function askDelete(commentId) {
    deletingId = commentId;
    editingId  = null;
    setActionError(null);
    renderList(true);
  }

  function cancelDelete() {
    deletingId = null;
    renderList(true);
  }

  /** 削除を実行する */
  function doDelete(commentId) {
    busyId = commentId;
    setActionError(null);
    renderList(true);

    global.AppShareSupabase.rpc('appshare_comment_delete', {
      p_token: token(),
      p_comment_id: commentId
    }).then(function (rows) {
      var result = (rows && rows[0]) || { ok: false, message: '削除できませんでした' };
      if (!result.ok) {
        setActionError(commentId, result.message || '削除できませんでした。');
        return;
      }
      deletingId = null;
      if (openReadsId === commentId) { openReadsId = null; }
      delete readsCache[commentId];
      return fetchComments(true);
    }).catch(function (error) {
      if (isAuthError(error)) { handleAuthLost(); return; }
      setActionError(commentId, 'コメントを削除できませんでした。' + (error.message || ''));
    }).then(function () {
      busyId = null;
      renderList(true);
    });
  }

  /** 「確認しました」を記録する */
  function doConfirm(commentId) {
    busyId = commentId;
    setActionError(null);
    renderList(true);

    global.AppShareSupabase.rpc('appshare_comment_confirm', {
      p_token: token(),
      p_comment_id: commentId
    }).then(function (rows) {
      var result = (rows && rows[0]) || { ok: false, message: '記録できませんでした' };
      if (!result.ok) {
        setActionError(commentId, result.message || '記録できませんでした。');
        return;
      }
      delete readsCache[commentId];          // 氏名の一覧を取り直す
      return fetchComments(true);
    }).catch(function (error) {
      if (isAuthError(error)) { handleAuthLost(); return; }
      setActionError(commentId, '確認を記録できませんでした。' + (error.message || ''));
    }).then(function () {
      busyId = null;
      renderList(true);
    });
  }

  /** 確認した職員の一覧を開閉する */
  function toggleReads(commentId) {
    if (openReadsId === commentId) {
      openReadsId = null;
      renderList(true);
      return;
    }

    openReadsId = commentId;
    setActionError(null);
    renderList(true);

    if (readsCache[commentId]) { return; }

    global.AppShareSupabase.rpc('appshare_comment_confirmed_list', {
      p_token: token(),
      p_comment_id: commentId
    }).then(function (rows) {
      readsCache[commentId] = (rows || []).map(function (row) { return row.staff_name; });
      if (openReadsId === commentId) { renderList(true); }
    }).catch(function (error) {
      if (isAuthError(error)) { handleAuthLost(); return; }
      readsCache[commentId] = [];
      setActionError(commentId, '確認した職員を取得できませんでした。' + (error.message || ''));
      renderList(true);
    });
  }

  /** コメント欄のボタンをまとめて受け取る */
  function handleListClick(event) {
    var button = event.target.closest('[data-action]');
    if (!button) { return; }

    var action = button.getAttribute('data-action');
    var id     = button.getAttribute('data-id');

    if (action === 'login')       { if (hooks.onRequireLogin) { hooks.onRequireLogin(); } return; }
    if (busyId) { return; }                      // 通信中は二重操作を防ぐ

    if (action === 'edit')        { startEdit(id);   return; }
    if (action === 'edit-save')   { saveEdit(id);    return; }
    if (action === 'edit-cancel') { cancelEdit();    return; }
    if (action === 'delete')      { askDelete(id);   return; }
    if (action === 'delete-yes')  { doDelete(id);    return; }
    if (action === 'delete-no')   { cancelDelete();  return; }
    if (action === 'confirm')     { doConfirm(id);   return; }
    if (action === 'reads')       { toggleReads(id); return; }
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

      // 編集・削除・確認のボタンをまとめて受け取る
      els.listEl.addEventListener('click', handleListClick);

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
      editingId = null;
      editingDraft = '';
      deletingId = null;
      openReadsId = null;
      busyId = null;
      actionError = null;
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
      editingId = null;
      editingDraft = '';
      deletingId = null;
      openReadsId = null;
      busyId = null;
      actionError = null;
      readsCache = {};

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
