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

  // 写真の縮小・圧縮の目安
  var IMAGE_MAX_EDGE  = 1600;        // 長辺
  var IMAGE_QUALITY   = 0.8;
  var IMAGE_MAX_BYTES = 3 * 1024 * 1024;
  var IMAGE_MAX_COUNT = 4;           // 1投稿につき4枚まで
  var URL_MARGIN_MS   = 60 * 1000;   // 署名URLは期限の1分前に取り直す

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

  var pendingImages = [];     // 送信前に選んでいる写真（最大4枚）
  var imageUrls     = {};     // 画像パス -> { url, expiresAt }
  var imageLoading  = {};     // 取得中の画像パス
  var lightboxList  = [];     // 拡大表示中のコメントの写真パス
  var lightboxIndex = 0;      // 何枚目を見ているか

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
     写真の縮小・圧縮
     元画像は送らず、長辺1600px・JPEG・品質0.8を目安に小さくする。
     3MBを超える場合は品質と大きさを少しずつ下げる。
     --------------------------------------------------------- */
  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var objectUrl = global.URL.createObjectURL(file);
      var image = new global.Image();

      image.onload = function () {
        global.URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = function () {
        global.URL.revokeObjectURL(objectUrl);
        reject(new Error('写真を読み込めませんでした'));
      };
      image.src = objectUrl;
    });
  }

  function drawToBlob(image, maxEdge, quality) {
    return new Promise(function (resolve, reject) {
      var width  = image.naturalWidth  || image.width;
      var height = image.naturalHeight || image.height;
      if (!width || !height) { reject(new Error('写真を読み込めませんでした')); return; }

      var scale = Math.min(1, maxEdge / Math.max(width, height));
      var canvas = document.createElement('canvas');
      canvas.width  = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      var context = canvas.getContext('2d');
      if (!context) { reject(new Error('写真を処理できませんでした')); return; }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(function (blob) {
        if (blob) { resolve(blob); } else { reject(new Error('写真を処理できませんでした')); }
      }, 'image/jpeg', quality);
    });
  }

  function compressImage(file) {
    // 3MB以下になるまで、品質と大きさを段階的に下げる
    var steps = [
      { edge: IMAGE_MAX_EDGE, quality: IMAGE_QUALITY },
      { edge: IMAGE_MAX_EDGE, quality: 0.7 },
      { edge: 1280,           quality: 0.7 },
      { edge: 1280,           quality: 0.6 },
      { edge: 1000,           quality: 0.6 },
      { edge: 800,            quality: 0.5 }
    ];

    return loadImageElement(file).then(function (image) {
      var index = 0;

      function attempt() {
        if (index >= steps.length) {
          throw new Error('写真を処理できませんでした');
        }
        var step = steps[index++];
        return drawToBlob(image, step.edge, step.quality).then(function (blob) {
          if (blob.size <= IMAGE_MAX_BYTES) { return blob; }
          return attempt();
        });
      }

      return attempt();
    });
  }

  /* ---------------------------------------------------------
     署名つきURLの管理
     10分で切れるため、期限の1分前で取り直す。
     一度取得したURLは短時間だけ覚えておき、
     5秒ごとの再取得では取り直さない。
     --------------------------------------------------------- */
  function cachedUrl(path) {
    var entry = imageUrls[path];
    if (!entry) { return null; }
    if (entry.expiresAt - URL_MARGIN_MS <= Date.now()) { return null; }
    return entry.url;
  }

  function fetchImageUrl(path) {
    if (imageLoading[path]) { return imageLoading[path]; }

    var request = global.AppShareSupabase.imageViewUrl(token(), path)
      .then(function (result) {
        var seconds = result.expires_in || 600;
        imageUrls[path] = {
          url: result.url,
          expiresAt: Date.now() + seconds * 1000
        };
        delete imageLoading[path];
        return result.url;
      })
      .catch(function (error) {
        delete imageLoading[path];
        throw error;
      });

    imageLoading[path] = request;
    return request;
  }

  /** 表示用のURLを返す（キャッシュがあればそれを使う） */
  function imageUrl(path) {
    var cached = cachedUrl(path);
    if (cached) { return Promise.resolve(cached); }
    return fetchImageUrl(path);
  }

  /** 画面にある <img data-path> へURLを流し込む */
  function hydrateImages(root) {
    if (!root || !root.querySelectorAll) { return; }

    var images = root.querySelectorAll('img[data-path]');
    Array.prototype.forEach.call(images, function (element) {
      var path = element.getAttribute('data-path');
      if (!path || element.getAttribute('data-loaded') === path) { return; }

      imageUrl(path).then(function (url) {
        element.setAttribute('data-loaded', path);
        element.src = url;
      }).catch(function () {
        element.setAttribute('data-failed', '1');
      });
    });
  }

  /** 画像の読み込みに失敗したら、URLを取り直して1回だけやり直す */
  function handleImageError(event) {
    var element = event.target;
    if (!element || element.tagName !== 'IMG') { return; }

    var path = element.getAttribute('data-path');
    if (!path || element.getAttribute('data-retried') === '1') { return; }

    element.setAttribute('data-retried', '1');
    delete imageUrls[path];

    fetchImageUrl(path).then(function (url) {
      element.src = url;
    }).catch(function () { /* 表示できないままにする */ });
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

  /**
   * コメントに紐づく写真のパス一覧。
   * 新しい images 配列を優先し、無ければ旧 image_path を使う
   * （以前の1枚写真コメントもそのまま表示できる）
   */
  function imagePathsOf(comment) {
    var list = comment.images;

    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (e) { list = null; }
    }

    if (list && list.length) {
      return list.map(function (item) {
        return typeof item === 'string' ? item : item.path;
      }).filter(Boolean);
    }

    return comment.image_path ? [comment.image_path] : [];
  }

  /** 添付された写真（1枚なら大きめ、2枚以上は2列） */
  function imageHtml(comment) {
    var paths = imagePathsOf(comment);
    if (!paths.length) { return ''; }

    var id = Util.escapeHtml(comment.id);
    var single = paths.length === 1;

    var items = paths.map(function (path, index) {
      return '' +
        '<button class="comment__image-button" type="button" ' +
                'data-action="image" data-id="' + id + '" data-index="' + index + '" ' +
                'aria-label="写真を大きく表示（' + (index + 1) + '枚目）">' +
          '<img class="comment__image" data-path="' + Util.escapeHtml(path) + '" ' +
               'alt="添付された写真 ' + (index + 1) + '枚目">' +
        '</button>';
    }).join('');

    return '<div class="comment__images' + (single ? ' comment__images--single' : ' comment__images--grid') +
           '">' + items + '</div>';
  }

  function actionsHtml(comment) {
    var id = Util.escapeHtml(comment.id);
    var busy = busyId === comment.id;
    var buttons = '';
    // 写真だけの投稿は本文がないため「編集」を出さない
    var canEdit = !!(comment.body && comment.body.length);

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
          (canEdit
            ? '<button class="comment__action" type="button" data-action="edit" data-id="' + id + '">編集</button>'
            : '') +
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

    var text = (comment.body && comment.body.length)
      ? '<p class="comment__text">' + Util.escapeHtml(comment.body) + '</p>'
      : '';

    var main = (editingId === comment.id)
      ? editorHtml(comment)
      : text + imageHtml(comment) + actionsHtml(comment);

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
                row.confirmed_by_me ? 1 : 0, imagePathsOf(row).join('+')].join(':');
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

    hydrateImages(els.listEl);

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
  var ICON_PHOTO = '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v13H4z"/><path d="M4 15l4.5-4 4 3.5 3-2.5L20 16"/><path d="M9 9.8v.2"/></svg>';

  function renderComposer() {
    els.composerEl.innerHTML = '' +
      '<div class="composer__error inline-notice inline-notice--tight" id="composerError" hidden>' +
        '<span class="inline-notice__icon" aria-hidden="true">' + ICON_ALERT + '</span>' +
        '<span id="composerErrorText"></span>' +
      '</div>' +

      '<div class="composer__preview" id="composerPreview" hidden>' +
        '<div class="composer__preview-head">' +
          '<span class="composer__preview-title" id="composerPreviewTitle"></span>' +
          '<button class="comment__action" type="button" id="photoRemoveAll">すべて取り消す</button>' +
        '</div>' +
        '<div class="composer__preview-list" id="composerPreviewList"></div>' +
      '</div>' +

      '<div class="composer__box" id="composerBox">' +
        '<button class="composer__photo" id="photoButton" type="button" aria-label="写真を追加">' +
          ICON_PHOTO +
        '</button>' +
        '<textarea class="composer__input" id="commentInput" rows="1" wrap="soft" ' +
          'placeholder="このアプリについてのコメントを入力" aria-label="コメント本文"></textarea>' +
        '<button class="button composer__send" id="commentSend" type="button" disabled>送信</button>' +
      '</div>' +

      '<input class="composer__file" id="photoInput" type="file" accept="image/*" multiple ' +
             'aria-label="写真を選ぶ">' +

      '<p class="composer__hint" id="composerHint">コメントは職員全員に共有されます（Command + Enter でも送信できます）。</p>';

    var box   = document.getElementById('composerBox');
    var input = document.getElementById('commentInput');
    var send  = document.getElementById('commentSend');

    // --- 写真を選ぶ ---
    var photoButton = document.getElementById('photoButton');
    var photoInput  = document.getElementById('photoInput');

    photoButton.addEventListener('click', function () {
      if (!isLoggedIn() || isPosting) { return; }
      photoInput.click();
    });

    photoInput.addEventListener('change', function () {
      var files = photoInput.files ? Array.prototype.slice.call(photoInput.files) : [];
      photoInput.value = '';                        // 同じ写真を選び直せるようにする
      if (files.length) { choosePhotos(files); }
    });

    document.getElementById('photoRemoveAll').addEventListener('click', clearPendingImages);

    // 1枚ずつ取り消す
    document.getElementById('composerPreview').addEventListener('click', function (event) {
      var button = event.target.closest('[data-remove-index]');
      if (!button) { return; }
      removePendingImage(parseInt(button.getAttribute('data-remove-index'), 10));
    });

    function autoResize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }

    function updateSendState() {
      var hasContent = input.value.trim() !== '' || pendingImages.length > 0;
      send.disabled = isPosting || !isLoggedIn() || !hasContent;
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

  /** 送信前の写真を表示に反映する（1枚なら大きめ、2枚以上は2列） */
  function renderPendingImages() {
    var box   = document.getElementById('composerPreview');
    var title = document.getElementById('composerPreviewTitle');
    var list  = document.getElementById('composerPreviewList');
    if (!box || !list) { return; }

    if (!pendingImages.length) {
      box.hidden = true;
      list.innerHTML = '';
      return;
    }

    var total = pendingImages.reduce(function (sum, item) { return sum + item.size; }, 0);
    title.textContent = '写真 ' + pendingImages.length + '枚（' + IMAGE_MAX_COUNT + '枚まで）　' +
                        Math.round(total / 1024) + ' KB に圧縮しました';

    list.className = 'composer__preview-list' +
                     (pendingImages.length === 1 ? ' composer__preview-list--single' : '');

    list.innerHTML = pendingImages.map(function (item, index) {
      return '' +
        '<div class="composer__preview-item">' +
          '<img class="composer__preview-image" src="' + item.previewUrl + '" ' +
               'alt="選択した写真 ' + (index + 1) + '枚目">' +
          '<button class="composer__preview-remove" type="button" ' +
                  'data-remove-index="' + index + '" aria-label="この写真を取り消す">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>' +
          '</button>' +
        '</div>';
    }).join('');

    box.hidden = false;
  }

  function clearPendingImages() {
    pendingImages.forEach(function (item) {
      if (item.previewUrl) { global.URL.revokeObjectURL(item.previewUrl); }
    });
    pendingImages = [];
    renderPendingImages();
    updateComposerState();
  }

  /** 1枚だけ取り消す。残りの順番は自動で詰まる */
  function removePendingImage(index) {
    if (isPosting) { return; }
    var item = pendingImages[index];
    if (!item) { return; }

    if (item.previewUrl) { global.URL.revokeObjectURL(item.previewUrl); }
    pendingImages.splice(index, 1);
    showPostError('');
    renderPendingImages();
    updateComposerState();
  }

  /** 写真を選んだときの処理（1枚ずつ縮小・圧縮してからプレビュー） */
  function choosePhotos(files) {
    if (!isLoggedIn()) {
      if (hooks.onRequireLogin) { hooks.onRequireLogin(); }
      return;
    }

    var images = files.filter(function (file) {
      return /^image\//.test(file.type || '');
    });

    if (!images.length) {
      showPostError('画像ファイルを選んでください。');
      return;
    }

    var room = IMAGE_MAX_COUNT - pendingImages.length;
    if (room <= 0) {
      showPostError('写真は1回の投稿につき' + IMAGE_MAX_COUNT + '枚までです');
      return;
    }

    // 入りきらない分は追加せず、その旨を伝える
    var overflow = images.length > room;
    var targets = images.slice(0, room);

    showPostError(overflow ? '写真は1回の投稿につき' + IMAGE_MAX_COUNT + '枚までです' : '');

    var photoButton = document.getElementById('photoButton');
    if (photoButton) { photoButton.disabled = true; }

    var failed = 0;

    // 1枚ずつ順番に圧縮する（同時に走らせて端末が重くならないようにする）
    targets.reduce(function (chain, file) {
      return chain.then(function () {
        return compressImage(file).then(function (blob) {
          if (pendingImages.length >= IMAGE_MAX_COUNT) { return; }
          pendingImages.push({
            blob: blob,
            size: blob.size,
            previewUrl: global.URL.createObjectURL(blob)
          });
        }).catch(function () {
          failed += 1;
        });
      });
    }, Promise.resolve()).then(function () {
      if (failed > 0 && !overflow) {
        showPostError(failed === targets.length
          ? '写真を処理できませんでした'
          : failed + '枚の写真を処理できませんでした');
      }
      renderPendingImages();
      updateComposerState();      // 4枚に達していれば、ここで写真ボタンが無効になる
    });
  }

  function updateComposerState() {
    var input = document.getElementById('commentInput');
    var send  = document.getElementById('commentSend');
    var hint  = document.getElementById('composerHint');
    if (!input || !send) { return; }

    var loggedIn = isLoggedIn();
    var photoButton = document.getElementById('photoButton');
    if (photoButton) {
      photoButton.disabled = !loggedIn || isPosting || pendingImages.length >= IMAGE_MAX_COUNT;
      photoButton.title = pendingImages.length >= IMAGE_MAX_COUNT
        ? '写真は' + IMAGE_MAX_COUNT + '枚までです'
        : '写真を追加';
    }

    input.disabled = !loggedIn || isPosting;
    input.placeholder = loggedIn
      ? 'このアプリについてのコメントを入力'
      : 'ログインするとコメントを投稿できます';
    var hasContent = input.value.trim() !== '' || pendingImages.length > 0;
    send.disabled = isPosting || !loggedIn || !hasContent;
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
    if (!input || isPosting) { return; }

    var text = input.value.trim();
    var hasImage = pendingImages.length > 0;

    // 文章も写真もない場合は送信しない
    if (!text && !hasImage) { return; }

    if (!isLoggedIn()) {
      showPostError('コメントを投稿するにはログインしてください。');
      if (hooks.onRequireLogin) { hooks.onRequireLogin(); }
      return;
    }

    var appId = currentAppId;
    isPosting = true;
    showPostError('');
    updateComposerState();

    // 写真があるときは Edge Function 経由。ないときは従来どおりRPC。
    // どちらも投稿者名・staff_id・日時はサーバー側で決まる。
    var posting = hasImage
      ? global.AppShareSupabase.imageUpload(token(), appId, text,
          pendingImages.map(function (item) { return item.blob; }))   // 選んだ順に 0,1,2,3 で保存される
      : global.AppShareSupabase.rpc('appshare_comment_add', {
          p_token:  token(),
          p_app_id: appId,
          p_body:   text
        });

    posting.then(function (result) {
      // 他の職員へ通知する（投稿の成否には影響させない）
      // 文章だけ: RPCの行の配列 / 写真つき: { ok, comment }
      var added = Array.isArray(result) ? result[0] : (result && result.comment);
      if (added && added.id && global.AppSharePush) { global.AppSharePush.notify(added.id); }

      input.value = '';
      if (els.composerEl.autoResize) { els.composerEl.autoResize(); }
      clearPendingImages();
      listError = '';

      // 確認状況などの項目を揃えるため、取得し直す
      return fetchComments(true).then(scrollToBottom);
    }).catch(function (error) {
      if (isAuthError(error)) {
        showPostError('ログインの有効期限が切れました。もう一度ログインしてください。');
        if (hooks.onSessionExpired) { hooks.onSessionExpired(); }
        return;
      }
      // 失敗した投稿は端末内に保存しない。入力中の文章と写真はそのまま残す。
      // 本文と選択中の写真はそのまま残す
      showPostError((hasImage ? '写真を送信できませんでした。' : 'コメントを送信できませんでした。') +
                    (error.message || ''));
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

      // 写真つきだった場合は、紐づく写真をすべてStorageから削除する
      var paths = (result.image_paths && result.image_paths.length)
        ? result.image_paths
        : (result.image_path ? [result.image_path] : []);

      var removal = Promise.resolve();
      if (paths.length) {
        paths.forEach(function (path) { delete imageUrls[path]; });
        removal = global.AppShareSupabase.imageDelete(token(), paths)
          .catch(function (error) {
            // コメントは消えているので戻さない。記録と表示だけ行う。
            if (global.console && global.console.warn) {
              global.console.warn('写真を削除できませんでした', paths, error);
            }
            if (hooks.onError) {
              hooks.onError('コメントは削除しましたが、写真の削除に失敗しました。');
            }
          });
      }

      return removal.then(function () { return fetchComments(true); });
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

  /* ---------------------------------------------------------
     写真の拡大表示
     --------------------------------------------------------- */
  function renderLightbox() {
    if (!els.lightboxEl) { return; }

    if (!lightboxList.length) {
      els.lightboxEl.hidden = true;
      els.lightboxEl.innerHTML = '';
      return;
    }

    var path = lightboxList[lightboxIndex];
    var many = lightboxList.length > 1;

    // 複数枚のときだけ、前へ / 次へ と 枚数表示を出す
    var nav = many
      ? '<div class="lightbox__nav">' +
          '<button class="lightbox__arrow" type="button" data-image-prev aria-label="前の写真">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5l-6 6.5 6 6.5"/></svg>' +
          '</button>' +
          '<span class="lightbox__count">' + (lightboxIndex + 1) + ' / ' + lightboxList.length + '</span>' +
          '<button class="lightbox__arrow" type="button" data-image-next aria-label="次の写真">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5l6 6.5-6 6.5"/></svg>' +
          '</button>' +
        '</div>'
      : '';

    els.lightboxEl.innerHTML = '' +
      '<div class="lightbox__scrim" data-close-image></div>' +
      '<div class="lightbox__panel" role="dialog" aria-modal="true" aria-label="写真">' +
        '<button class="icon-button lightbox__close" type="button" data-close-image aria-label="閉じる">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>' +
        '</button>' +
        '<img class="lightbox__image" id="lightboxImage" ' +
             'data-path="' + Util.escapeHtml(path) + '" alt="添付された写真">' +
        nav +
      '</div>';

    els.lightboxEl.hidden = false;
    hydrateImages(els.lightboxEl);
  }

  function openLightbox(paths, index) {
    if (!paths || !paths.length) { return; }
    lightboxList = paths;
    lightboxIndex = Math.min(Math.max(index || 0, 0), paths.length - 1);
    renderLightbox();
  }

  function stepLightbox(step) {
    if (lightboxList.length < 2) { return; }
    lightboxIndex = (lightboxIndex + step + lightboxList.length) % lightboxList.length;
    renderLightbox();
  }

  function closeLightbox() {
    if (!lightboxList.length) { return; }
    lightboxList = [];
    lightboxIndex = 0;
    renderLightbox();
  }

  /** コメント欄のボタンをまとめて受け取る */
  function handleListClick(event) {
    var button = event.target.closest('[data-action]');
    if (!button) { return; }

    var action = button.getAttribute('data-action');
    var id     = button.getAttribute('data-id');

    if (action === 'login')       { if (hooks.onRequireLogin) { hooks.onRequireLogin(); } return; }
    if (action === 'image') {
      var owner = findComment(button.getAttribute('data-id'));
      if (owner) {
        openLightbox(imagePathsOf(owner), parseInt(button.getAttribute('data-index'), 10) || 0);
      }
      return;
    }
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
      els.lightboxEl = options.lightboxEl || null;
      hooks = options.hooks || {};

      renderComposer();
      updateComposerState();

      // 編集・削除・確認・写真のボタンをまとめて受け取る
      els.listEl.addEventListener('click', handleListClick);

      // 署名URLが切れていた場合は取り直す
      els.listEl.addEventListener('error', handleImageError, true);

      if (els.lightboxEl) {
        els.lightboxEl.addEventListener('click', function (event) {
          if (event.target.closest('[data-image-prev]')) { stepLightbox(-1); return; }
          if (event.target.closest('[data-image-next]')) { stepLightbox(1);  return; }
          if (event.target.closest('[data-close-image]')) { closeLightbox(); }
        });
        els.lightboxEl.addEventListener('error', handleImageError, true);

        // 左右スワイプで前後の写真へ
        var touchX = null;
        els.lightboxEl.addEventListener('touchstart', function (event) {
          touchX = event.touches && event.touches[0] ? event.touches[0].clientX : null;
        }, { passive: true });

        els.lightboxEl.addEventListener('touchend', function (event) {
          if (touchX === null) { return; }
          var endX = event.changedTouches && event.changedTouches[0]
            ? event.changedTouches[0].clientX : touchX;
          var moved = endX - touchX;
          touchX = null;
          if (Math.abs(moved) > 50) { stepLightbox(moved < 0 ? 1 : -1); }
        }, { passive: true });
      }

      global.addEventListener('keydown', function (event) {
        if (!lightboxList.length) { return; }
        if (event.key === 'Escape')     { closeLightbox(); return; }
        if (event.key === 'ArrowLeft')  { stepLightbox(-1); return; }
        if (event.key === 'ArrowRight') { stepLightbox(1); }
      });

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
      closeLightbox();
      clearPendingImages();
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
      closeLightbox();
      clearPendingImages();
      imageUrls = {};
      imageLoading = {};
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
