// =========================================================
// あぷりんく : チャットの写真を扱う Edge Function
//
// ブラウザは Storage に直接アクセスしない。
// この関数だけが service_role を使って読み書きし、
// 必ず appshare_staff_sessions のトークンを検証する。
//
// service_role key は Supabase が実行時に環境変数として渡す。
// リポジトリにもブラウザにも含まれない。
//
// 受け付ける操作
//   upload         写真を保存し、コメントを作る
//   view           表示用の期限つきURLを発行する
//   delete-object  どこからも使われていない写真を消す
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";

const BUCKET = "appshare-chat-images";
const MAX_BYTES = 3 * 1024 * 1024;                       // 3MB
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
const SIGNED_URL_SECONDS = 600;                          // 10分

// GitHub Pages（https://...github.io）や、手元でファイルを直接開いた場合
// （Origin が null になる）からも呼べるようにする。
// Cookie は使わないため "*" で問題なく、CORSは認証の代わりにはしない。
// 実際の認証は、すべての操作で行うセッショントークンの検証。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, accept-profile, x-requested-with",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/**
 * ログイン中の職員を確認する。だめなら null。
 * 判定はデータベース側の appshare_session_staff にまかせる
 * （期限切れ・無効なトークン・退職者の確認が1か所にまとまる）。
 */
async function staffIdFromToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || token.length < 32) return null;

  const { data, error } = await admin.rpc("appshare_session_staff", { p_token: token });
  if (error || typeof data !== "string" || data.length === 0) return null;
  return data;
}

/** 写真を保存してコメントを作る */
async function handleUpload(form: FormData) {
  const token = form.get("token");
  const staffId = await staffIdFromToken(token);
  if (!staffId) return json({ ok: false, message: "ログインが必要です" }, 401);

  const appId = String(form.get("app_id") ?? "").trim();
  const body = String(form.get("body") ?? "");
  const file = form.get("file");

  if (!appId) return json({ ok: false, message: "アプリが指定されていません" }, 400);
  if (!(file instanceof File)) return json({ ok: false, message: "写真が選ばれていません" }, 400);
  if (!ALLOWED.includes(file.type)) {
    return json({ ok: false, message: "対応していない画像の種類です" }, 400);
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return json({ ok: false, message: "写真の大きさが上限を超えています（3MBまで）" }, 400);
  }

  // 置き場所は職員IDのフォルダに固定する（ブラウザからは指定できない）
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${staffId}/${crypto.randomUUID()}.${ext}`;

  const up = await admin.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (up.error) {
    return json({ ok: false, message: "写真を保存できませんでした" }, 500);
  }

  // コメントを作る。失敗したら、置いた写真を消して元に戻す
  const { data, error } = await admin.rpc("appshare_comment_add_image", {
    p_token: token,
    p_app_id: appId,
    p_body: body,
    p_image_path: path,
    p_image_mime: file.type,
    p_image_size: file.size,
  });

  if (error) {
    await admin.storage.from(BUCKET).remove([path]);
    return json({ ok: false, message: error.message ?? "コメントを保存できませんでした" }, 400);
  }

  return json({ ok: true, comment: Array.isArray(data) ? data[0] : data });
}

/** 表示用の期限つきURLを発行する */
async function handleView(payload: Record<string, unknown>) {
  const staffId = await staffIdFromToken(payload.token);
  if (!staffId) return json({ ok: false, message: "ログインが必要です" }, 401);

  const path = String(payload.path ?? "");
  if (!path) return json({ ok: false, message: "写真が指定されていません" }, 400);

  // 実際にコメントで使われている写真だけ見られるようにする
  const used = await admin.rpc("appshare_image_in_use", { p_image_path: path });
  if (used.error || used.data !== true) {
    return json({ ok: false, message: "写真が見つかりません" }, 404);
  }

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  if (error || !data) return json({ ok: false, message: "写真を表示できませんでした" }, 500);
  return json({ ok: true, url: data.signedUrl, expires_in: SIGNED_URL_SECONDS });
}

/** どこからも使われていない写真を消す */
async function handleDeleteObject(payload: Record<string, unknown>) {
  const staffId = await staffIdFromToken(payload.token);
  if (!staffId) return json({ ok: false, message: "ログインが必要です" }, 401);

  const path = String(payload.path ?? "");
  if (!path) return json({ ok: false, message: "写真が指定されていません" }, 400);

  // まだコメントから使われている写真は消さない
  const used = await admin.rpc("appshare_image_in_use", { p_image_path: path });
  if (used.error) return json({ ok: false, message: "確認できませんでした" }, 500);
  if (used.data === true) {
    return json({ ok: false, message: "この写真はまだ使われています" }, 409);
  }

  const { error } = await admin.storage.from(BUCKET).remove([path]);
  if (error) return json({ ok: false, message: "写真を削除できませんでした" }, 500);

  return json({ ok: true });
}

Deno.serve(async (req) => {
  // プリフライト（OPTIONS）に応答する
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") return json({ ok: false, message: "POSTで呼んでください" }, 405);

  try {
    const type = req.headers.get("content-type") ?? "";

    if (type.includes("multipart/form-data")) {
      const form = await req.formData();
      if (String(form.get("action") ?? "") !== "upload") {
        return json({ ok: false, message: "操作が正しくありません" }, 400);
      }
      return await handleUpload(form);
    }

    const payload = await req.json().catch(() => ({}));
    const action = String(payload.action ?? "");

    if (action === "view") return await handleView(payload);
    if (action === "delete-object") return await handleDeleteObject(payload);

    return json({ ok: false, message: "操作が正しくありません" }, 400);
  } catch (_error) {
    return json({ ok: false, message: "処理できませんでした" }, 500);
  }
});
