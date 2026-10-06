// 説明資料専用。全操作で独自職員セッション、更新操作では設定セッションも検証。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const BUCKET = "appshare-files";
const MAX_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60;
// 実行中のアップロードを回収しないよう、Edge Functionの実行時間上限より長く取る。
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FileRow = { id: string; app_id: string; storage_path: string; status: string; created_at: string };

/** Storageを消せた場合だけ行を消す。失敗した行は次回再試行のため残す。 */
async function removeFile(row: FileRow) {
  if (row.storage_path !== `${row.app_id}/${row.id}.pdf`) throw new Error("保存先が正しくありません");
  const removed = await admin.storage.from(BUCKET).remove([row.storage_path]);
  if (removed.error) throw new Error("PDFを削除できませんでした");
  const deleted = await admin.from("appshare_files").delete().eq("id", row.id).eq("app_id", row.app_id);
  if (deleted.error) throw new Error("資料情報を削除できませんでした。削除を再試行してください");
}

/** 認証済みの呼び出し時に、このアプリの1時間以上前のpendingを最大20件回収する。 */
async function collectPending(appId: string) {
  const cutoff = new Date(Date.now() - PENDING_MAX_AGE_MS).toISOString();
  const result = await admin.from("appshare_files").select("id, app_id, storage_path, status, created_at")
    .eq("app_id", appId).eq("status", "pending").lt("created_at", cutoff).order("created_at").limit(20);
  if (result.error) { console.error("appshare-files pending lookup failed"); return; }
  for (const row of result.data ?? []) {
    try { await removeFile(row); }
    catch (_error) { console.error("appshare-files pending cleanup failed", row.id); }
  }
}

