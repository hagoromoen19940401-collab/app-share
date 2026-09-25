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

    /**
     * 職員を追加。設定パスワードの確認（settings_token）が必須。
     * 戻り値は { ok, message, staff_id, staff_name }
     */
    staffAdd: function (settingsToken, displayName, password) {
      return rpc('appshare_staff_add', {
        p_settings_token: settingsToken,
        p_display_name: displayName,
        p_password: password
      }).then(function (rows) {
        return (rows && rows[0]) || { ok: false, message: '登録できませんでした' };
      });
    },

    /** 設定パスワードが登録済みかどうか（ログイン不要） */
    settingsStatus: function () {
      return rpc('appshare_settings_status').then(function (rows) {
        return (rows && rows[0]) || { configured: false, locked: false };
      });
    },

    /** 最初の設定パスワードを登録する。戻り値に settings_token を含む */
    settingsInit: function (token, newPassword) {
      return rpc('appshare_settings_init', {
        p_token: token || '',
        p_new_password: newPassword
      }).then(function (rows) {
        return (rows && rows[0]) || { ok: false, message: '設定できませんでした' };
      });
    },

    /** 設定パスワードを確認して settings_token を受け取る（職員ログインは不要） */
    settingsUnlock: function (password) {
      return rpc('appshare_settings_unlock', { p_password: password }).then(function (rows) {
        return (rows && rows[0]) || { ok: false, message: '確認できませんでした' };
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
     * 写真つきコメントの投稿（最大4枚）。
     * 投稿者名・staff_id・表示順はブラウザから送らない（サーバー側で決まる）。
     * 写真は渡した順に 0, 1, 2, 3 として保存される。
     */
    imageUpload: function (token, appId, body, blobs) {
      var list = [].concat(blobs || []);
      var form = new FormData();
      form.append('action', 'upload');
      form.append('token', token);
      form.append('app_id', appId);
      form.append('body', body || '');

      list.forEach(function (blob, index) {
        form.append('file', blob, 'photo-' + index + '.jpg');
      });

      return fetch(IMAGE_FUNCTION_URL, { method: 'POST', body: form })
        .then(readFunctionResponse);
    },

    /** 表示用の署名つきURLを取得。{ url, expires_in } を返す */
    imageViewUrl: function (token, path) {
      return callImageFunction({ action: 'view', token: token, path: path });
    },

    /** 使われていない写真をStorageから削除する（1枚でも複数枚でも） */
    imageDelete: function (token, paths) {
      var list = [].concat(paths || []);
      return callImageFunction({ action: 'delete-object', token: token, paths: list });
    },

    /**
     * アプリを登録。職員ログインと設定パスワードの確認の両方が必要。
     * 戻り値は { ok, message, app_id, app_name }
     */
    appAdd: function (token, settingsToken, name, url, description) {
      return rpc('appshare_app_add', {
        p_token: token,
        p_settings_token: settingsToken,
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
