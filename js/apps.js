/* =========================================================
   js/apps.js
   アプリ一覧（左側）と アプリの画面（右側）の描画
   右側は「概要 / ファイル / チャット」の3タブ構成
   ========================================================= */

(function (global) {
  'use strict';

  var Util = global.AppShareUtil;
  var Data = global.AppShareData;

  /* ---------------------------------------------------------
     線画アイコン（絵文字は使わない）
     --------------------------------------------------------- */
  var ICONS = {
    calendar:  '<path d="M4 6.5h16v13H4z"/><path d="M4 10.5h16"/><path d="M8.5 4v4M15.5 4v4"/>',
    note:      '<path d="M6 3.5h9l4 4v13H6z"/><path d="M15 3.5v4h4"/><path d="M9 12h7M9 15.5h5"/>',
    clipboard: '<path d="M8.5 5.5H6v15h12v-15h-2.5"/><path d="M9 3.5h6v3H9z"/><path d="M9.5 12h5M9.5 15.5h3"/>',
    route:     '<path d="M6.5 19.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/><path d="M17.5 9.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/><path d="M9 17h4.5a3.5 3.5 0 000-7h-3a3.5 3.5 0 010-7H15"/>',
    drop:      '<path d="M12 3.5s5.5 5.6 5.5 9.4a5.5 5.5 0 01-11 0C6.5 9.1 12 3.5 12 3.5z"/><path d="M9.5 13.5a2.5 2.5 0 002.5 2.5"/>',
    external:  '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18 14v5.5H4.5V6H10"/>',
    alert:     '<path d="M12 4.5l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
    info:      '<path d="M12 20.5a8.5 8.5 0 100-17 8.5 8.5 0 000 17z"/><path d="M12 11v5.5"/><path d="M12 7.6v.2"/>',
    folder:    '<path d="M3.5 6.5h6l2 2.5h9v9.5h-17z"/>',
    chevron:   '<path d="M9.5 5.5l6 6.5-6 6.5"/>',
    file:      '<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14.5 3.5v4h4"/>',
    archive:   '<path d="M4 7.5h16v12H4z"/><path d="M3 4.5h18v3H3z"/><path d="M10 11.5h4"/>',
    image:     '<path d="M4 5.5h16v13H4z"/><path d="M4 15l4.5-4 4 3.5 3-2.5L20 16"/><path d="M9 9.8v.2"/>',
    book:      '<path d="M4.5 4.5h6a3 3 0 013 3v12a2.5 2.5 0 00-2.5-2.5h-6.5z"/><path d="M19.5 4.5h-6a3 3 0 00-3 3v12a2.5 2.5 0 012.5-2.5h6.5z"/>'
  };

  function icon(name, className) {
    var path = ICONS[name] || ICONS.note;
    return '<span class="' + className + '" aria-hidden="true"><svg viewBox="0 0 24 24">' + path + '</svg></span>';
  }

  /** ファイル区分ごとのアイコン */
  var FILE_ICONS = {
    latest: 'file',
    archive: 'archive',
    pdf: 'file',
    image: 'image',
    document: 'book'
  };

  /* ---------------------------------------------------------
     タブの定義
     --------------------------------------------------------- */
  var TABS = [
    { id: 'overview', label: '概要' },
    { id: 'files',    label: 'ファイル' },
    { id: 'chat',     label: 'チャット' }
  ];

  /* ---------------------------------------------------------
     アプリ検索
     --------------------------------------------------------- */
  function findApp(appId) {
    var list = allApps();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === appId) { return list[i]; }
    }
    return null;
  }

  /* ---------------------------------------------------------
     状態
     --------------------------------------------------------- */
  var els = {};          // listEl / countEl / workbarEl / detailEl / filesEl
  var onSelect = null;
  var onOpenApp = null;
  var onTabChange = null;
  var onRequireLogin = null;
  var currentAppId = null;
  var currentTab = 'overview';
  var remoteApps = [];   // Supabaseに登録されたアプリ
  var loggedIn = false;

  /** Supabaseの1行を、画面で使う形に合わせる */
  function toApp(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      version: '',
      updatedAt: String(row.created_at || '').slice(0, 10),
      changelog: [],
      status: 'running',
      path: row.url,
      icon: 'external',
      isRemote: true
    };
  }

  /** 既存の5アプリ + 登録されたアプリ */
  function allApps() {
    return Data.apps.concat(remoteApps);
  }

  /* ---------------------------------------------------------
     左側：アプリ一覧（共有フォルダの一覧として見せる）
     --------------------------------------------------------- */
  function appItemHtml(app) {
    var count = global.AppShareChat.countFor(app.id);
    var active = app.id === currentAppId;

    var meta = app.isRemote
      ? '登録 ' + Util.escapeHtml(Util.formatDate(app.updatedAt))
      : 'Ver ' + Util.escapeHtml(app.version) +
        '<span class="app-item__dot"></span>' + Util.escapeHtml(Data.appStatusLabels[app.status] || '');

    return '' +
      '<button class="app-item' + (active ? ' is-active' : '') + '" type="button" ' +
          'data-app-id="' + Util.escapeHtml(app.id) + '"' + (active ? ' aria-current="true"' : '') + '>' +
        '<span class="app-item__tile" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24">' + (ICONS[app.icon] || ICONS.note) + '</svg>' +
        '</span>' +
        '<span class="app-item__body">' +
          '<span class="app-item__name">' + Util.escapeHtml(app.name) + '</span>' +
          '<span class="app-item__meta">' + meta + '</span>' +
        '</span>' +
        (count ? '<span class="app-item__count">' + count + '</span>' : '') +
      '</button>';
  }

  function renderList() {
    if (!loggedIn) {
      els.listEl.innerHTML = '' +
        '<div class="sidebar-empty">' +
          '<p class="sidebar-empty__text">ログインするとアプリ一覧が表示されます</p>' +
          '<button class="button button--ghost sidebar-empty__button" type="button" data-login>ログイン</button>' +
        '</div>';
      if (els.countEl) { els.countEl.textContent = ''; }
      return;
    }

    els.listEl.innerHTML = allApps().map(appItemHtml).join('');
    if (els.countEl) { els.countEl.textContent = allApps().length; }
  }

  /* ---------------------------------------------------------
     右側の上部：現在のアプリ名とタブ
     --------------------------------------------------------- */
  function renderWorkbar(app) {
    var commentCount = global.AppShareChat.countFor(app.id);

    var tabs = TABS.map(function (tab) {
      var active = tab.id === currentTab;
      var badge = (tab.id === 'chat' && commentCount)
        ? '<span class="tab__count">' + commentCount + '</span>' : '';
      return '' +
        '<button class="tab' + (active ? ' is-active' : '') + '" type="button" role="tab" ' +
            'data-tab-id="' + tab.id + '" aria-selected="' + (active ? 'true' : 'false') + '">' +
          '<span>' + Util.escapeHtml(tab.label) + '</span>' + badge +
        '</button>';
    }).join('');

    els.workbarEl.innerHTML = '' +
      '<div class="workbar__crumbs">' +
        icon('folder', 'workbar__crumb-icon') +
        '<span class="workbar__crumb">共有フォルダ</span>' +
        icon('chevron', 'workbar__sep') +
        '<span class="workbar__current">' + Util.escapeHtml(app.name) + '</span>' +
      '</div>' +
      '<div class="workbar__tabs" role="tablist">' + tabs + '</div>';
  }

  /* ---------------------------------------------------------
     概要タブ
     --------------------------------------------------------- */
  function renderDetail(app) {
    var statusLabel = Data.appStatusLabels[app.status] || '';
    var changelog = (app.changelog || []).map(function (line) {
      return '<li class="changelog__item">' + Util.escapeHtml(line) + '</li>';
    }).join('');

    var meta = app.isRemote
      ? '<span class="detail__meta-item">登録日 ' + Util.escapeHtml(Util.formatDate(app.updatedAt)) + '</span>' +
        '<span class="badge badge--running">登録済み</span>'
      : '<span class="detail__meta-item">Version ' + Util.escapeHtml(app.version) + '</span>' +
        '<span class="detail__meta-item">最終更新 ' + Util.escapeHtml(Util.formatDate(app.updatedAt)) + '</span>' +
        '<span class="badge badge--' + Util.escapeHtml(app.status) + '">' + Util.escapeHtml(statusLabel) + '</span>';

    var hint = app.isRemote
      ? '<span class="detail__hint detail__url">' + Util.escapeHtml(app.path) + '</span>'
      : '<span class="detail__hint">最新版が別タブで開きます</span>';

    var description = app.description
      ? '<p class="detail__description">' + Util.escapeHtml(app.description) + '</p>'
      : (app.isRemote ? '<p class="detail__description detail__description--weak">説明は登録されていません。</p>' : '');

    var section = app.isRemote
      ? ''
      : '<div class="detail__section">' +
          '<h2 class="section-title">今回の更新内容</h2>' +
          (changelog
            ? '<ul class="changelog">' + changelog + '</ul>'
            : '<p class="detail__description">更新内容は登録されていません。</p>') +
        '</div>';

    els.detailEl.innerHTML = '' +
      '<div class="detail__head">' +
        icon(app.icon, 'detail__icon') +
        '<div class="detail__heading">' +
          '<h1 class="detail__name">' + Util.escapeHtml(app.name) + '</h1>' +
          '<div class="detail__meta">' + meta + '</div>' +
        '</div>' +
      '</div>' +

      description +

      '<div class="detail__actions">' +
        '<button class="button" type="button" id="openAppButton">' +
          icon('external', 'button__icon') +
          '<span>アプリを開く</span>' +
        '</button>' +
        hint +
      '</div>' +

      '<div class="inline-notice" id="openNotice" hidden>' +
        icon('alert', 'inline-notice__icon') +
        '<span id="openNoticeText"></span>' +
      '</div>' +

      section;

    var openButton = document.getElementById('openAppButton');
    if (openButton) {
      openButton.addEventListener('click', function () {
        if (onOpenApp) { onOpenApp(app); }
      });
    }
  }

  /* ---------------------------------------------------------
     ファイルタブ
     今回は「置き場所の枠」だけを表示する（登録機能はまだ作らない）
     --------------------------------------------------------- */
  function fileRowHtml(app, category) {
    var registered = (app.files || []).filter(function (file) {
      return file.category === category.id;
    });

    var isLatest = category.id === 'latest';
    var meta;

    if (registered.length) {
      // 将来ファイルが登録されたときの表示
      meta = registered.map(function (file) {
        return Util.escapeHtml(file.label || file.id);
      }).join('　');
    } else if (isLatest) {
      meta = 'Version ' + Util.escapeHtml(app.version) +
             '<span class="file-row__dot"></span>更新日 ' + Util.escapeHtml(Util.formatDate(app.updatedAt));
    } else {
      meta = Util.escapeHtml(category.hint);
    }

    var state = registered.length
      ? '<span class="badge badge--running">' + registered.length + '件</span>'
      : '<span class="badge">ファイル未登録</span>';

    return '' +
      '<li class="file-row' + (isLatest ? ' file-row--primary' : '') + '">' +
        icon(FILE_ICONS[category.id] || 'file', 'file-row__icon') +
        '<span class="file-row__body">' +
          '<span class="file-row__label">' + Util.escapeHtml(category.label) + '</span>' +
          '<span class="file-row__meta">' + meta + '</span>' +
        '</span>' +
        state +
      '</li>';
  }

  function renderFiles(app) {
    var rows = Data.fileCategories.map(function (category) {
      return fileRowHtml(app, category);
    }).join('');

    els.filesEl.innerHTML = '' +
      '<div class="panel__head">' +
        '<h2 class="section-title">ファイル</h2>' +
        '<span class="panel__note">' + Util.escapeHtml(app.name) + ' の共有ファイル置き場</span>' +
      '</div>' +
      '<ul class="file-list">' + rows + '</ul>' +
      '<div class="inline-notice inline-notice--quiet">' +
        icon('info', 'inline-notice__icon') +
        '<span>ファイルの登録はまだ行えません。最新版・過去バージョン・PDF・画像・説明資料を置けるようにする予定です。</span>' +
      '</div>';
  }

  /* ---------------------------------------------------------
     公開する処理
     --------------------------------------------------------- */
  var Apps = {
    icon: icon,
    find: findApp,
    tabs: TABS,

    init: function (options) {
      els.listEl     = options.listEl;
      els.countEl    = options.countEl;
      els.workbarEl  = options.workbarEl;
      els.detailEl   = options.detailEl;
      els.filesEl    = options.filesEl;
      onSelect       = options.onSelect;
      onOpenApp      = options.onOpenApp;
      onTabChange    = options.onTabChange;
      onRequireLogin = options.onRequireLogin;

      if (options.initialTab) { currentTab = options.initialTab; }

      els.listEl.addEventListener('click', function (event) {
        if (event.target.closest('[data-login]')) {
          if (onRequireLogin) { onRequireLogin(); }
          return;
        }
        var button = event.target.closest('.app-item');
        if (!button) { return; }
        var appId = button.getAttribute('data-app-id');
        if (appId && appId !== currentAppId && onSelect) { onSelect(appId); }
      });

      els.workbarEl.addEventListener('click', function (event) {
        var button = event.target.closest('.tab');
        if (!button) { return; }
        var tabId = button.getAttribute('data-tab-id');
        if (tabId && tabId !== currentTab) { Apps.setTab(tabId); }
      });

      renderList();
    },

    /** アプリを選択して右側を切り替える（ページ遷移はしない） */
    select: function (appId) {
      var app = findApp(appId);
      if (!app) { return null; }
      currentAppId = appId;
      renderList();
      renderWorkbar(app);
      renderDetail(app);
      renderFiles(app);
      return app;
    },

    /** タブを切り替える（アプリの選択はそのまま） */
    setTab: function (tabId) {
      var app = findApp(currentAppId);
      if (!app) { return; }
      currentTab = tabId;
      renderWorkbar(app);
      if (onTabChange) { onTabChange(tabId); }
    },

    getTab: function () { return currentTab; },

    /** コメント数の表示だけ更新する */
    refreshCounts: function () {
      renderList();
      var app = findApp(currentAppId);
      if (app) { renderWorkbar(app); }
    },

    /** 「アプリを開く」を押したときの画面内メッセージ */
    showOpenNotice: function (message) {
      var notice = document.getElementById('openNotice');
      var text = document.getElementById('openNoticeText');
      if (!notice || !text) { return; }
      text.textContent = message;
      notice.hidden = false;
    },

    getCurrentId: function () { return currentAppId; },

    /** ログイン状態を伝える。未ログインならアプリ一覧を出さない */
    setLoggedIn: function (value) {
      loggedIn = !!value;
      if (!loggedIn) {
        remoteApps = [];
        currentAppId = null;
      }
      renderList();
    },

    /** Supabaseから取得した登録アプリを反映する */
    setRemoteApps: function (rows) {
      remoteApps = (rows || []).map(toApp);
      renderList();
    },

    /** 既存5アプリ + 登録アプリ */
    list: allApps
  };

  global.AppShareApps = Apps;
})(window);
