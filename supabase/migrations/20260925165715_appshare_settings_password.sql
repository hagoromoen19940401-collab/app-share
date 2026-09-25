-- =========================================================
-- あぷりんく : 設定画面の4桁パスワード
--
-- 施設で共有する「設定用パスワード」を1つ持ち、
-- 設定画面（職員管理・アプリ管理）を保護する。
-- 職員本人のログインパスワードとは別物。
--
-- 画面を隠すだけでは意味がないため、
--   ・職員登録  appshare_staff_add
--   ・アプリ登録 appshare_app_add
-- は設定用トークンを必須にする（古い形は削除する）。
--
-- 平文は保存せず bcrypt でハッシュ化する。
-- 設定用トークンもハッシュだけを保存する。
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. 設定パスワード（1行だけ持つ）
-- ---------------------------------------------------------
create table if not exists public.appshare_settings (
  id            smallint    primary key default 1,
  password_hash text        not null,
  failed_count  integer     not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint appshare_settings_single_row check (id = 1)
);

comment on table  public.appshare_settings               is '設定画面を開くための共有パスワード（1行のみ）';
comment on column public.appshare_settings.password_hash is 'bcryptハッシュ。平文は保存しない';

alter table public.appshare_settings enable row level security;
revoke all on table public.appshare_settings from anon, authenticated;

