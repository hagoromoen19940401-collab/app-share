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

     AppShareMascot.resetPosition()            保存した位置を消して右下に戻す

   マスコットはドラッグ（マウス・指）で好きな位置に動かせる。
   位置は端末内（localStorage）に、画面の右下からの距離で保存する。
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

  var POSITION_KEY = 'app-share/mascot-position';
  var EDGE = 4;                        // 画面の端（セーフエリアの内側）からの最小の余白
  var DRAG_START = 6;                  // この距離（px）以上動いたらドラッグとみなす

  var saved = null;                    // 保存した位置 { right, bottom }（未保存なら null）
  var composerOffset = 0;              // チャット入力欄が出ているときの高さ＋余白
  var insetProbe = null;

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

    img.addEventListener('load', function () {
      root.hidden = false;
      layout();                        // 大きさが決まってから、画面内に収まる位置に直す
    });
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

    saved = readPosition();
    bindDrag();
    watchComposer();
    global.addEventListener('resize', layout);
    global.addEventListener('orientationchange', layout);
    layout();
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
      composerOffset = visible ? composer.getBoundingClientRect().height + 10 : 0;
      layout();
    }

    if ('ResizeObserver' in global) {
      new global.ResizeObserver(place).observe(composer);
    }
    if ('MutationObserver' in global) {
      new global.MutationObserver(place).observe(composer, { attributes: true, attributeFilter: ['hidden'] });
    }
    place();
  }

  /* ---------------------------------------------------------
     位置の保存・復元
     画面サイズが変わっても扱いやすいよう、右下からの距離（px）で持つ
     --------------------------------------------------------- */
  function readPosition() {
    try {
      var value = JSON.parse(global.localStorage.getItem(POSITION_KEY) || 'null');
      if (value && isFinite(value.right) && isFinite(value.bottom)) {
        return { right: Number(value.right), bottom: Number(value.bottom) };
      }
    } catch (e) { /* 読めなければ初期位置 */ }
    return null;
  }

  function writePosition(value) {
    try {
      if (value) {
        global.localStorage.setItem(POSITION_KEY, JSON.stringify({
          right: Math.round(value.right), bottom: Math.round(value.bottom)
        }));
      } else {
        global.localStorage.removeItem(POSITION_KEY);
      }
    } catch (e) { /* 保存できなくても、その場では動かせる */ }
  }

  /** セーフエリア（ノッチ・ホームバー）の幅を px で取得する */
  function insets() {
    if (!insetProbe) {
      insetProbe = document.createElement('div');
      insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top) env(safe-area-inset-right) ' +
        'env(safe-area-inset-bottom) env(safe-area-inset-left);';
      document.body.appendChild(insetProbe);
    }
    var style = global.getComputedStyle(insetProbe);
    return {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0
    };
  }

  /** マスコット全体が画面（セーフエリアの内側）に収まる位置に直す */
  function clamp(pos) {
    var box = root.getBoundingClientRect();
    var w = box.width || root.offsetWidth;
    var h = box.height || root.offsetHeight;
    var safe = insets();
    var vw = global.innerWidth;
    var vh = global.innerHeight;

    var minRight = safe.right + EDGE;
    var maxRight = Math.max(minRight, vw - w - safe.left - EDGE);
    var minBottom = safe.bottom + EDGE;
    var maxBottom = Math.max(minBottom, vh - h - safe.top - EDGE);

    return {
      right: Math.min(Math.max(pos.right, minRight), maxRight),
      bottom: Math.min(Math.max(pos.bottom, minBottom), maxBottom)
    };
  }

  /**
   * 表示位置を決める。
   * ・保存位置があればそれを優先（画面外に出ないよう調整）
   * ・ただしチャット入力欄が出ている間は、入力欄に重ならない高さまで上げる
   * ・保存位置がなければ、これまでどおり右下（CSSの初期位置）
   */
  function layout() {
    if (!root || root.classList.contains('is-dragging')) { return; }

    if (!saved) {
      root.style.right = '';
      root.style.bottom = composerOffset ? composerOffset + 'px' : '';
      return;
    }

    var pos = clamp(saved);
    if (composerOffset && pos.bottom < composerOffset) {
      pos = clamp({ right: pos.right, bottom: composerOffset });
    }
    root.style.right = pos.right + 'px';
    root.style.bottom = pos.bottom + 'px';
  }

  /* ---------------------------------------------------------
     ドラッグ（Pointer Events でマウスと指を共通に扱う）
     マスコットの上で押し始めた場合だけ動かす
     --------------------------------------------------------- */
  function bindDrag() {
    var drag = null;

    function currentPos() {
      var box = root.getBoundingClientRect();
      return { right: global.innerWidth - box.right, bottom: global.innerHeight - box.bottom };
    }

    /* --- マウス・指で共通の処理（開始・移動・終了） --- */
    /** 動かし始めの位置。指定済みの位置があればそれを使う（アニメーション途中の位置を拾わない） */
    function startPos() {
      var right = parseFloat(root.style.right);
      var bottom = parseFloat(root.style.bottom);
      if (isFinite(right) && isFinite(bottom)) { return { right: right, bottom: bottom }; }
      return currentPos();
    }

    function begin(id, x, y) {
      drag = { id: id, x: x, y: y, start: startPos(), moved: false, last: null };
    }

    /** 動かしたら true（ドラッグ中）を返す */
    function move(id, x, y) {
      if (!drag || id !== drag.id) { return false; }
      var dx = x - drag.x;
      var dy = y - drag.y;

      // 少し動いただけ（タップ・手ぶれ）では動かさない
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_START && Math.abs(dy) < DRAG_START) { return false; }
        drag.moved = true;
        root.classList.add('is-dragging');
      }

      var pos = clamp({ right: drag.start.right - dx, bottom: drag.start.bottom - dy });
      drag.last = pos;
      root.style.right = pos.right + 'px';
      root.style.bottom = pos.bottom + 'px';
      return true;
    }

    function end(id) {
      if (!drag || id !== drag.id) { return; }
      var moved = drag.moved;
      var last = drag.last;
      drag = null;
      if (!moved) { return; }

      root.classList.remove('is-dragging');
      // 画面から読み直さず、最後に動かした位置を保存する（アニメーション途中の位置を拾わない）
      saved = last || clamp(currentPos());
      writePosition(saved);
      layout();
    }

    /* --- 指（iPhone / iPad）：タッチイベントで扱う ---
       iOS Safari では Pointer Events と setPointerCapture の組み合わせが
       安定しないことがあるため、指の操作はタッチイベントに任せる。
       マスコットの上で触り始めたときだけ反応し、ほかの場所のスクロールには影響しない。 */
    root.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) { return; }           // 2本指（拡大など）は無視
      var t = event.changedTouches[0];
      begin('touch-' + t.identifier, t.clientX, t.clientY);
    }, { passive: true });

    root.addEventListener('touchmove', function (event) {
      if (!drag) { return; }
      for (var i = 0; i < event.changedTouches.length; i += 1) {
        var t = event.changedTouches[i];
        // ドラッグしている間だけ、画面のスクロールを止める
        if (move('touch-' + t.identifier, t.clientX, t.clientY)) { event.preventDefault(); }
      }
    }, { passive: false });

    function touchEnd(event) {
      for (var i = 0; i < event.changedTouches.length; i += 1) {
        end('touch-' + event.changedTouches[i].identifier);
      }
    }
    root.addEventListener('touchend', touchEnd);
    root.addEventListener('touchcancel', touchEnd);

    /* --- マウス・ペン：Pointer Events で扱う（指はタッチイベント側で処理済み） --- */
    root.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'touch') { return; }
      if (event.pointerType === 'mouse' && event.button !== 0) { return; }
      begin('pointer-' + event.pointerId, event.clientX, event.clientY);
      try { root.setPointerCapture(event.pointerId); } catch (e) { /* 取れなくても動く */ }
    });

    root.addEventListener('pointermove', function (event) {
      if (event.pointerType === 'touch') { return; }
      if (move('pointer-' + event.pointerId, event.clientX, event.clientY)) { event.preventDefault(); }
    });

    function pointerEnd(event) {
      if (event.pointerType === 'touch') { return; }
      try { root.releasePointerCapture(event.pointerId); } catch (e) { /* すでに外れていてもよい */ }
      end('pointer-' + event.pointerId);
    }
    root.addEventListener('pointerup', pointerEnd);
    root.addEventListener('pointercancel', pointerEnd);

    // 画像そのもののドラッグ（ブラウザ標準）は止める
    root.addEventListener('dragstart', function (event) { event.preventDefault(); });
  }

  /** 保存した位置を消して、右下の初期位置に戻す */
  function resetPosition() {
    saved = null;
    writePosition(null);
    layout();
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
    playMascot: playMascot,
    resetPosition: resetPosition
  };
})(window);
