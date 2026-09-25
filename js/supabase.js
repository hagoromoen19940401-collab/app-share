/* =========================================================
   js/supabase.js
   Supabase への接続設定

   ここに書いてよいのは「ブラウザ公開用」の情報だけ。
   ・Project URL
   ・Publishable key（sb_publishable_ で始まるもの）

   Secret key（sb_secret_ で始まるもの）と service_role key は
   絶対にこのファイルへ書かないこと。書くと全データが誰でも
   読み書きできる状態になる。

   Publishable key は公開されている前提の鍵で、
   テーブルへの直接アクセスはSupabase側で禁止してある。
   読み書きはすべてRPC（appshare_* 関数）経由で行う。
   ========================================================= */

(function (global) {
  'use strict';

  var CONFIG = {
    url: 'https://xytxjujsydpvmrvnmcnj.supabase.co',
    publishableKey: 'sb_publishable_EzqE7TE3zY_AuZJlZWEuKA_3fsXczmK'
  };

  // チャットの写真を扱う Edge Function
  var IMAGE_FUNCTION_URL = CONFIG.url + '/functions/v1/appshare-chat-image';

  var client = null;

  /** supabase-js のクライアントを1つだけ作って使い回す */
  function getClient() {
    if (client) { return client; }
    if (!global.supabase || !global.supabase.createClient) { return null; }

    client = global.supabase.createClient(CONFIG.url, CONFIG.publishableKey, {
      // このプロジェクトは他のアプリと共用しているため、
      // ログイン状態をブラウザに保存しない（職員の確認は独自のRPCで行う）
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    return client;
  }

  /** RPCを呼ぶ共通処理。失敗は Error として投げる */
  function rpc(name, params) {
    var c = getClient();
    if (!c) {
      return Promise.reject(new Error('Supabaseに接続できませんでした。通信状態をご確認ください。'));
    }
    return c.rpc(name, params || {}).then(function (res) {
      if (res.error) {
        throw new Error(res.error.message || '通信に失敗しました');
      }
      return res.data;
    });
  }

  /** Edge Function の応答を読む。失敗は Error として投げる */
  function readFunctionResponse(response) {
    return response.json().catch(function () {
      return {};
    }).then(function (data) {
      if (!response.ok || !data || data.ok !== true) {
        throw new Error((data && data.message) || '通信に失敗しました');
      }
      return data;
    });
  }

  /** Edge Function をJSONで呼ぶ */
  function callImageFunction(payload) {
    return fetch(IMAGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(readFunctionResponse);
  }

  var Api = {
    /** supabase-js が読み込めているか */
    isReady: function () { return !!getClient(); },

    rpc: rpc,

    /** 職員一覧（表示名のみ。パスワード関連は返らない） */
    staffList: function () {
      return rpc('appshare_staff_list').then(function (rows) {
        return rows || [];
      });
    },

    /** 職員を追加。戻り値は { ok, message, staff_id, staff_name } */
    staffAdd: function (displayName, password) {
      return rpc('appshare_staff_add', {
        p_display_name: displayName,
        p_password: password
      }).then(function (rows) {
        return (rows && rows[0]) || { ok: false, message: '登録できませんでした' };
      });
    },

    /** 登録されたアプリの一覧（ログイン中のみ） */
    appsList: function (token) {
      return rpc('appshare_apps_list', { p_token: token }).then(function (rows) {
        return rows || [];
      });
    },

    /** 自分のパスワードを変更。戻り値は { ok, message } */
    passwordChange: function (token, currentPassword, newPassword) {
      return rpc('appshare_password_change', {
        p_token: token,
        p_current_password: currentPassword,
        p_new_password: newPassword
      }).then(function (rows) {
        return (rows && rows[0]) || { ok: false, message: '変更できませんでした' };
      });
    },

    /**
     * 写真つきコメントの投稿。
     * 投稿者名と staff_id はブラウザから送らない（サーバー側で決まる）
     */
    imageUpload: function (token, appId, body, blob) {
      var form = new FormData();
      form.append('action', 'upload');
      form.append('token', token);
      form.append('app_id', appId);
      form.append('body', body || '');
      form.append('file', blob, 'photo.jpg');

      return fetch(IMAGE_FUNCTION_URL, { method: 'POST', body: form })
        .then(readFunctionResponse);
    },

    /** 表示用の署名つきURLを取得。{ url, expires_in } を返す */
    imageViewUrl: function (token, path) {
      return callImageFunction({ action: 'view', token: token, path: path });
    },

    /** 使われていない写真をStorageから削除する */
    imageDelete: function (token, path) {
      return callImageFunction({ action: 'delete-object', token: token, path: path });
    },

    /** アプリを登録。戻り値は { ok, message, app_id, app_name } */
    appAdd: function (token, name, url, description) {
      return rpc('appshare_app_add', {
        p_token: token,
        p_name: name,
        p_url: url,
        p_description: description || ''
      }).then(function (rows) {
        return (rows && rows[0]) || { ok: false, message: '登録できませんでした' };
      });
    }
  };

  global.AppShareSupabase = Api;
})(window);
