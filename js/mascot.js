/* =========================================================
   あぷりんく : マスコット

   画面右下に小さく表示し、状態に応じて画像を切り替える。
     idle   通常時
     wave   起動時・あいさつ
     walk   読み込み中・処理中
     cheer  保存・投稿などの成功時

   画像は assets/mascot/{state}.png に置く。
   通常時（idle）は idle / sit / bike / victory / tired.png からランダムに1枚出す。
   画像が無い場合は表示しない（既存の画面には影響しない）。

   ほかの画面から呼ぶとき
     AppShareMascot.setMascot('walk')          状態を切り替える（そのまま続く）
     AppShareMascot.playMascot('cheer', 1200)  一定時間だけ表示して idle に戻る

     AppShareMascot.resetPosition()            保存した位置を消して右下に戻す
     AppShareMascot.say('送ったで！', 1500)      吹き出しを表示する（時間を省くと次に消すまで表示）
     AppShareMascot.setVisible(false)          表示しない（端末ごとに保存。位置は消さない）
     AppShareMascot.isVisible()                表示する設定かどうか
     AppShareMascot.getScale()                 いまの大きさ（1 が標準）
     AppShareMascot.resetScale()               大きさを標準に戻す

   マスコットの大きさは、iPhone / iPad では2本指のピンチ、
   PC ではマウスホイール（トラックパッド）で変えられる。0.7〜1.6倍。端末内に保存する。

   マスコットはドラッグ（マウス・指）で好きな位置に動かせる。
   位置は端末内（localStorage）に、画面の右下からの距離で保存する。
   ========================================================= */
