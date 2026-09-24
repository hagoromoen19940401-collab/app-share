-- =========================================================
-- app-share : コメントの編集・削除・確認
--
-- ・編集 / 削除 … 投稿した本人のみ。セッショントークンから本人確認する
-- ・確認       … 職員が「確認しました」を押した記録。同じ人は1件だけ
--
-- テーブルへの直接アクセスは引き続き禁止し、RPC経由のみとする。
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. コメントに「編集した日時」を追加
--    null のままなら未編集
-- ---------------------------------------------------------
alter table public.appshare_comments
  add column if not exists edited_at timestamptz;

comment on column public.appshare_comments.edited_at is '編集した日時。未編集なら null';

-- ---------------------------------------------------------
-- 2. 確認の記録
--    comment_id + staff_id を主キーにすることで、
--    同じ職員が何度押しても1件しか登録されない
-- ---------------------------------------------------------
create table if not exists public.appshare_comment_reads (
  comment_id   uuid        not null references public.appshare_comments (id) on delete cascade,
  staff_id     uuid        not null references public.appshare_staff (id)    on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (comment_id, staff_id)
);

comment on table public.appshare_comment_reads is '職員が「確認しました」を押した記録';

create index if not exists appshare_comment_reads_staff_id_idx
  on public.appshare_comment_reads (staff_id);

alter table public.appshare_comment_reads enable row level security;
-- ポリシーは作らない = 直接アクセス不可。RPC経由のみ。

revoke all on table public.appshare_comment_reads from anon, authenticated;

-- ---------------------------------------------------------
-- 3. コメント取得
--    既存の appshare_comments_list に列を追加する。
--    戻り値の形が変わるため、いったん削除して作り直す
--    （名前と引数は同じなので、呼び出し側の変更は不要）
--
--    追加する列
--      edited_at       編集した日時
--      confirm_count   確認した職員の人数
--      confirmed_by_me 自分が確認済みかどうか
--      is_mine         自分の投稿かどうか（編集・削除ボタンの表示用）
--
--    ※ 取得順は従来どおり「最新200件を取り、古い→新しい順で返す」
-- ---------------------------------------------------------
drop function if exists public.appshare_comments_list(text, text, integer);

create function public.appshare_comments_list(
  p_token  text,
  p_app_id text,
  p_limit  integer default 200
)
returns table (id uuid, app_id text, author text, body text,
               status text, created_at timestamptz, staff_id uuid,
               edited_at timestamptz, confirm_count integer,
               confirmed_by_me boolean, is_mine boolean)
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
           q.status, q.created_at, q.staff_id,
           q.edited_at, q.confirm_count, q.confirmed_by_me, q.is_mine
      from (
        select c.id, c.app_id, c.author, c.body,
               c.status, c.created_at, c.staff_id, c.edited_at,
               (select count(*)::integer
                  from public.appshare_comment_reads r
                 where r.comment_id = c.id) as confirm_count,
               exists (select 1
                         from public.appshare_comment_reads r2
                        where r2.comment_id = c.id
                          and r2.staff_id = v_staff_id) as confirmed_by_me,
               (c.staff_id is not null and c.staff_id = v_staff_id) as is_mine
          from public.appshare_comments c
         where c.app_id = p_app_id
         order by c.created_at desc, c.id desc
         limit greatest(1, least(coalesce(p_limit, 200), 500))
      ) q
     order by q.created_at asc, q.id asc;
end;
$$;

-- ---------------------------------------------------------
-- 4. コメントの編集（投稿した本人のみ）
-- ---------------------------------------------------------
create or replace function public.appshare_comment_update(
  p_token      text,
  p_comment_id uuid,
  p_body       text
)
returns table (ok boolean, message text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_owner    uuid;
  v_body     text;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    return query select false, 'コメントが入力されていません'::text;
    return;
  end if;
  if length(v_body) > 2000 then
    return query select false, 'コメントが長すぎます（2000文字まで）'::text;
    return;
  end if;

  select c.staff_id into v_owner
    from public.appshare_comments c
   where c.id = p_comment_id
   for update;

  if not found then
    return query select false, 'コメントが見つかりません'::text;
    return;
  end if;

  -- 投稿した本人だけが編集できる
  if v_owner is null or v_owner <> v_staff_id then
    return query select false, '自分が投稿したコメントだけ編集できます'::text;
    return;
  end if;

  update public.appshare_comments c
     set body = v_body,
         edited_at = now()
   where c.id = p_comment_id;

  return query select true, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 5. コメントの削除（投稿した本人のみ）
--    確認の記録は外部キーの連動削除で一緒に消える
-- ---------------------------------------------------------
create or replace function public.appshare_comment_delete(
  p_token      text,
  p_comment_id uuid
)
returns table (ok boolean, message text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_owner    uuid;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  select c.staff_id into v_owner
    from public.appshare_comments c
   where c.id = p_comment_id
   for update;

  if not found then
    return query select false, 'コメントが見つかりません'::text;
    return;
  end if;

  if v_owner is null or v_owner <> v_staff_id then
    return query select false, '自分が投稿したコメントだけ削除できます'::text;
    return;
  end if;

  delete from public.appshare_comments c where c.id = p_comment_id;

  return query select true, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 6. 「確認しました」の記録
--    同じ職員が何度押しても1件だけ（主キーで重複を防ぐ）
-- ---------------------------------------------------------
create or replace function public.appshare_comment_confirm(
  p_token      text,
  p_comment_id uuid
)
returns table (ok boolean, message text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_owner    uuid;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  select c.staff_id into v_owner
    from public.appshare_comments c
   where c.id = p_comment_id;

  if not found then
    return query select false, 'コメントが見つかりません'::text;
    return;
  end if;

  -- 自分の投稿は確認の対象外
  if v_owner is not null and v_owner = v_staff_id then
    return query select false, '自分の投稿は確認の対象外です'::text;
    return;
  end if;

  insert into public.appshare_comment_reads (comment_id, staff_id)
  values (p_comment_id, v_staff_id)
  on conflict (comment_id, staff_id) do nothing;

  return query select true, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 7. 確認した職員の一覧
--    ログイン中の職員なら誰でも見られる
-- ---------------------------------------------------------
create or replace function public.appshare_comment_confirmed_list(
  p_token      text,
  p_comment_id uuid
)
returns table (staff_name text, confirmed_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  return query
    select s.display_name, r.confirmed_at
      from public.appshare_comment_reads r
      join public.appshare_staff s on s.id = r.staff_id
     where r.comment_id = p_comment_id
     order by r.confirmed_at;
end;
$$;

-- ---------------------------------------------------------
-- 8. 実行権限
--    追加した4本も anon / authenticated から実行できるようにする
--    （本人確認はすべて関数の中で行う）
-- ---------------------------------------------------------
revoke all on function public.appshare_comments_list(text, text, integer)        from public;
revoke all on function public.appshare_comment_update(text, uuid, text)          from public;
revoke all on function public.appshare_comment_delete(text, uuid)                from public;
revoke all on function public.appshare_comment_confirm(text, uuid)               from public;
revoke all on function public.appshare_comment_confirmed_list(text, uuid)        from public;

grant execute on function public.appshare_comments_list(text, text, integer)     to anon, authenticated;
grant execute on function public.appshare_comment_update(text, uuid, text)       to anon, authenticated;
grant execute on function public.appshare_comment_delete(text, uuid)             to anon, authenticated;
grant execute on function public.appshare_comment_confirm(text, uuid)            to anon, authenticated;
grant execute on function public.appshare_comment_confirmed_list(text, uuid)     to anon, authenticated;

-- 内部関数は引き続き外部から実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
