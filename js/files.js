/* 資料（PDF / Excel）。資料・一時URLはブラウザに永続保存しない。 */
(function (global) {
  'use strict';

  var el = null;
  var appId = null;
  var rows = [];
  var generation = 0;
  var busy = false;
  var timer = null;
  var message = '';

  function token() {
    var session = global.AppShareAuth.getSession();
    return session ? session.token : '';
  }

  function gate() {
    return global.AppShareSettings ? global.AppShareSettings.getToken() : null;
  }

  function render() {
    if (!el) { return; }
    var escape = global.AppShareUtil.escapeHtml;
    var unlocked = !!token() && !!gate();
    el.innerHTML = '<div class="panel__head"><h2 class="section-title">資料</h2>' +
      (unlocked ? '<button class="button button--ghost" type="button" data-add' + (busy ? ' disabled' : '') + '>資料を追加</button>' +
        '<input type="file" accept=".pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden data-pdfs>' : '') + '</div>' +
      '<p class="panel__note">PDF / Excel（.xlsx）、1ファイル10MBまで</p>' +
      (rows.length ? '<ul class="file-list">' + rows.map(function (row) {
        return '<li class="file-row"><span class="file-row__body"><span class="file-row__label">' + escape(row.file_name) + '</span></span>' +
          '<button class="button button--ghost" type="button" data-view="' + escape(row.id) + '"' + (busy ? ' disabled' : '') + '>開く</button>' +
          (unlocked ? '<button class="button button--ghost" type="button" data-delete="' + escape(row.id) + '"' + (busy ? ' disabled' : '') + '>削除</button>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="panel__note">資料は登録されていません。</p>') +
      '<p role="status" data-message></p>';
    el.querySelector('[data-message]').textContent = message;
    el.querySelectorAll('[data-add], [data-delete]').forEach(function (button) {
      button.hidden = !unlocked;
    });
  }

  function load(id, seq) {
    return global.AppShareSupabase.filesRequest({ action: 'list', token: token(), app_id: id }).then(function (result) {
      if (seq !== generation) { return; }
      rows = result.files;
      render();
    });
  }

  function run(work) {
    var seq = generation;
    var id = appId;
    busy = true;
    message = '処理中です…';
    render();
    return work().then(function () {
      if (seq !== generation) { return; }
      message = '';
      return load(id, seq);
    }).catch(function (error) {
      if (seq !== generation) { return; }
      message = error.message;
      // 複数選択の途中で失敗しても、保存できた資料を反映する。
      return load(id, seq).catch(function () { /* 元のエラーを表示する */ });
    }).finally(function () {
      if (seq !== generation) { return; }
      busy = false;
      render();
    });
  }

  function click(event) {
    var button = event.target.closest('button');
    if (!button || busy) { return; }
    if (button.hasAttribute('data-add')) {
      if (gate()) { el.querySelector('[data-pdfs]').click(); }
      return;
    }
    var fileId = button.getAttribute('data-view');
    if (fileId) {
      // 非同期処理より先に開き、スマートフォンのポップアップ制限を避ける。
      var tab = global.open('about:blank', '_blank');
      if (!tab) { message = 'ファイルを開くため、ポップアップを許可してください。'; render(); return; }
      tab.opener = null;
      var seq = generation;
      global.AppShareSupabase.filesRequest({ action: 'view', token: token(), app_id: appId, file_id: fileId }).then(function (result) {
        if (seq !== generation || !token()) { tab.close(); return; }
        tab.location.replace(result.url);
      }).catch(function (error) {
        tab.close();
        if (seq === generation) { message = error.message; render(); }
      });
      return;
    }
    fileId = button.getAttribute('data-delete');
    if (!fileId || !gate() || !global.confirm('この資料を削除しますか？')) { return; }
    var payload = { action: 'delete', token: token(), settings_token: gate(), app_id: appId, file_id: fileId };
    run(function () { return global.AppShareSupabase.filesRequest(payload); });
  }

  function change(event) {
    if (!event.target.matches('[data-pdfs]') || busy || !gate()) { return; }
    var files = Array.prototype.slice.call(event.target.files);
    if (!files.length) { return; }
    if (files.some(function (file) { return !/\.(pdf|xlsx)$/i.test(file.name) || file.size <= 0 || file.size > 10 * 1024 * 1024; })) {
      message = '10MB以内のPDFまたはExcel（.xlsx）を選択してください。'; render(); return;
    }
    var id = appId;
    var seq = generation;
    var staffToken = token();
    run(function () {
      return files.reduce(function (chain, file) {
        return chain.then(function () {
          if (seq !== generation) { throw new Error('アプリが切り替わったため追加を中止しました。'); }
          if (!gate()) { throw new Error('設定パスワードの確認が必要です。'); }
          return global.AppShareSupabase.fileUpload(staffToken, gate(), id, file);
        });
      }, Promise.resolve());
    });
  }

  global.AppShareFiles = {
    show: function (container, id) {
      this.clear();
      el = container;
      appId = id;
      var seq = generation;
      el.addEventListener('click', click);
      el.addEventListener('change', change);
      message = '資料を読み込んでいます…';
      render();
      load(id, seq).then(function () {
        if (seq === generation) { message = ''; render(); }
      }).catch(function (error) {
        if (seq === generation) { message = error.message; render(); }
      });
      // 設定解除の期限切れも画面に反映する。
      timer = global.setInterval(this.refreshControls, 1000);
    },
    refreshControls: function () {
      if (!el) { return; }
      var unlocked = !!token() && !!gate();
      var hasControls = !!el.querySelector('[data-add]');
      if (unlocked !== hasControls) { render(); }
    },
    clear: function () {
      generation += 1;
      global.clearInterval(timer);
      if (el) {
        el.removeEventListener('click', click);
        el.removeEventListener('change', change);
        el.innerHTML = '';
      }
      el = null;
      appId = null;
      rows = [];
      busy = false;
      message = '';
    }
  };
})(window);