(function (global) {
  'use strict';

  var STATES = ['idle', 'wave', 'walk', 'cheer'];
  // 通常時（idle）の画像の候補。ここからランダムに1枚出す（直前と同じものは続けて出さない）
  var IDLE_IMAGES = ['idle', 'sit', 'bike', 'victory', 'tired'];
  var IMAGE_DIR = 'assets/mascot/';
  var VERSION = '20260927-7';          // 画像を差し替えたときもここを上げる

  var root = null;
  var img = null;
  var current = null;
  var currentImage = null;             // いま表示している画像の名前（idle のときは候補のどれか）
  var lastIdleImage = null;            // 直前に出した通常時の画像
  var timer = null;
  var missing = {};                    // 読み込めなかった画像（画像の名前ごと）

  var POSITION_KEY = 'app-share/mascot-position';
  var VISIBLE_KEY = 'app-share/mascot-visible';     // '0' のときだけ表示しない（初期値は表示する）
  var visible = true;                                // build() で保存値を読み込む
  var EDGE = 4;                        // 画面の端（セーフエリアの内側）からの最小の余白
  var DRAG_START = 6;                  // この距離（px）以上動いたらドラッグとみなす
  var TAP_MAX_MS = 500;                // これより長く押していたら長押し（タップにしない）
  // タップしたときのセリフ（ランダムに1つ。直前と同じものは続けて出さない）
  var TAP_MESSAGES = [
    '今日もおつかれさま！',
    '無理せんといこな',
    'ぼちぼちいこ！',
    'ええ感じやで！',
    '今日もがんばってるな！',
    'ちょっと休憩する？',
    '水分とった？',
    'いつでも呼んでな！',
    '今日もよろしく！',
    'おつかれ〜！',
    '調子どう？',
    'がんばりすぎ注意やで',
    'えらいえらい！',
    'よし、いこか！',
    'なんか手伝おか？',
    'おっとろしゃ〜',
    'わやだな',
    'また嫁に怒られた、、、',
    'わしにも休みをくれ、、、'
  ];
  var lastTapMessage = -1;

  var SCALE_KEY = 'app-share/mascot-scale';
  var SCALE_MIN = 0.7;
  var SCALE_MAX = 1.6;
  var scale = 1;                       // build() で保存値を読み込む

  var saved = null;                    // 保存した位置 { right, bottom }（未保存なら null）
  var composerOffset = 0;              // チャット入力欄が出ているときの高さ＋余白
  var insetProbe = null;

  var bubble = null;                   // 吹き出し
  var bubbleText = null;
  var bubbleTimer = null;

  function isState(state) {
    return STATES.indexOf(state) !== -1;
  }

  function srcOf(state) {
    return IMAGE_DIR + state + '.png?v=' + VERSION;
  }

  /** 画像を先に読み込んでおき、切り替え時のちらつきを防ぐ */
  function preload() {
    STATES.concat(IDLE_IMAGES).forEach(function (name) {
      var probe = new global.Image();
      probe.onerror = function () { missing[name] = true; };
      probe.src = srcOf(name);
    });
  }

  /** 通常時の画像をランダムに選ぶ（読み込めない画像と、できるだけ直前の画像は避ける） */
  function pickIdleImage() {
    var list = IDLE_IMAGES.filter(function (name) { return !missing[name]; });
    if (list.length > 1) {
      list = list.filter(function (name) { return name !== lastIdleImage; });
    }
    if (!list.length) { return null; }
    lastIdleImage = list[Math.floor(Math.random() * list.length)];
    return lastIdleImage;
  }

  function hasIdleImage() {
    return IDLE_IMAGES.some(function (name) { return !missing[name]; });
  }

  function build() {
    if (root) { return; }

    visible = readVisible();
    root = document.createElement('div');
    root.className = 'mascot' + (visible ? '' : ' is-off');
    root.setAttribute('aria-hidden', 'true');
    root.hidden = true;                // 画像が読み込めるまでは出さない
    scale = readScale();
    root.style.setProperty('--mascot-scale', scale);

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
      missing[currentImage] = true;
      // その画像が無ければ通常時の（ほかの）画像にする。通常時の候補が全部無ければ隠す
      if (hasIdleImage()) {
        apply('idle');
      } else {
        root.hidden = true;
      }
    });

    root.appendChild(img);

    bubble = document.createElement('div');
    bubble.className = 'mascot__bubble';
    bubbleText = document.createElement('span');
    bubble.appendChild(bubbleText);
    root.appendChild(bubble);

    // 位置の調整（0.2秒のアニメーション）が終わったら、吹き出しの位置も合わせ直す
    root.addEventListener('transitionend', function (event) {
      if (event.target === root) { positionBubble(); }
    });
    document.body.appendChild(root);

    saved = readPosition();
    bindDrag();
    bindWheel();
    watchComposer();
    global.addEventListener('resize', layout);
    global.addEventListener('orientationchange', layout);
    layout();
  }

  /** 画像とアニメーションを切り替える */
  function apply(state) {
    if (!root) { build(); }
    if (state !== 'idle' && missing[state]) { state = 'idle'; }

    // 通常時は候補からランダムに1枚選ぶ
    var name = state === 'idle' ? pickIdleImage() : state;
    if (!name) { root.hidden = true; return; }

    current = state;
    currentImage = name;
    if (state === 'idle') { hideBubble(); }
    img.src = srcOf(name);

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
      positionBubble();
      return;
    }

    var pos = clamp(saved);
    if (composerOffset && pos.bottom < composerOffset) {
      pos = clamp({ right: pos.right, bottom: composerOffset });
    }
    root.style.right = pos.right + 'px';
    root.style.bottom = pos.bottom + 'px';
    positionBubble();
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
      drag = { id: id, x: x, y: y, start: startPos(), moved: false, last: null, time: Date.now() };
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
      positionBubble();
      return true;
    }

    /**
     * 指・マウスを離したとき。
     * ・6px以上動いていた → ドラッグの終了（位置を保存）
     * ・ほとんど動かず、短く押しただけ → タップ（リアクション）
     * ・キャンセル（スクロールなどでブラウザに取られた）・長押し → 何もしない
     */
    function end(id, canceled) {
      if (!drag || id !== drag.id) { return; }
      var moved = drag.moved;
      var last = drag.last;
      var held = Date.now() - drag.time;
      drag = null;

      if (!moved) {
        if (!canceled && held < TAP_MAX_MS) { react(); }
        return;
      }

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
      if (event.touches.length !== 1) { return; }           // 2本指はピンチ側で扱う
      var t = event.changedTouches[0];
      begin('touch-' + t.identifier, t.clientX, t.clientY);
    }, { passive: true });

    /* --- 2本指のピンチで拡大縮小 ---
       マスコットに1本目の指が触れている間に2本目が触れたら（2本目は画面のどこでもよい）、
       ドラッグをやめてピンチにする。指の間隔の変化に合わせて大きさを変える。 */
    var pinch = null;

    function spread(touches) {
      return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }

    document.addEventListener('touchstart', function (event) {
      if (!visible || pinch || event.touches.length !== 2) { return; }
      var onMascot = drag && String(drag.id).indexOf('touch-') === 0;
      if (!onMascot && !root.contains(event.target)) { return; }

      // ドラッグ中に2本目が来たら、そこまで動かした位置は保存しておく
      if (drag && drag.moved) {
        root.classList.remove('is-dragging');
        saved = drag.last || clamp(currentPos());
        writePosition(saved);
      }
      drag = null;
      var distance = spread(event.touches);
      if (distance > 0) { pinch = { distance: distance, scale: scale }; }
    }, { passive: true });

    document.addEventListener('touchmove', function (event) {
      if (!pinch) { return; }
      event.preventDefault();                               // 画面全体の拡大・スクロールを止める
      if (event.touches.length < 2) { return; }
      setScale(pinch.scale * spread(event.touches) / pinch.distance, false);
    }, { passive: false });

    function pinchEnd(event) {
      if (!pinch || event.touches.length >= 2) { return; }
      pinch = null;
      writeScale(scale);
    }
    document.addEventListener('touchend', pinchEnd);
    document.addEventListener('touchcancel', pinchEnd);

    root.addEventListener('touchmove', function (event) {
      if (!drag) { return; }
      for (var i = 0; i < event.changedTouches.length; i += 1) {
        var t = event.changedTouches[i];
        // ドラッグしている間だけ、画面のスクロールを止める
        if (move('touch-' + t.identifier, t.clientX, t.clientY)) { event.preventDefault(); }
      }
    }, { passive: false });

    function touchEnd(event) {
      var canceled = event.type === 'touchcancel';
      for (var i = 0; i < event.changedTouches.length; i += 1) {
        end('touch-' + event.changedTouches[i].identifier, canceled);
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
      end('pointer-' + event.pointerId, event.type === 'pointercancel');
    }
    root.addEventListener('pointerup', pointerEnd);
    root.addEventListener('pointercancel', pointerEnd);

    // 画像そのもののドラッグ（ブラウザ標準）は止める
    root.addEventListener('dragstart', function (event) { event.preventDefault(); });
  }

  /* ---------------------------------------------------------
     大きさ（0.7〜1.6倍）
     CSS の --mascot-scale で横幅を変える（吹き出しの文字の大きさは変えない）。
     右下からの位置はそのままなので、大きくすると左上に広がる。
     --------------------------------------------------------- */
  function clampScale(value) {
    return Math.min(Math.max(value, SCALE_MIN), SCALE_MAX);
  }

  function readScale() {
    try {
      var value = parseFloat(global.localStorage.getItem(SCALE_KEY));
      if (isFinite(value)) { return clampScale(value); }
    } catch (e) { /* 読めなければ標準 */ }
    return 1;
  }

  function writeScale(value) {
    try {
      if (value === 1) {
        global.localStorage.removeItem(SCALE_KEY);
      } else {
        global.localStorage.setItem(SCALE_KEY, String(Math.round(value * 100) / 100));
      }
    } catch (e) { /* 保存できなくても、その場では変えられる */ }
  }

  /** 大きさを変える。save が false のときは保存しない（ピンチの途中など） */
  function setScale(value, save) {
    scale = Math.round(clampScale(value) * 100) / 100;
    if (save !== false) { writeScale(scale); }
    if (!root) { return; }
    root.style.setProperty('--mascot-scale', scale);
    layout();                          // 大きくなっても画面の外に出ないように直す
  }

  function resetScale() {
    setScale(1);
  }

  /** PC：マスコットの上でホイール（トラックパッドの2本指・ピンチ）を回すと拡大縮小 */
  function bindWheel() {
    root.addEventListener('wheel', function (event) {
      if (!visible) { return; }
      event.preventDefault();                               // ページのスクロール・拡大はしない
      var delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      // トラックパッドのピンチ（ctrlKey付き）は値が小さいので、感度を上げる
      var rate = event.ctrlKey ? 0.01 : 0.0015;
      setScale(scale * Math.exp(-delta * rate));
    }, { passive: false });
  }

  /** タップ時のセリフをランダムに選ぶ（直前と同じものは避ける） */
  function tapMessage() {
    var index = Math.floor(Math.random() * TAP_MESSAGES.length);
    if (TAP_MESSAGES.length > 1 && index === lastTapMessage) {
      // 同じだったら、ほかのどれかにずらす
      index = (index + 1 + Math.floor(Math.random() * (TAP_MESSAGES.length - 1))) % TAP_MESSAGES.length;
    }
    lastTapMessage = index;
    return TAP_MESSAGES[index];
  }

  /** タップされたときのリアクション（あいさつして、少しして通常に戻る） */
  function react() {
    // コメント送信中（walk）は、送信中の表示を優先する
    if (current === 'walk') { return; }
    playMascot('wave', 1500);
    say(tapMessage(), 1500);
  }

  /** 保存した位置を消して、右下の初期位置に戻す */
  function resetPosition() {
    saved = null;
    writePosition(null);
    layout();
  }

  /* ---------------------------------------------------------
     吹き出し
     マスコットの上に表示する。画面の上端に近いときは下側に出し、
     左右は画面（セーフエリアの内側）からはみ出さないようにずらす。
     操作の邪魔をしないよう、タップは受け付けない（CSSで pointer-events: none）。
     --------------------------------------------------------- */
  function hideBubble() {
    if (bubbleTimer) { global.clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (bubble) { bubble.classList.remove('is-visible'); }
  }

  /** 吹き出しを表示する。duration（ミリ秒）を省くと、次に消すまで表示したまま */
  function say(text, duration) {
    if (!root) { build(); }
    hideBubble();
    if (!text || !visible) { return; }             // 表示しない設定のときは吹き出しも出さない

    bubbleText.textContent = String(text);
    bubble.classList.add('is-visible');
    positionBubble();

    if (typeof duration === 'number' && duration > 0) {
      bubbleTimer = global.setTimeout(hideBubble, duration);
    }
  }

  function positionBubble() {
    if (!bubble || !bubble.classList.contains('is-visible') || root.hidden) { return; }

    // いったん初期位置（マスコットの上・右寄せ）に戻してから測る
    bubble.classList.remove('is-below');
    bubble.style.right = '';

    var safe = insets();
    var vw = global.innerWidth;
    var box = bubble.getBoundingClientRect();

    // 上にはみ出すときは、マスコットの下側に出す
    if (box.top < safe.top + EDGE) {
      bubble.classList.add('is-below');
      box = bubble.getBoundingClientRect();
    }

    // 左右にはみ出す分だけずらす
    var shift = 0;
    if (box.left < safe.left + EDGE) {
      shift = (safe.left + EDGE) - box.left;          // 右へ
    } else if (box.right > vw - safe.right - EDGE) {
      shift = (vw - safe.right - EDGE) - box.right;    // 左へ
    }
    if (shift) { bubble.style.right = (-shift) + 'px'; }

    // しっぽは、マスコットの中央を指すようにする
    var mascotBox = root.getBoundingClientRect();
    var left = box.left + shift;
    var tail = (mascotBox.left + mascotBox.width / 2) - left;
    tail = Math.min(Math.max(tail, 14), box.width - 14);
    bubble.style.setProperty('--tail-x', tail + 'px');
  }

  /** 起動時のあいさつ（端末の現在時刻で変える） */
  function greeting() {
    var hour = new Date().getHours();
    if (hour >= 5 && hour < 11) { return 'おはよう！'; }
    if (hour >= 11 && hour < 17) { return 'こんにちは！'; }
    if (hour >= 17) { return 'こんばんは！'; }
    return '夜更かしやな〜';                          // 0:00〜4:59
  }

  function start() {
    preload();
    build();
    // 起動時はあいさつしてから通常時へ
    playMascot('wave', 1800);
    say(greeting(), 1800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* ---------------------------------------------------------
     表示する / 表示しない（端末ごとに localStorage へ保存）
     表示しない間は、要素ごと隠すので状態の切り替え・吹き出し・ドラッグも見えない・効かない。
     保存済みの位置はそのまま残す。
     --------------------------------------------------------- */
  function readVisible() {
    try { return global.localStorage.getItem(VISIBLE_KEY) !== '0'; } catch (e) { return true; }
  }

  function setVisible(value) {
    visible = !!value;
    try { global.localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0'); } catch (e) { /* 保存できなくてもその場では切り替わる */ }
    if (!root) { return; }

    if (!visible) {
      hideBubble();
      root.classList.remove('is-dragging');
      root.classList.add('is-off');
      return;
    }

    // 表示に戻したときは、通常の姿で保存位置（なければ右下）に出す
    root.classList.remove('is-off');
    setMascot('idle');
    layout();
  }

  global.AppShareMascot = {
    setMascot: setMascot,
    playMascot: playMascot,
    resetPosition: resetPosition,
    say: say,
    setVisible: setVisible,
    isVisible: function () { return visible; },
    getScale: function () { return scale; },
    resetScale: resetScale
  };
})(window);
