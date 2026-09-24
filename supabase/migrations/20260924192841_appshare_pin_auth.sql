-- =========================================================
-- app-share : 職員PIN認証とコメント共有
--
-- 方式 : 職員名を選ぶ → 4桁PIN → セッショントークン(12時間)
--        テーブルへの直接アクセスは禁止し、RPC経由のみとする
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- 何度実行しても同じ結果になるよう if exists / if not exists を使用する。
-- =========================================================

-- ---------------------------------------------------------
-- 1. 職員マスタ : 総当たり対策と並び順の列を追加
-- ---------------------------------------------------------
alter table public.appshare_staff
  add column if not exists failed_count integer     not null default 0,
  add column if not exists locked_until timestamptz,
  add column if not exists sort_order   integer     not null default 0;

comment on column public.appshare_staff.failed_count is 'PIN連続失敗回数。成功時とロック解除後に0へ戻る';
comment on column public.appshare_staff.locked_until is 'この時刻までPIN入力を受け付けない';
comment on column public.appshare_staff.sort_order   is '職員一覧の並び順';

-- ---------------------------------------------------------
-- 2. セッション : 今回の方式に合わせて作り直す（0件前提）
--    依存関係が残っていれば drop が失敗するよう cascade は付けない
-- ---------------------------------------------------------
drop table if exists public.appshare_staff_sessions;

