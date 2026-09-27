/* =========================================================
   あぷりんく : マスコット

   画面右下に小さく表示し、状態に応じて画像を切り替える。
     idle   通常時
     wave   起動時・あいさつ
     walk   読み込み中・処理中
     cheer  保存・投稿などの成功時

   画像は assets/mascot/{state}.png に置く。
   画像が無い場合は表示しない（既存の画面には影響しない）。

   ほかの画面から呼ぶとき
     AppShareMascot.setMascot('walk')          状態を切り替える（そのまま続く）
     AppShareMascot.playMascot('cheer', 1200)  一定時間だけ表示して idle に戻る

   クリック・タップは受け付けない（下にあるボタンをふさがない）。
   ========================================================= */
(function (global) {
  'use strict';

  var STATES = ['idle', 'wave', 'walk', 'cheer'];
  var IMAGE_DIR = 'assets/mascot/';
  var VERSION = '20260927-7';          // 画像を差し替えたときもここを上げる

  var root = null;
  var img = null;
  var current = null;
  var timer = null;
  var missing = {};                    // 読み込めなかった画像

  function isState(state) {
    return STATES.indexOf(state) !== -1;
  }

  function srcOf(state) {
    return IMAGE_DIR + state + '.png?v=' + VERSION;
  }

  /** 4種類の画像を先に読み込んでおき、切り替え時のちらつきを防ぐ */
  function preload() {
    STATES.forEach(function (state) {
      var probe = new global.Image();
      probe.onerror = function () { missing[state] = true; };
      probe.src = srcOf(state);
    });
  }

  function build() {
    if (root) { return; }

    root = document.createElement('div');
    root.className = 'mascot';
    root.setAttribute('aria-hidden', 'true');
    root.hidden = true;                // 画像が読み込めるまでは出さない

    img = document.createElement('img');
    img.className = 'mascot__img';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;

    img.addEventListener('load', function () { root.hidden = false; });
    img.addEventListener('error', function () {
      missing[current] = true;
      // その状態の画像が無ければ通常時の画像にする。通常時も無ければ隠す
      if (current !== 'idle' && !missing.idle) {
        apply('idle');
      } else {
        root.hidden = true;
      }
    });

    root.appendChild(img);
    document.body.appendChild(root);

    watchComposer();
  }

  /** 画像とアニメーションを切り替える */
  function apply(state) {
    if (!root) { build(); }
    if (missing[state]) { state = 'idle'; }
    if (missing[state]) { root.hidden = true; return; }

    current = state;
    img.src = srcOf(state);

    // 同じ動きを最初からやり直せるよう、一度クラスを外してから付け直す
    STATES.forEach(function (name) { root.classList.remove('mascot--' + name); });
    void root.offsetWidth;
    root.classList.add('mascot--' + state);
  }

  /** 状態を切り替える（次に切り替えるまでそのまま） */
  function setMascot(state) {
    if (!isState(state)) { return; }
    if (timer) { global.clearTimeout(timer); timer = null; }
    apply(state);
  }

  /** 状態を一定時間だけ表示し、その後 idle に戻す */
  function playMascot(state, duration) {
    if (!isState(state)) { return; }
    setMascot(state);
    if (state === 'idle') { return; }

    timer = global.setTimeout(function () {
      timer = null;
      apply('idle');
    }, typeof duration === 'number' && duration > 0 ? duration : 1500);
  }

  /* ---------------------------------------------------------
     チャット入力欄を隠さない
     入力欄が表示されている間は、その上に表示する
     --------------------------------------------------------- */
  function watchComposer() {
    var composer = document.getElementById('composer');
    if (!composer) { return; }

    function place() {
      var visible = !composer.hidden && composer.offsetParent !== null;
      root.style.bottom = visible ? (composer.getBoundingClientRect().height + 10) + 'px' : '';
    }

    if ('ResizeObserver' in global) {
      new global.ResizeObserver(place).observe(composer);
    }
    if ('MutationObserver' in global) {
      new global.MutationObserver(place).observe(composer, { attributes: true, attributeFilter: ['hidden'] });
    }
    global.addEventListener('resize', place);
    place();
  }

  function start() {
    preload();
    build();
    // 起動時はあいさつしてから通常時へ
    playMascot('wave', 1800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.AppShareMascot = {
    setMascot: setMascot,
    playMascot: playMascot
  };
})(window);