/** 一括削除中のアップロードは消さずにアプリ削除を止める。全行（pendingも）を対象にする。 */
async function deleteAppFiles(appId: string) {
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  // 1000件を超えても取得漏れしないよう、削除した後に次の100件を読む。
  while (true) {
    const result = await admin.from("appshare_files").select("id, app_id, storage_path, status, created_at")
      .eq("app_id", appId).order("created_at").order("id").limit(100);
    if (result.error) throw new Error("説明資料を取得できませんでした");
    if (!result.data?.length) return;
    if (result.data.some((row: FileRow) => row.status === "pending" && Date.parse(row.created_at) >= cutoff)) {
      throw new Error("説明資料のアップロード処理中です。時間をおいてアプリ削除を再試行してください");
    }
    for (const row of result.data) await removeFile(row);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POSTで呼んでください" }, 405);
  try {
    // 巨大なmultipartの読み込みを避ける（ファイル自体も後で検証）。
    const length = Number(req.headers.get("content-length"));
    if (length > MAX_BYTES + 64 * 1024) return json({ ok: false, message: "PDFは10MBまでです" }, 413);
    const multipart = (req.headers.get("content-type") ?? "").includes("multipart/form-data");
    const form = multipart ? await req.formData() : null;
    const payload = form ? null : await req.json();
    const value = (key: string): unknown => form ? form.get(key) : payload?.[key];
    const action = value("action");
    if (!["list", "upload", "view", "delete", "delete-app-files"].includes(String(action))) {
      return json({ ok: false, message: "操作が正しくありません" }, 400);
    }
    const token = value("token");
    if (typeof token !== "string" || token.length < 32) return json({ ok: false, message: "ログインが必要です" }, 401);
    const staff = await admin.rpc("appshare_session_staff", { p_token: token });
    if (staff.error || typeof staff.data !== "string" || !staff.data) {
      return json({ ok: false, message: "ログインが必要です" }, 401);
    }
    if (action === "upload" || action === "delete" || action === "delete-app-files") {
      const settingsToken = value("settings_token");
      if (typeof settingsToken !== "string" || !settingsToken) {
        return json({ ok: false, message: "設定パスワードの確認が必要です" }, 403);
      }
      const settings = await admin.rpc("appshare_settings_session_ok", { p_settings_token: settingsToken });
      if (settings.error || settings.data !== true) {
        return json({ ok: false, message: "設定パスワードの確認が必要です" }, 403);
      }
    }
    const rawAppId = value("app_id");
    if (typeof rawAppId !== "string" || !uuid.test(rawAppId)) return json({ ok: false, message: "アプリが指定されていません" }, 400);
    const appId = rawAppId.toLowerCase();
    const app = await admin.from("appshare_apps").select("id").eq("id", appId).eq("is_active", true).maybeSingle();
    if (app.error) return json({ ok: false, message: "アプリを確認できませんでした" }, 500);
    if (!app.data) return json({ ok: false, message: "アプリが見つかりません" }, 404);

    await collectPending(appId);

    if (action === "delete-app-files") {
      try { await deleteAppFiles(appId); }
      catch (error) { return json({ ok: false, message: error instanceof Error ? error.message : "説明資料を削除できませんでした" }, 409); }
      return json({ ok: true });
    }

    if (action === "list") {
      const result = await admin.from("appshare_files").select("id, file_name, created_at")
        .eq("app_id", appId).eq("status", "ready").order("created_at").order("id");
      if (result.error) return json({ ok: false, message: "説明資料を取得できませんでした" }, 500);
      return json({ ok: true, files: result.data });
    }

    if (action === "upload") {
      const files = form?.getAll("file");
      const file = files?.[0];
      if (files?.length !== 1 || !(file instanceof File) || !/\.pdf$/i.test(file.name) ||
        file.type !== "application/pdf" ||
        file.name.length > 255 || /[\x00-\x1f\x7f]/.test(file.name) || file.size <= 0 || file.size > MAX_BYTES) {
        return json({ ok: false, message: "10MB以内のPDFを選択してください（名前は255文字まで）" }, 400);
      }
      const signature = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
      if (signature !== "%PDF-") return json({ ok: false, message: "PDF形式のファイルを選択してください" }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        // pdf-libが補修して読み込める場合でも、末尾が切れたPDFは登録しない。
        if (!/%%EOF\s*$/.test(new TextDecoder().decode(bytes.slice(-1024)))) throw new Error("PDF末尾がありません");
        const pdf = await PDFDocument.load(bytes, {
          ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false,
        });
        if (!pdf.getPages().length) throw new Error("ページがありません");
      } catch (_error) {
        return json({ ok: false, message: "PDFを読み込めませんでした。壊れていない通常のPDFを選択してください" }, 400);
      }
      const id = crypto.randomUUID();
      const path = `${appId}/${id}.pdf`;
      const inserted = await admin.from("appshare_files").insert({
        id, app_id: appId, file_name: file.name, storage_path: path, uploaded_by: staff.data, status: "pending",
      });
      if (inserted.error) return json({ ok: false, message: "説明資料を登録できませんでした" }, 500);
      const upload = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
      if (upload.error) {
        // 通信エラーではStorageに届いた可能性もあるため、Storage削除を先に確認する。
        try { await removeFile({ id, app_id: appId, storage_path: path, status: "pending", created_at: "" }); }
        catch (_error) { console.error("appshare-files upload cleanup deferred", id); }
        return json({ ok: false, message: "PDFを保存できませんでした" }, 500);
      }
      const ready = await admin.from("appshare_files").update({ status: "ready" })
        .eq("id", id).eq("app_id", appId).eq("status", "pending").select("id").single();
      if (ready.error) {
        // Storageとpending行を残し、時間経過後の回収処理に任せる。
        return json({ ok: false, message: "説明資料を登録できませんでした" }, 500);
      }
      return json({ ok: true, file_id: id });
    }

    const rawFileId = value("file_id");
    if (typeof rawFileId !== "string" || !uuid.test(rawFileId)) return json({ ok: false, message: "資料が指定されていません" }, 400);
    const fileId = rawFileId.toLowerCase();
    const row = await admin.from("appshare_files").select("id, app_id, storage_path, status, created_at")
      .eq("id", fileId).eq("app_id", appId).eq("status", "ready").maybeSingle();
    if (row.error) return json({ ok: false, message: "資料を確認できませんでした" }, 500);
    if (!row.data) return json({ ok: false, message: "資料が見つかりません" }, 404);
    // 保存先はユーザー指定のパスを受け付けず、DBのアプリ・資料IDから限定する。
    if (row.data.storage_path !== `${appId}/${fileId}.pdf`) return json({ ok: false, message: "保存先が正しくありません" }, 500);
    if (action === "view") {
      const signed = await admin.storage.from(BUCKET).createSignedUrl(row.data.storage_path, SIGNED_URL_SECONDS);
      if (signed.error || !signed.data) return json({ ok: false, message: "PDFを開けませんでした" }, 500);
      return json({ ok: true, url: signed.data.signedUrl, expires_in: SIGNED_URL_SECONDS });
    }

    try { await removeFile(row.data); }
    catch (error) { return json({ ok: false, message: error instanceof Error ? error.message : "資料を削除できませんでした" }, 500); }
    return json({ ok: true });
  } catch (_error) {
    return json({ ok: false, message: "処理できませんでした" }, 500);
  }
});
