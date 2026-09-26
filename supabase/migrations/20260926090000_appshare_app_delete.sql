-- =========================================================
-- あぷりんく : 登録済みアプリの削除
--
-- 設定 → アプリ管理 から登録アプリを削除する。
-- 職員ログイン（token）と設定パスワードの確認（settings_token）の両方が必須。
--
-- 削除するもの
--   appshare_apps            対象アプリ
--   appshare_comments        app_id が対象アプリのコメント
--   appshare_comment_reads   コメント削除の cascade で一緒に消える
--   appshare_comment_images  コメント削除の cascade で一緒に消える
--
-- Storage の写真本体は、ここで返すパスを使って
-- Edge Function（appshare-chat-image の delete-object）で削除する。
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

create or replace function public.appshare_app_delete(
  p_token          text,
  p_settings_token text,
  p_app_id         uuid
)
returns table (ok boolean, message text, app_name text, image_paths text[])
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_name  text;
  v_paths text[];
begin
  -- 未ログイン・期限切れならここで停止
  perform public.appshare_session_staff(p_token);

  -- 設定パスワードの確認も必須
  if not public.appshare_settings_session_ok(p_settings_token) then
    return query select false, '設定パスワードの確認が必要です'::text, null::text, null::text[];
    return;
  end if;

  if p_app_id is null then
    return query select false, 'アプリが指定されていません'::text, null::text, null::text[];
    return;
  end if;

  select a.name into v_name
    from public.appshare_apps a
   where a.id = p_app_id
   for update;

  if not found then
    return query select false, 'アプリが見つかりません'::text, null::text, null::text[];
    return;
  end if;

  -- 削除前に、このアプリのコメントに紐づく写真のパスをすべて集める
  -- （新しい持ち方 appshare_comment_images と、古い列 image_path の両方）
  select coalesce(array_agg(distinct x.path), '{}')
    into v_paths
    from (
      select i.image_path as path
        from public.appshare_comment_images i
        join public.appshare_comments c on c.id = i.comment_id
       where c.app_id = p_app_id::text
      union
      select c.image_path
        from public.appshare_comments c
       where c.app_id = p_app_id::text
         and c.image_path is not null
    ) x;

  -- コメントを削除（確認履歴・写真の行は外部キーで一緒に消える）
  delete from public.appshare_comments c where c.app_id = p_app_id::text;

  delete from public.appshare_apps a where a.id = p_app_id;

  return query select true, null::text, v_name, v_paths;
end;
$$;

-- ---------------------------------------------------------
-- 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_app_delete(text, text, uuid) from public;
grant execute on function public.appshare_app_delete(text, text, uuid) to anon, authenticated;

-- 内部関数は引き続きブラウザから実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
grant execute on function public.appshare_session_staff(text) to service_role;
revoke all on function public.appshare_settings_session_ok(text) from public, anon, authenticated;
grant execute on function public.appshare_settings_session_ok(text) to service_role;