create table public.appshare_staff_sessions (
  id         uuid        primary key default gen_random_uuid(),
  staff_id   uuid        not null references public.appshare_staff (id) on delete cascade,
  token_hash text        not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table  public.appshare_staff_sessions            is 'PIN確認後のセッション。トークン本体は保存しない';
comment on column public.appshare_staff_sessions.token_hash is 'セッショントークンのSHA-256ハッシュ';

create index appshare_staff_sessions_staff_id_idx   on public.appshare_staff_sessions (staff_id);
create index appshare_staff_sessions_expires_at_idx on public.appshare_staff_sessions (expires_at);

alter table public.appshare_staff_sessions enable row level security;
-- ポリシーは作らない = 直接アクセス不可。RPC経由のみ。

-- ---------------------------------------------------------
-- 3. コメント : 投稿者を確定させる staff_id を追加
--    author は投稿時点の氏名のスナップショットとして残す
--    user_id は互換性のため残す（今回は使用しない）
-- ---------------------------------------------------------
alter table public.appshare_comments
  add column if not exists staff_id uuid references public.appshare_staff (id) on delete set null;

comment on column public.appshare_comments.staff_id is '投稿した職員。なりすまし防止のためサーバー側で設定する';
comment on column public.appshare_comments.author   is '投稿時点の職員名のスナップショット';

create index if not exists appshare_comments_app_id_created_at_idx
  on public.appshare_comments (app_id, created_at);

-- ---------------------------------------------------------
-- 4. 直接アクセスの遮断
--    (a) 以前作成した appshare_* のRLSポリシーを削除する
--        対象テーブルを名前で限定しているため shortstay 側には影響しない
-- ---------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in (
             'appshare_staff',
             'appshare_staff_sessions',
             'appshare_comments',
             'appshare_profiles'
           )
  loop
    execute format('drop policy if exists %I on %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  end loop;
end;
$$;

-- (b) RLSを有効化（ポリシーが無い = 誰も直接アクセスできない）
alter table public.appshare_staff    enable row level security;
alter table public.appshare_comments enable row level security;
alter table public.appshare_profiles enable row level security;

-- (c) テーブルへの直接権限を剥奪（anonキーは公開情報のため必須）
revoke all on table public.appshare_staff          from anon, authenticated;
revoke all on table public.appshare_staff_sessions from anon, authenticated;
revoke all on table public.appshare_comments       from anon, authenticated;
revoke all on table public.appshare_profiles       from anon, authenticated;  -- 今回未使用

-- ---------------------------------------------------------
-- 5. 内部関数 : トークンを検証して職員IDを返す
--    anon / authenticated のどちらにも実行権限を与えない
-- ---------------------------------------------------------
create or replace function public.appshare_session_staff(p_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'ログインが必要です' using errcode = '28000';
  end if;

  select s.staff_id into v_staff_id
    from public.appshare_staff_sessions s
    join public.appshare_staff st on st.id = s.staff_id
   where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and s.expires_at > now()
     and st.is_active;

  if v_staff_id is null then
    raise exception 'ログインが必要です' using errcode = '28000';
  end if;

  return v_staff_id;
end;
$$;

-- ---------------------------------------------------------
-- 6. 職員一覧（PIN関連は一切返さない）
-- ---------------------------------------------------------
create or replace function public.appshare_staff_list()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select s.id, s.display_name
    from public.appshare_staff s
   where s.is_active
   order by s.sort_order, s.display_name;
$$;

-- ---------------------------------------------------------
-- 7. ログイン : PIN照合 → セッショントークン発行
--    失敗時に例外を投げると失敗回数の記録も巻き戻るため、
--    戻り値で成否を返す
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
  -- 期限切れセッションの掃除
  delete from public.appshare_staff_sessions where expires_at < now();

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
-- 8. コメント取得（確認済み職員のみ）
--    DBからは最新200件を取得し、返却時は古い→新しい順に並べ直す
-- ---------------------------------------------------------
create or replace function public.appshare_comments_list(
  p_token  text,
  p_app_id text,
  p_limit  integer default 200
)
returns table (id uuid, app_id text, author text, body text,
               status text, created_at timestamptz, staff_id uuid)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  v_staff_id := public.appshare_session_staff(p_token);   -- 未ログインならここで停止

  if p_app_id is null or btrim(p_app_id) = '' then
    raise exception 'アプリが指定されていません';
  end if;

  return query
    select q.id, q.app_id, q.author, q.body,
           q.status, q.created_at, q.staff_id
      from (
        select c.id, c.app_id, c.author, c.body,
               c.status, c.created_at, c.staff_id
          from public.appshare_comments c
         where c.app_id = p_app_id
         order by c.created_at desc, c.id desc
         limit greatest(1, least(coalesce(p_limit, 200), 500))
      ) q
     order by q.created_at asc, q.id asc;
end;
$$;

-- ---------------------------------------------------------
-- 9. コメント投稿（確認済み職員のみ / 投稿者はサーバー側で決定）
-- ---------------------------------------------------------
create or replace function public.appshare_comment_add(
  p_token  text,
  p_app_id text,
  p_body   text
)
returns table (id uuid, app_id text, author text, body text,
               status text, created_at timestamptz, staff_id uuid)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_name     text;
  v_body     text;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'コメントが入力されていません';
  end if;
  if length(v_body) > 2000 then
    raise exception 'コメントが長すぎます（2000文字まで）';
  end if;
  if p_app_id is null or btrim(p_app_id) = '' then
    raise exception 'アプリが指定されていません';
  end if;

  select s.display_name into v_name
    from public.appshare_staff s where s.id = v_staff_id;

  return query
  insert into public.appshare_comments (app_id, author, body, status, staff_id)
  values (p_app_id, v_name, v_body, 'pending', v_staff_id)
  returning appshare_comments.id, appshare_comments.app_id, appshare_comments.author,
            appshare_comments.body, appshare_comments.status,
            appshare_comments.created_at, appshare_comments.staff_id;
end;
$$;

-- ---------------------------------------------------------
-- 10. 実行権限 : 必要な4本だけを anon と authenticated に許可
--     （共用プロジェクトのため、Authセッションがある状態でも動くようにする）
-- ---------------------------------------------------------
revoke all on function public.appshare_session_staff(text)                from public;
revoke all on function public.appshare_staff_list()                       from public;
revoke all on function public.appshare_login(uuid, text)                  from public;
revoke all on function public.appshare_comments_list(text, text, integer) from public;
revoke all on function public.appshare_comment_add(text, text, text)      from public;

grant execute on function public.appshare_staff_list()                       to anon, authenticated;
grant execute on function public.appshare_login(uuid, text)                  to anon, authenticated;
grant execute on function public.appshare_comments_list(text, text, integer) to anon, authenticated;
grant execute on function public.appshare_comment_add(text, text, text)      to anon, authenticated;
-- appshare_session_staff は内部専用のため、どちらのロールにも渡さない
