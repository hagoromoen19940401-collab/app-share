/* =========================================================
   js/app.js
   画面全体の組み立て（起動処理・表示名・通知・サイドバー開閉）
   ========================================================= */

(function (global) {
  'use strict';

  var Data = global.AppShareData;
  var Apps = global.AppShareApps;
  var Chat = global.AppShareChat;
  var Auth = global.AppShareAuth;

  var SELECTED_KEY = 'app-share/selected-app';
  var TAB_KEY = 'app-share/selected-tab';

  var dom = {};

  /* ---------------------------------------------------------
     トースト通知（alert の代わり）
     --------------------------------------------------------- */
  function showToast(message, iconName) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML =
      Apps.icon(iconName || 'info', 'toast__icon') +
      '<span></span>';
    toast.lastChild.textContent = message;

    dom.toastArea.appendChild(toast);
    global.requestAnimationFrame(function () {
      toast.classList.add('is-visible');
    });

    global.setTimeout(function () {
      toast.classList.remove('is-visible');
      global.setTimeout(function () {
        if (toast.parentNode) { toast.parentNode.removeChild(toast); }
      }, 250);
    }, 3200);
  }

  /* ---------------------------------------------------------
     登録されたアプリの読み込み（ログイン中のみ）
     --------------------------------------------------------- */
  function loadRemoteApps() {
    var session = Auth.getSession();
    if (!session) { return Promise.resolve(); }

    return global.AppShareSupabase.appsList(session.token).then(function (rows) {
      Apps.setRemoteApps(rows);
      var selected = Apps.getCurrentId();
      if (selected) { Apps.select(selected); }
    }).catch(function (error) {
      showToast('アプリ一覧を取得できませんでした。' + error.message, 'alert');
    });
  }

  /* ---------------------------------------------------------
     ログイン状態の反映
     コメントの投稿者名は、ログイン中の職員名がSupabase側で使われる
     --------------------------------------------------------- */
  function applySession(session) {
    if (session) {
      dom.sessionName.textContent = session.displayName;
      dom.headerSession.hidden = false;
      dom.loginButton.hidden = true;
    } else {
      dom.headerSession.hidden = true;
      dom.loginButton.hidden = false;
    }

    Apps.setLoggedIn(!!session);
    Chat.onAuthChange();

    if (session) {
      dom.loginPrompt.hidden = true;
      dom.workbar.hidden = false;
      dom.mainScroll.hidden = false;
      showTab(Apps.getTab());

      var first = restoreSelectedApp();
      if (first) { selectApp(first); }
      loadRemoteApps();
    } else {
      // 未ログインではアプリの中身を見せない
      dom.loginPrompt.hidden = false;
      dom.workbar.hidden = true;
      dom.mainScroll.hidden = true;
      dom.composer.hidden = true;
      document.title = 'あぷりんく';
    }
  }

  /* ---------------------------------------------------------
     サイドバー（狭い画面のみ開閉）
     --------------------------------------------------------- */
  function setSidebar(open) {
    dom.sidebar.classList.toggle('is-open', open);
    dom.scrim.hidden = !open;
    dom.navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    dom.navToggle.setAttribute('aria-label', open ? 'アプリ一覧を閉じる' : 'アプリ一覧を開く');
  }

  function initSidebar() {
    dom.navToggle.addEventListener('click', function () {
      setSidebar(!dom.sidebar.classList.contains('is-open'));
    });
    dom.scrim.addEventListener('click', function () { setSidebar(false); });
    global.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { setSidebar(false); }
    });
  }

  /* ---------------------------------------------------------
     タブの切り替え（ページ遷移はしない）
     --------------------------------------------------------- */
  function showTab(tabId) {
    Apps.tabs.forEach(function (tab) {
      dom.panels[tab.id].hidden = (tab.id !== tabId);
    });

    // 入力欄はチャットタブのときだけ表示する
    dom.composer.hidden = (tabId !== 'chat');
    dom.mainScroll.scrollTop = 0;

    // チャットタブを見ている間だけ再取得する
    Chat.setActive(tabId === 'chat');

    try { global.localStorage.setItem(TAB_KEY, tabId); } catch (e) { /* 保存できなくても動作する */ }
  }

  function restoreTab() {
    var saved = null;
    try { saved = global.localStorage.getItem(TAB_KEY); } catch (e) { saved = null; }
    var valid = Apps.tabs.some(function (tab) { return tab.id === saved; });
    return valid ? saved : 'overview';
  }

  /* ---------------------------------------------------------
     アプリの選択
     --------------------------------------------------------- */
  function selectApp(appId) {
    var app = Apps.select(appId);
    if (!app) { return; }

    Chat.show(appId);
    dom.mainScroll.scrollTop = 0;
    setSidebar(false);

    try { global.localStorage.setItem(SELECTED_KEY, appId); } catch (e) { /* 保存できなくても動作する */ }
    document.title = app.name + ' / あぷりんく';
  }

  function restoreSelectedApp() {
    var saved = null;
    try { saved = global.localStorage.getItem(SELECTED_KEY); } catch (e) { saved = null; }
    if (saved && Apps.find(saved)) { return saved; }
    return Data.apps.length ? Data.apps[0].id : null;
  }

  /* ---------------------------------------------------------
     「アプリを開く」
     今回は本体を登録していないため、画面内に案内を表示する
     --------------------------------------------------------- */
  function openApp(app) {
    if (!app.path) {
      var message = 'このアプリはまだ登録されていません';
      Apps.showOpenNotice(message + '（アプリ本体の登録後に開けるようになります）。');
      showToast(message, 'alert');
      return;
    }
    global.open(app.path, '_blank', 'noopener');
  }

  /* ---------------------------------------------------------
     起動
     --------------------------------------------------------- */
  function init() {
    dom.headerSession = document.getElementById('headerSession');
    dom.sessionName   = document.getElementById('sessionName');
    dom.loginButton   = document.getElementById('loginButton');
    dom.sidebar    = document.getElementById('sidebar');
    dom.scrim      = document.getElementById('scrim');
    dom.navToggle  = document.getElementById('navToggle');
    dom.mainScroll = document.getElementById('mainScroll');
    dom.toastArea  = document.getElementById('toastArea');
    dom.composer    = document.getElementById('composer');
    dom.workbar     = document.getElementById('workbar');
    dom.loginPrompt = document.getElementById('loginPrompt');
    dom.loginPrompt.addEventListener('click', function (event) {
      if (event.target.closest('[data-open-login]')) { Auth.open(); }
    });
    dom.panels     = {
      overview: document.getElementById('panelOverview'),
      files:    document.getElementById('panelFiles'),
      chat:     document.getElementById('panelChat')
    };

    var initialTab = restoreTab();

    Apps.init({
      listEl: document.getElementById('appList'),
      countEl: document.getElementById('appCount'),
      workbarEl: document.getElementById('workbar'),
      detailEl: document.getElementById('appDetail'),
      filesEl: document.getElementById('appFiles'),
      initialTab: initialTab,
      onSelect: selectApp,
      onOpenApp: openApp,
      onTabChange: showTab,
      onRequireLogin: function () { Auth.open(); }
    });

    Chat.init({
      listEl: document.getElementById('commentSection'),
      composerEl: document.getElementById('composer'),
      scrollEl: dom.mainScroll,
      lightboxEl: document.getElementById('imageLightbox'),
      hooks: {
        isLoggedIn: function () { return Auth.isLoggedIn(); },
        getToken: function () {
          var session = Auth.getSession();
          return session ? session.token : '';
        },
        onRequireLogin: function () { Auth.open(); },
        onCountsChanged: function () { Apps.refreshCounts(); },
        onSessionExpired: function () {
          Auth.logout();
          showToast('ログインの有効期限が切れました。もう一度ログインしてください。', 'alert');
        }
      }
    });

    initSidebar();

    // 職員ログイン
    Auth.init({
      modalEl: document.getElementById('loginModal'),
      bodyEl: document.getElementById('loginBody'),
      openButton: dom.loginButton,
      logoutButton: document.getElementById('logoutButton'),
      onChange: function (session) {
        applySession(session);
        showToast(session ? session.displayName + ' さんでログインしました。' : 'ログアウトしました。',
                  session ? 'info' : 'info');
      },
      onOpenSettings: function () { global.AppShareSettings.open(); }
    });

    // 保存されているログイン状態を復元する（期限切れなら未ログインに戻る）
    // アプリの選択とタブの表示も、この中で行う
    applySession(Auth.getSession());

    // 設定（職員管理）
    global.AppShareSettings.init({
      modalEl: document.getElementById('settingsModal'),
      bodyEl: document.getElementById('settingsBody'),
      openButton: document.getElementById('settingsButton'),
      hooks: {
        isLoggedIn: function () { return Auth.isLoggedIn(); },
        getToken: function () {
          var session = Auth.getSession();
          return session ? session.token : '';
        },
        onRequireLogin: function () { Auth.open(); },
        getDisplayName: function () { return Auth.currentName(); },
        onAppsChanged: loadRemoteApps          // 登録したらすぐ左の一覧に反映する
      }
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
