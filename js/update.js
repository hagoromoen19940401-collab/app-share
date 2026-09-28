/* =========================================================
   あぷりんく : 更新の確認（ホーム画面版向け）

   iPhoneのホーム画面版は、古い index.html / CSS / JS を持ち続けやすい。
   起動時と、アプリに戻ってきたとき（裏から表に出たとき）に
   version.json をキャッシュを使わずに取得し、
   今のバージョンと違えば最新版に読み込み直す。

   ・今のバージョン … このファイルを読み込んだ URL の ?v=（index.html と同じ番号）
   ・最新のバージョン … version.json の version

   更新するときは、index.html の ?v= と version.json の version を同じ番号にそろえる。

   ・同じ版への読み込み直しは一定時間に1回まで（無限リロードを防ぐ）
   ・オフライン・取得失敗のときは何もしない（そのまま使える）
   ・入力中や設定画面を開いている間は読み込み直さない（入力が消えないように）
   ========================================================= */
(function (global) {
  'use strict';

  var ATTEMPT_KEY = 'app-share/update-attempt';   // { version, at } 最後に読み込み直した版と時刻
  var RETRY_MS = 10 * 60 * 1000;                  // 同じ版への読み込み直しは10分に1回まで
  var CHECK_INTERVAL_MS = 60 * 1000;              // 確認は1分に1回まで
  var PARAM = '_update';                          // 読み込み直すときに付ける目印（表示後に消す）

  var script = document.currentScript;
  var match = script && script.src ? script.src.match(/[?&]v=([^&#]+)/) : null;
  var current = match ? decodeURIComponent(match[1]) : '';
  var lastCheck = 0;
  var checking = false;

  if (!current || !global.fetch) { return; }       // バージョンが分からない場合は何もしない

  /* 読み込み直した直後なら、URLの目印を消しておく（見た目・共有URLをきれいに保つ） */
  (function cleanUrl() {
    try {
      var url = new global.URL(global.location.href);
      if (!url.searchParams.has(PARAM)) { return; }
      url.searchParams.delete(PARAM);
      global.history.replaceState(global.history.state, '', url.pathname + url.search + url.hash);
    } catch (e) { /* 古いブラウザでは消さなくても動く */ }
  })();

  function readAttempt() {
    try { return JSON.parse(global.localStorage.getItem(ATTEMPT_KEY) || 'null'); } catch (e) { return null; }
  }

  function writeAttempt(version) {
    try {
      global.localStorage.setItem(ATTEMPT_KEY, JSON.stringify({ version: version, at: Date.now() }));
    } catch (e) { /* 保存できない場合は、読み込み直しもしない（下の判定で止まる） */ }
  }

  /** 入力中・設定などを開いている間は読み込み直さない */
  function isBusy() {
    var active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) { return true; }

    var input = document.getElementById('commentInput');
    if (input && input.value) { return true; }

    var preview = document.getElementById('composerPreview');
    if (preview && !preview.hidden) { return true; }            // 写真を選んでいる

    var modals = document.querySelectorAll('.modal');
    for (var i = 0; i < modals.length; i += 1) {
      if (!modals[i].hidden) { return true; }
    }
    return false;
  }

  function reloadTo(version) {
    var attempt = readAttempt();
    // 同じ版に最近読み込み直したばかりなら、もう一度はしない（無限リロード防止）
    if (attempt && attempt.version === version && Date.now() - attempt.at < RETRY_MS) { return; }

    writeAttempt(version);
    // 保存できなかった場合は、何度も読み込み直さないよう中止する
    var saved = readAttempt();
    if (!saved || saved.version !== version) { return; }

    try {
      // URL を変えて読み込むことで、端末に残った古い index.html を使わせない
      var url = new global.URL(global.location.href);
      url.searchParams.set(PARAM, version);
      global.location.replace(url.toString());
    } catch (e) {
      global.location.reload();
    }
  }

  function check() {
    if (checking) { return; }
    if (global.navigator && global.navigator.onLine === false) { return; }   // オフラインでは確認しない
    if (Date.now() - lastCheck < CHECK_INTERVAL_MS) { return; }

    checking = true;
    lastCheck = Date.now();

    global.fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        var latest = data && typeof data.version === 'string' ? data.version : '';
        if (!latest || latest === current) { return; }
        if (isBusy()) { lastCheck = 0; return; }      // 手が空いたときに改めて確認する
        reloadTo(latest);
      })
      .catch(function () { /* 通信できない場合は、そのまま使う */ })
      .then(function () { checking = false; });
  }

  // 起動時
  if (document.readyState === 'complete') {
    check();
  } else {
    global.addEventListener('load', check);
  }

  // ホーム画面版は閉じても裏で動き続けるため、表に戻ってきたときにも確認する
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { check(); }
  });
  global.addEventListener('pageshow', function (event) {
    if (event.persisted) { check(); }
  });
})(window);
