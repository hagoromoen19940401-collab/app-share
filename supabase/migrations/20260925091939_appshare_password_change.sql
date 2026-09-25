-- =========================================================
-- あぷりんく : 自分のパスワードの変更
--
-- ログイン中の職員本人だけが、自分の4桁パスワードを変更できる。
-- 他人のパスワード変更・管理者によるリセットは作らない。
--
-- 変更に成功したら、操作中の端末のセッションだけを残し、
-- 同じ職員の他の端末・ブラウザのセッションは削除する。
--
-- 平文のパスワードは保存しない（bcryptでハッシュ化して保存する）。
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

create or replace function public.appshare_password_change(
  p_token            text,
  p_current_password text,
  p_new_password     text
)
returns table (ok boolean, message text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id   uuid;
  v_pin_hash   text;
  v_token_hash text;
begin
  -- 1. 現在ログイン中の職員を確認する（未ログイン・期限切れはここで停止）
  v_staff_id := public.appshare_session_staff(p_token);

  -- 入力の形を確認する
  if p_current_password is null or p_current_password = '' then
    return query select false, '現在のパスワードを入力してください'::text;
    return;
  end if;
  if p_new_password is null or p_new_password = '' then
    return query select false, '新しいパスワードを入力してください'::text;
    return;
  end if;
  if p_current_password !~ '^[0-9]{4}$' then
    return query select false, '現在のパスワードが違います'::text;
    return;
  end if;

  -- 3. 新しいパスワードが4桁数字か確認する
  if p_new_password !~ '^[0-9]{4}$' then
    return query select false, '新しいパスワードは4桁の数字で入力してください'::text;
    return;
  end if;

  -- 2. 現在のパスワードが正しいか確認する
  select s.pin_hash into v_pin_hash
    from public.appshare_staff s
   where s.id = v_staff_id
   for update;

  if not found then
    return query select false, '職員が見つかりません'::text;
    return;
  end if;

  if v_pin_hash is null or crypt(p_current_password, v_pin_hash) <> v_pin_hash then
    return query select false, '現在のパスワードが違います'::text;
    return;
  end if;

  -- 4. bcryptでハッシュ化して保存する（平文は保存しない）
  update public.appshare_staff
     set pin_hash     = crypt(p_new_password, gen_salt('bf', 10)),
         failed_count = 0,
         locked_until = null
   where id = v_staff_id;

  -- 操作中の端末のセッションだけを残し、他の端末のセッションは削除する
  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  delete from public.appshare_staff_sessions s
   where s.staff_id = v_staff_id
     and s.token_hash <> v_token_hash;

  return query select true, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_password_change(text, text, text) from public;
grant execute on function public.appshare_password_change(text, text, text) to anon, authenticated;

-- 内部関数は引き続き外部から実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
