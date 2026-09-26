-- =========================================================
-- あぷりんく : 職員の削除
--
-- 設定 → 職員管理 から職員を完全に削除する。
-- 設定パスワードの確認（settings_token）が必須。
--
-- 既存の外部キーの動きをそのまま利用する。
--   appshare_staff_sessions.staff_id    cascade  → ログインセッションも消える
--   appshare_comment_reads.staff_id     cascade  → 「確認しました」の記録も消える
--   appshare_settings_sessions.staff_id cascade  → その職員の設定セッションも消える
--   appshare_comments.staff_id          set null → コメントは残る（author はそのまま）
--   appshare_apps.created_by            set null → 登録したアプリは残る
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

create or replace function public.appshare_staff_delete(
  p_settings_token text,
  p_staff_id       uuid
)
returns table (ok boolean, message text, staff_name text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_name text;
begin
  -- 設定パスワードの確認が済んでいない場合は削除できない
  if not public.appshare_settings_session_ok(p_settings_token) then
    return query select false, '設定パスワードの確認が必要です'::text, null::text;
    return;
  end if;

  if p_staff_id is null then
    return query select false, '職員が指定されていません'::text, null::text;
    return;
  end if;

  select s.display_name into v_name
    from public.appshare_staff s
   where s.id = p_staff_id
   for update;

  if not found then
    return query select false, '職員が見つかりません'::text, null::text;
    return;
  end if;

  -- いま操作している設定セッションは残す
  -- （削除する職員が作った設定セッションだった場合に、
  --   途中で設定画面が使えなくならないようにするため）
  update public.appshare_settings_sessions s
     set staff_id = null
   where s.token_hash = encode(digest(p_settings_token, 'sha256'), 'hex');

  -- 職員を削除する。
  -- 紐づくログインセッション・確認記録は外部キーで一緒に消え、
  -- コメントと登録アプリは残る（staff_id / created_by が null になる）
  delete from public.appshare_staff s where s.id = p_staff_id;

  return query select true, null::text, v_name;
end;
$$;

-- ---------------------------------------------------------
-- 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_staff_delete(text, uuid) from public;
grant execute on function public.appshare_staff_delete(text, uuid) to anon, authenticated;

-- 内部関数は引き続きブラウザから実行できないようにする
revoke all on function public.appshare_settings_session_ok(text) from public, anon, authenticated;
grant execute on function public.appshare_settings_session_ok(text) to service_role;
