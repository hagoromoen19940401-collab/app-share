-- =========================================================
-- app-share : 20260924192841_appshare_pin_auth.sql の修正
--
-- 修正1 : appshare_login() で戻り値の expires_at と
--         テーブル列の expires_at が衝突してエラーになる問題
-- 修正2 : 内部関数 appshare_session_staff() が
--         anon / authenticated から実行できてしまう問題
--         （Supabaseの既定で自動付与されるため、
--           public からの revoke だけでは足りない）
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- テーブル構造は変更しない。何度実行しても安全。
-- =========================================================

-- ---------------------------------------------------------
-- 修正1 : ログイン関数の列名の衝突を解消
--         delete 文にテーブル別名 s を付け、s.expires_at と明示する
-- ---------------------------------------------------------
create or replace function public.appshare_login(p_staff_id uuid, p_pin text)
returns table (ok boolean, message text, token text, display_name text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff   public.appshare_staff%rowtype;
  v_failed  integer;
  v_token   text;
  v_expires timestamptz;
begin
  -- 期限切れセッションの掃除（戻り値の expires_at と区別するため別名を付ける）
  delete from public.appshare_staff_sessions as s where s.expires_at < now();

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return query select false, '職員名またはPINが違います'::text,
                        null::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_staff from public.appshare_staff where id = p_staff_id for update;

  if not found or not v_staff.is_active then
    return query select false, '職員名またはPINが違います'::text,
                        null::text, null::text, null::timestamptz;
    return;
  end if;

  -- ロックの判定。期限が過ぎていれば失敗回数ごと元に戻す
  if v_staff.locked_until is not null then
    if v_staff.locked_until > now() then
      return query select false, 'PINの入力を続けて間違えたため、しばらく利用できません'::text,
                          null::text, null::text, null::timestamptz;
      return;
    else
      update public.appshare_staff
         set failed_count = 0, locked_until = null
       where id = v_staff.id;

      v_staff.failed_count := 0;
      v_staff.locked_until := null;
    end if;
  end if;

  -- PIN照合（bcrypt）
  if v_staff.pin_hash is null or crypt(p_pin, v_staff.pin_hash) <> v_staff.pin_hash then
    v_failed := v_staff.failed_count + 1;

    update public.appshare_staff
       set failed_count = v_failed,
           locked_until = case when v_failed >= 5
                               then now() + interval '5 minutes'
                               else null end
     where id = v_staff.id;

    return query select false, '職員名またはPINが違います'::text,
                        null::text, null::text, null::timestamptz;
    return;
  end if;

  -- 成功
  update public.appshare_staff
     set failed_count = 0, locked_until = null
   where id = v_staff.id;

  v_token   := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + interval '12 hours';

  insert into public.appshare_staff_sessions (staff_id, token_hash, expires_at)
  values (v_staff.id, encode(digest(v_token, 'sha256'), 'hex'), v_expires);

  return query select true, null::text, v_token, v_staff.display_name, v_expires;
end;
$$;

-- ---------------------------------------------------------
-- 修正2 : 内部関数の実行権限を明示的に剥奪
-- ---------------------------------------------------------
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;

-- 公開する4本の実行権限は維持する
grant execute on function public.appshare_staff_list()                       to anon, authenticated;
grant execute on function public.appshare_login(uuid, text)                  to anon, authenticated;
grant execute on function public.appshare_comments_list(text, text, integer) to anon, authenticated;
grant execute on function public.appshare_comment_add(text, text, text)      to anon, authenticated;