-- ---------------------------------------------------------
-- 2. 設定用トークンのセッション
-- ---------------------------------------------------------
create table if not exists public.appshare_settings_sessions (
  id         uuid        primary key default gen_random_uuid(),
  staff_id   uuid        references public.appshare_staff (id) on delete cascade,   -- 任意（null可）
  token_hash text        not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table  public.appshare_settings_sessions            is '設定パスワード確認後の一時トークン（既定30分）';
comment on column public.appshare_settings_sessions.staff_id   is '分かる場合のみ記録する。未ログインでの解除では null';
comment on column public.appshare_settings_sessions.token_hash is 'トークンのSHA-256。生の値は保存しない';

create index if not exists appshare_settings_sessions_expires_at_idx
  on public.appshare_settings_sessions (expires_at);

alter table public.appshare_settings_sessions enable row level security;
revoke all on table public.appshare_settings_sessions from anon, authenticated;

-- ---------------------------------------------------------
-- 3. 内部関数 : 設定用トークンを検証する
--    ブラウザからは実行できない
-- ---------------------------------------------------------
create or replace function public.appshare_settings_session_ok(p_settings_token text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ok boolean;
begin
  if p_settings_token is null or length(p_settings_token) < 32 then
    return false;
  end if;

  select exists (
    select 1
      from public.appshare_settings_sessions s
     where s.token_hash = encode(digest(p_settings_token, 'sha256'), 'hex')
       and s.expires_at > now()
  ) into v_ok;

  return v_ok;
end;
$$;

-- ---------------------------------------------------------
-- 4. 内部関数 : 設定用トークンを発行する
-- ---------------------------------------------------------
create or replace function public.appshare_settings_issue(p_staff_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token   text;
  v_expires timestamptz;
begin
  -- 期限切れの掃除
  delete from public.appshare_settings_sessions s where s.expires_at < now();

  v_token   := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + interval '30 minutes';

  insert into public.appshare_settings_sessions (staff_id, token_hash, expires_at)
  values (p_staff_id, encode(digest(v_token, 'sha256'), 'hex'), v_expires);

  return query select v_token, v_expires;
end;
$$;

-- ---------------------------------------------------------
-- 5. 設定パスワードの状態
--    まだ職員登録していない人も設定画面へ進めるよう、ログインは求めない。
--    返すのは「登録済みかどうか」と「ロック中かどうか」だけで、
--    ハッシュなどの秘密情報は一切返さない。
-- ---------------------------------------------------------
drop function if exists public.appshare_settings_status(text);

create or replace function public.appshare_settings_status()
returns table (configured boolean, locked boolean)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (select 1 from public.appshare_settings),
         coalesce((select s.locked_until > now()
                     from public.appshare_settings s where s.id = 1), false);
$$;

-- ---------------------------------------------------------
-- 6. 初回登録
--    まだ設定パスワードが無いときだけ実行できる。
--    職員が1人もいない状態（初期構築時）でも行き止まりにならないよう、
--    職員が0人のときに限り、職員ログインなしでも登録できる。
-- ---------------------------------------------------------
create or replace function public.appshare_settings_init(
  p_token        text,
  p_new_password text
)
returns table (ok boolean, message text, settings_token text, valid_until timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id    uuid;
  v_staff_count integer;
  v_issued      record;
begin
  if exists (select 1 from public.appshare_settings) then
    return query select false, '設定パスワードはすでに登録されています'::text, null::text, null::timestamptz;
    return;
  end if;

  select count(*)::integer into v_staff_count from public.appshare_staff;

  if v_staff_count > 0 then
    v_staff_id := public.appshare_session_staff(p_token);   -- 未ログインならここで停止
  end if;

  if p_new_password is null or p_new_password !~ '^[0-9]{4}$' then
    return query select false, '設定パスワードは4桁の数字で入力してください'::text, null::text, null::timestamptz;
    return;
  end if;

  insert into public.appshare_settings (id, password_hash)
  values (1, crypt(p_new_password, gen_salt('bf', 10)))
  on conflict (id) do nothing;

  -- 同時に2回呼ばれた場合は、あとから来た方を断る
  if not found then
    return query select false, '設定パスワードはすでに登録されています'::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_issued from public.appshare_settings_issue(v_staff_id);

  return query select true, null::text, v_issued.token, v_issued.expires_at;
end;
$$;

-- ---------------------------------------------------------
-- 7. 設定パスワードの確認（開錠）
--    設定画面は「共有の4桁パスワード」で守るため、職員ログインは求めない。
--    まだ登録されていない職員も、4桁を知っていれば設定画面を開ける。
--    失敗を記録するため、例外ではなく戻り値で返す
-- ---------------------------------------------------------
drop function if exists public.appshare_settings_unlock(text, text);

create or replace function public.appshare_settings_unlock(
  p_password text
)
returns table (ok boolean, message text, settings_token text, valid_until timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_row    public.appshare_settings%rowtype;
  v_failed integer;
  v_issued record;
begin
  select * into v_row from public.appshare_settings where id = 1 for update;

  if not found then
    return query select false, '設定パスワードがまだ登録されていません'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_row.locked_until is not null then
    if v_row.locked_until > now() then
      return query select false, '設定パスワードの入力を続けて間違えたため、しばらく利用できません'::text,
                          null::text, null::timestamptz;
      return;
    else
      update public.appshare_settings
         set failed_count = 0, locked_until = null, updated_at = now()
       where id = 1;
      v_row.failed_count := 0;
    end if;
  end if;

  if p_password is null or p_password !~ '^[0-9]{4}$'
     or crypt(p_password, v_row.password_hash) <> v_row.password_hash then
    v_failed := v_row.failed_count + 1;

    update public.appshare_settings
       set failed_count = v_failed,
           locked_until = case when v_failed >= 5 then now() + interval '5 minutes' else null end,
           updated_at   = now()
     where id = 1;

    return query select false, '設定パスワードが違います'::text, null::text, null::timestamptz;
    return;
  end if;

  update public.appshare_settings
     set failed_count = 0, locked_until = null, updated_at = now()
   where id = 1;

  -- 誰が開錠したかは分からないため staff_id は null
  select * into v_issued from public.appshare_settings_issue(null);

  return query select true, null::text, v_issued.token, v_issued.expires_at;
end;
$$;

-- ---------------------------------------------------------
-- 8. 職員登録 : 設定用トークンだけを必須にする
--    （職員ログインは求めない。設定パスワードを知っている人が
--      新しい職員を登録できるようにするため）
--    古い形（設定確認なし）は削除する
-- ---------------------------------------------------------
drop function if exists public.appshare_staff_add(text, text);

create function public.appshare_staff_add(
  p_settings_token text,
  p_display_name   text,
  p_password       text
)
returns table (ok boolean, message text, staff_id uuid, staff_name text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_name  text;
  v_id    uuid;
  v_order integer;
begin
  -- 設定パスワードの確認が済んでいない場合は登録できない
  if not public.appshare_settings_session_ok(p_settings_token) then
    return query select false, '設定パスワードの確認が必要です'::text, null::uuid, null::text;
    return;
  end if;

  v_name := btrim(coalesce(p_display_name, ''));

  if v_name = '' then
    return query select false, '職員名を入力してください'::text, null::uuid, null::text;
    return;
  end if;
  if char_length(v_name) > 30 then
    return query select false, '職員名は30文字までで入力してください'::text, null::uuid, null::text;
    return;
  end if;
  if p_password is null or p_password !~ '^[0-9]{4}$' then
    return query select false, 'パスワードは4桁の数字で入力してください'::text, null::uuid, null::text;
    return;
  end if;
  if exists (select 1 from public.appshare_staff s where s.display_name = v_name) then
    return query select false, 'この職員名はすでに登録されています'::text, null::uuid, null::text;
    return;
  end if;

  select coalesce(max(s.sort_order), 0) + 10 into v_order from public.appshare_staff s;

  insert into public.appshare_staff (display_name, pin_hash, is_active, sort_order)
  values (v_name, crypt(p_password, gen_salt('bf', 10)), true, v_order)
  returning appshare_staff.id into v_id;

  return query select true, null::text, v_id, v_name;

exception
  when unique_violation then
    return query select false, 'この職員名はすでに登録されています'::text, null::uuid, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 9. アプリ登録 : 職員ログイン＋設定用トークンの両方を必須にする
--    古い形は削除する
-- ---------------------------------------------------------
drop function if exists public.appshare_app_add(text, text, text, text);

create function public.appshare_app_add(
  p_token          text,
  p_settings_token text,
  p_name           text,
  p_url            text,
  p_description    text default ''
)
returns table (ok boolean, message text, app_id uuid, app_name text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_name     text;
  v_url      text;
  v_desc     text;
  v_id       uuid;
begin
  -- 未ログイン・期限切れならここで停止
  v_staff_id := public.appshare_session_staff(p_token);

  -- 設定パスワードの確認も必須
  if not public.appshare_settings_session_ok(p_settings_token) then
    return query select false, '設定パスワードの確認が必要です'::text, null::uuid, null::text;
    return;
  end if;

  v_name := btrim(coalesce(p_name, ''));
  v_url  := btrim(coalesce(p_url, ''));
  v_desc := btrim(coalesce(p_description, ''));

  if v_name = '' then
    return query select false, 'アプリ名を入力してください'::text, null::uuid, null::text;
    return;
  end if;
  if char_length(v_name) > 100 then
    return query select false, 'アプリ名は100文字までで入力してください'::text, null::uuid, null::text;
    return;
  end if;
  if v_url = '' then
    return query select false, 'URLを入力してください'::text, null::uuid, null::text;
    return;
  end if;
  if v_url !~* '^https?://' then
    return query select false, 'URLは http:// または https:// で始まる形で入力してください'::text,
                        null::uuid, null::text;
    return;
  end if;
  if char_length(v_url) > 2000 then
    return query select false, 'URLが長すぎます（2000文字まで）'::text, null::uuid, null::text;
    return;
  end if;
  if char_length(v_desc) > 1000 then
    return query select false, '説明は1000文字までで入力してください'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.appshare_apps (name, url, description, is_active, created_by)
  values (v_name, v_url, v_desc, true, v_staff_id)
  returning appshare_apps.id into v_id;

  return query select true, null::text, v_id, v_name;
end;
$$;

-- ---------------------------------------------------------
-- 10. 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_settings_session_ok(text)              from public, anon, authenticated;
revoke all on function public.appshare_settings_issue(uuid)                   from public, anon, authenticated;
revoke all on function public.appshare_settings_status()                       from public;
revoke all on function public.appshare_settings_init(text, text)              from public;
revoke all on function public.appshare_settings_unlock(text)                  from public;
revoke all on function public.appshare_staff_add(text, text, text)            from public;
revoke all on function public.appshare_app_add(text, text, text, text, text)  from public;

grant execute on function public.appshare_settings_status()                      to anon, authenticated;
grant execute on function public.appshare_settings_init(text, text)             to anon, authenticated;
grant execute on function public.appshare_settings_unlock(text)                 to anon, authenticated;
grant execute on function public.appshare_staff_add(text, text, text)           to anon, authenticated;
grant execute on function public.appshare_app_add(text, text, text, text, text) to anon, authenticated;

grant execute on function public.appshare_settings_session_ok(text) to service_role;
grant execute on function public.appshare_settings_issue(uuid)      to service_role;

-- 内部関数は引き続きブラウザから実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
grant execute on function public.appshare_session_staff(text) to service_role;
