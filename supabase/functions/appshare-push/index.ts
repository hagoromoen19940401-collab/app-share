// =========================================================
// あぷりんく : 新着チャットのプッシュ通知を送る Edge Function
//
// 投稿に成功したブラウザが、コメントIDを渡して呼ぶ。
// 本人の投稿か・通知済みでないかの確認はデータベース側
// （appshare_push_claim）で行い、投稿者以外の職員の端末へ送る。
//
// 必要な secrets（supabase secrets set で登録。リポジトリには含めない）
//   VAPID_PUBLIC_KEY   公開鍵（js/push.js と同じ値）
//   VAPID_PRIVATE_KEY  秘密鍵
//   VAPID_SUBJECT      連絡先（https://... または mailto:...）
//
// 受け付ける操作
//   notify  { token, comment_id }
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import webpush from "npm:web-push@3.6.7";

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

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "",
  Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
  Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
);

type Target = { author: string; endpoint: string; p256dh: string; auth: string };

async function handleNotify(payload: Record<string, unknown>) {
  const token = String(payload.token ?? "");
  const commentId = String(payload.comment_id ?? "");
  if (token.length < 32 || commentId.length === 0) {
    return json({ ok: false, message: "操作が正しくありません" }, 400);
  }

  // 本人の投稿で、まだ通知していない場合だけ宛先が返る（ここで通知済みになる）
  const { data, error } = await admin.rpc("appshare_push_claim", {
    p_token: token,
    p_comment_id: commentId,
  });
  if (error) return json({ ok: false, message: "ログインが必要です" }, 401);

  const targets = (data ?? []) as Target[];
  if (targets.length === 0) return json({ ok: true, sent: 0 });

  const message = JSON.stringify({
    title: "あぷりんく",
    body: `${targets[0].author}さんから新しいコメント`,
  });

  const gone: string[] = [];
  let sent = 0;

  await Promise.all(targets.map(async (target) => {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        message,
        { TTL: 60 * 60 * 24 },
      );
      sent += 1;
    } catch (err) {
      // 404 / 410 は端末側で通知が解除されたもの。登録から消す
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(target.endpoint);
    }
  }));

  if (gone.length > 0) {
    await admin.rpc("appshare_push_forget", { p_endpoints: gone });
  }

  return json({ ok: true, sent });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") return json({ ok: false, message: "POSTで呼んでください" }, 405);

  try {
    const payload = await req.json().catch(() => ({}));
    if (String(payload.action ?? "") === "notify") return await handleNotify(payload);
    return json({ ok: false, message: "操作が正しくありません" }, 400);
  } catch (_error) {
    return json({ ok: false, message: "処理できませんでした" }, 500);
  }
});
