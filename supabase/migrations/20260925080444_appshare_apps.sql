-- =========================================================
-- あぷりんく : アプリの登録
--
-- 設定 → アプリ管理 から、職員が共有したいWebアプリを登録できるようにする。
-- 今回は 名前 / URL / 説明 だけ。アイコン・バージョン・並び替え・
-- 編集・削除は作らない。
--
-- テーブルへの直接アクセスは引き続き禁止し、RPC経由のみとする。
-- 一覧の取得も登録も、ログイン中の職員だけが行える。
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. アプリの一覧
-- ---------------------------------------------------------
create table if not exists public.appshare_apps (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  url         text        not null,
  description text        not null default '',
  is_active   boolean     not null default true,
  created_by  uuid        references public.appshare_staff (id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table  public.appshare_apps            is '共有するWebアプリの一覧';
comment on column public.appshare_apps.url        is 'アプリのURL。http:// または https:// で始まるもの';
comment on column public.appshare_apps.is_active  is 'false にすると一覧に出さない（今回は画面から操作しない）';
comment on column public.appshare_apps.created_by is '登録した職員。サーバー側で設定する';

create index if not exists appshare_apps_active_created_at_idx
  on public.appshare_apps (is_active, created_at);

alter table public.appshare_apps enable row level security;
-- ポリシーは作らない = 直接アクセス不可。RPC経由のみ。

revoke all on table public.appshare_apps from anon, authenticated;

-- ---------------------------------------------------------
-- 2. アプリ一覧の取得（ログイン中の職員のみ）
--    公開中（is_active = true）のアプリを登録順で返す
--    未ログイン・期限切れ・無効なトークンの場合は一覧を返さない
-- ---------------------------------------------------------
create or replace function public.appshare_apps_list(p_token text)
returns table (id uuid, name text, url text, description text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  -- 未ログイン・期限切れ・無効なトークンならここで停止する
  v_staff_id := public.appshare_session_staff(p_token);

  return query
    select a.id, a.name, a.url, a.description, a.created_at
      from public.appshare_apps a
     where a.is_active
     order by a.created_at;
end;
$$;

-- ---------------------------------------------------------
-- 3. アプリの登録
--    ログイン中の職員のみ。created_by はサーバー側で決める
-- ---------------------------------------------------------
create or replace function public.appshare_app_add(
  p_token       text,
  p_name        text,
  p_url         text,
  p_description text default ''
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
  -- 未ログイン・期限切れならここで停止する
  v_staff_id := public.appshare_session_staff(p_token);

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

  -- created_by と is_active はサーバー側で決める（ブラウザからは指定できない）
  insert into public.appshare_apps (name, url, description, is_active, created_by)
  values (v_name, v_url, v_desc, true, v_staff_id)
  returning appshare_apps.id into v_id;

  return query select true, null::text, v_id, v_name;
end;
$$;

-- ---------------------------------------------------------
-- 4. 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_apps_list(text)                  from public;
revoke all on function public.appshare_app_add(text, text, text, text)  from public;

grant execute on function public.appshare_apps_list(text)                 to anon, authenticated;
grant execute on function public.appshare_app_add(text, text, text, text) to anon, authenticated;

-- 内部関数は引き続き外部から実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
