/* =========================================================
   data/apps.js
   共有対象アプリの一覧データ（試作用の固定データ）
   将来的には Cloudflare D1 から取得する想定の形にしている
   ========================================================= */

(function (global) {
  'use strict';

  /**
   * アプリ1件のデータ構造
   * id          : 内部ID（コメントの保存キーにも使う。変更しないこと）
   * name        : 画面に表示する名称
   * description : 説明文
   * version     : バージョン
   * updatedAt   : 最終更新日（YYYY-MM-DD）
   * changelog   : 今回の更新内容（配列）
   * status      : 状態（'running' 公開中 / 'testing' 確認中 / 'preparing' 準備中）
   * path        : アプリ本体のパス。未登録の場合は null
   * icon        : サイドバーで使う線画アイコンの種類
   * files       : 登録済みファイルの配列（今回はすべて空）
   *               1件の形 { id, category, label, version, updatedAt, path }
   *               category は FILE_CATEGORIES の id を使う
   */
  var APPS = [
    {
      id: 'shift',
      name: '勤務表',
      description: '職員の勤務シフトを作成・確認するためのアプリです。月単位でシフトを組み、印刷用の表としても出力できるようにする予定です。',
      version: '1.0',
      updatedAt: '2026-09-25',
      changelog: [
        '共有システムへの登録を行いました',
        '夜勤の表示位置を調整しました',
        '月切り替え時の表示速度を改善しました'
      ],
      status: 'testing',
      path: null,
      icon: 'calendar',
      // 将来ここに登録済みファイルを入れる（今回は空のまま）
      files: []
    },
    {
      id: 'daily-report',
      name: '業務日誌',
      description: '日々の業務内容・申し送り事項を記録するアプリです。日付ごとに入力し、あとから検索して確認できるようにします。',
      version: '0.9',
      updatedAt: '2026-09-24',
      changelog: [
        '入力欄の高さを自動で広がるようにしました',
        '前日の内容をコピーできるようにしました'
      ],
      status: 'testing',
      path: null,
      icon: 'note',
      // 将来ここに登録済みファイルを入れる（今回は空のまま）
      files: []
    },
    {
      id: 'excretion',
      name: '排泄記録',
      description: '排泄の記録を利用者ごとに入力・確認するアプリです。タブレットでの入力を前提に、ボタン中心の操作にしています。',
      version: '0.6',
      updatedAt: '2026-09-20',
      changelog: [
        '利用者の並び順を居室番号順に変更しました',
        '入力ボタンを大きくしました'
      ],
      status: 'preparing',
      path: null,
      icon: 'clipboard',
      // 将来ここに登録済みファイルを入れる（今回は空のまま）
      files: []
    },
    {
      id: 'transport',
      name: '送迎表',
      description: '送迎の時間・担当者・車両を一覧で管理するアプリです。当日の変更にすぐ対応できる画面を目指しています。',
      version: '1.2',
      updatedAt: '2026-09-18',
      changelog: [
        '車両ごとの色分けを追加しました',
        '印刷時に表がはみ出す問題を修正しました'
      ],
      status: 'running',
      path: null,
      icon: 'route',
      // 将来ここに登録済みファイルを入れる（今回は空のまま）
      files: []
    },
    {
      id: 'bathing',
      name: '入浴表',
      description: '入浴の予定と実施状況を管理するアプリです。曜日ごとの担当と順番を確認できるようにします。',
      version: '0.4',
      updatedAt: '2026-09-12',
      changelog: [
        '画面の下書きを作成しました'
      ],
      status: 'preparing',
      path: null,
      icon: 'drop',
      // 将来ここに登録済みファイルを入れる（今回は空のまま）
      files: []
    }
  ];

  /**
   * ファイルタブの区分
   * 今回は「置き場所の枠」だけを用意し、実際のファイルはまだ登録しない。
   * 将来 Cloudflare R2 に置いたファイルを app.files へ入れて表示する。
   */
  var FILE_CATEGORIES = [
    { id: 'latest',   label: '最新版',        hint: 'アプリ本体（HTML）',          primary: true },
    { id: 'archive',  label: '過去バージョン', hint: '以前のバージョンの保管' },
    { id: 'pdf',      label: 'PDF資料',       hint: '手順書・仕様書など' },
    { id: 'image',    label: '画像',          hint: '画面の写真・スクリーンショット' },
    { id: 'document', label: '説明資料',      hint: '操作説明・申し送り' }
  ];

  /** 状態コード → 画面表示用のラベル */
  var APP_STATUS_LABELS = {
    running: '公開中',
    testing: '確認中',
    preparing: '準備中'
  };

  /** コメントの対応状態（今回は表示のみ。将来ここを切り替えられるようにする） */
  var COMMENT_STATUS = {
    open: '未対応',
    checking: '確認中',
    done: '対応済み'
  };

  global.AppShareData = {
    apps: APPS,
    fileCategories: FILE_CATEGORIES,
    appStatusLabels: APP_STATUS_LABELS,
    commentStatus: COMMENT_STATUS,
    defaultCommentStatus: 'open'
  };
})(window);
