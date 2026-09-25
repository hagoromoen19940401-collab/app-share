/* =========================================================
   data/apps.js
   ファイルタブで使う区分の定義

   アプリの一覧は、設定 → アプリ管理 から登録したものを
   Supabase（appshare_apps_list）から取得する。
   固定のアプリ一覧はこのファイルには持たない。
   ========================================================= */

(function (global) {
  'use strict';

  /**
   * ファイルタブの区分
   * 今回は「置き場所の枠」だけを用意し、実際のファイルはまだ登録しない。
   * 将来 Supabase Storage に置いたファイルを表示する。
   */
  var FILE_CATEGORIES = [
    { id: 'latest',   label: '最新版',        hint: 'アプリ本体（HTML）',          primary: true },
    { id: 'archive',  label: '過去バージョン', hint: '以前のバージョンの保管' },
    { id: 'pdf',      label: 'PDF資料',       hint: '手順書・仕様書など' },
    { id: 'image',    label: '画像',          hint: '画面の写真・スクリーンショット' },
    { id: 'document', label: '説明資料',      hint: '操作説明・申し送り' }
  ];

  global.AppShareData = {
    fileCategories: FILE_CATEGORIES
  };
})(window);
