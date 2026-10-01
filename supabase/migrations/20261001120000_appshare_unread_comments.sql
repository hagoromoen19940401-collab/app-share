-- =========================================================
-- app-share : 職員ごとのチャット未読管理
--
-- 独自ログインのセッショントークンをRPCで検証し、テーブルは直接公開しない。
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

create table if not exists public.appshare_unread_staff (
  staff_id      uuid        primary key references public.appshare_staff (id) on delete cascade,
  initialized_at timestamptz not null
);

comment on table public.appshare_unread_staff is
  '職員ごとの未読管理開始時刻。初回導入時はそれ以前のコメントを既読として扱う';

alter table public.appshare_unread_staff enable row level security;
revoke all on table public.appshare_unread_staff from anon, authenticated;

create table if not exists public.appshare_comment_read_positions (
  staff_id uuid        not null references public.appshare_staff (id) on delete cascade,
  app_id   text        not null,
  read_at  timestamptz not null,
  primary key (staff_id, app_id)
);

comment on table public.appshare_comment_read_positions is '職員・チャットごとの既読時刻';

alter table public.appshare_comment_read_positions enable row level security;
revoke all on table public.appshare_comment_read_positions from anon, authenticated;

-- 全チャットの未読件数をまとめて返す。
-- 初回だけ管理開始時刻を現在時刻で作り、それ以前のコメントは未読にしない。
create or replace function public.appshare_unread_counts(p_token text)
returns table (app_id text, unread_count integer)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id  uuid;
  v_initial_at timestamptz;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  insert into public.appshare_unread_staff (staff_id, initialized_at)
  values (v_staff_id, clock_timestamp())
  on conflict (staff_id) do nothing;

  select s.initialized_at into v_initial_at
    from public.appshare_unread_staff s
   where s.staff_id = v_staff_id;

  return query
    select c.app_id, count(*)::integer
      from public.appshare_comments c
     where c.staff_id is distinct from v_staff_id
       and c.created_at > coalesce(
             (select p.read_at
                from public.appshare_comment_read_positions p
               where p.staff_id = v_staff_id
                 and p.app_id = c.app_id),
             v_initial_at
           )
       and (
         c.app_id = '__general__'
         or exists (
           select 1
             from public.appshare_apps a
            where a.id::text = c.app_id
              and a.is_active
         )
       )
     group by c.app_id;
end;
$$;

-- 対応するチャットタブを表示した時点までを既読にする。
create or replace function public.appshare_unread_mark_read(
  p_token  text,
  p_app_id text,
  p_read_at timestamptz
)
returns table (ok boolean, unread_count integer)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_now      timestamptz := clock_timestamp();
  v_initial_at timestamptz;
  v_read_at  timestamptz;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  if p_app_id is null or btrim(p_app_id) = '' then
    raise exception 'アプリが指定されていません';
  end if;

  if p_read_at is null then
    raise exception '既読位置が指定されていません';
  end if;

  if p_app_id <> '__general__'
     and not exists (
       select 1
         from public.appshare_apps a
        where a.id::text = p_app_id
          and a.is_active
     ) then
    raise exception 'アプリが見つかりません';
  end if;

  insert into public.appshare_unread_staff (staff_id, initialized_at)
  values (v_staff_id, v_now)
  on conflict (staff_id) do nothing;

  select s.initialized_at into v_initial_at
    from public.appshare_unread_staff s
   where s.staff_id = v_staff_id;

  v_read_at := greatest(v_initial_at, least(p_read_at, v_now));

  insert into public.appshare_comment_read_positions (staff_id, app_id, read_at)
  values (v_staff_id, p_app_id, v_read_at)
  on conflict (staff_id, app_id) do update
    set read_at = greatest(appshare_comment_read_positions.read_at, excluded.read_at);

  select p.read_at into v_read_at
    from public.appshare_comment_read_positions p
   where p.staff_id = v_staff_id
     and p.app_id = p_app_id;

  return query
    select true, count(*)::integer
      from public.appshare_comments c
     where c.app_id = p_app_id
       and c.staff_id is distinct from v_staff_id
       and c.created_at > v_read_at;
end;
$$;

revoke all on function public.appshare_unread_counts(text) from public;
revoke all on function public.appshare_unread_mark_read(text, text, timestamptz) from public;
grant execute on function public.appshare_unread_counts(text) to anon, authenticated;
grant execute on function public.appshare_unread_mark_read(text, text, timestamptz) to anon, authenticated;
