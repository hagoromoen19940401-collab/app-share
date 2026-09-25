-- =========================================================
-- あぷりんく : チャットの写真を複数枚（最大4枚）に対応
--
-- 写真を列で持つ形（image_path2 など）はやめ、
-- 専用テーブル appshare_comment_images に1枚1行で持つ。
--
-- 1コメント最大4枚は、関数の判定だけでなくテーブルの制約でも守る。
--   ・sort_order は 0〜3 のみ（check）
--   ・同じ comment_id で sort_order が重複しない（unique）
-- この2つにより、どの経路から入れても5枚目は作れない。
--
-- 既存の1枚写真（appshare_comments.image_path）は
--   ・新テーブルへ引き継ぐ（コピー）
--   ・元の列はそのまま残す（すぐには削除しない）
-- 取得時は新テーブルを優先し、無ければ元の列を使う。
--
-- 対象は appshare_* のみ。shortstay_* と既存バケットには一切触れない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. 写真専用テーブル
--    コメントを削除すると、写真の行も連動して消える
-- ---------------------------------------------------------
create table if not exists public.appshare_comment_images (
  id         uuid        primary key default gen_random_uuid(),
  comment_id uuid        not null references public.appshare_comments (id) on delete cascade,
  image_path text        not null unique,
  image_mime text        not null,
  image_size bigint      not null,
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),

  -- 表示順は0〜3のみ
  constraint appshare_comment_images_sort_range check (sort_order between 0 and 3),
  -- 同じコメント内で表示順が重複しない
  constraint appshare_comment_images_comment_sort_key unique (comment_id, sort_order)
);

-- すでにテーブルがある場合に備えて、制約が無ければ追加する
-- （この2つの制約により、どの経路から入れても1コメント5枚以上にはできない）
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'appshare_comment_images_sort_range'
       and conrelid = 'public.appshare_comment_images'::regclass
  ) then
    alter table public.appshare_comment_images
      add constraint appshare_comment_images_sort_range check (sort_order between 0 and 3);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'appshare_comment_images_comment_sort_key'
       and conrelid = 'public.appshare_comment_images'::regclass
  ) then
    alter table public.appshare_comment_images
      add constraint appshare_comment_images_comment_sort_key unique (comment_id, sort_order);
  end if;
end;
$$;

comment on table  public.appshare_comment_images            is 'コメントに添付された写真（1コメント最大4枚）';
comment on column public.appshare_comment_images.image_path is 'Storage内のパス。重複できない';
comment on column public.appshare_comment_images.sort_order is '表示順（0から）';

create index if not exists appshare_comment_images_comment_id_idx
  on public.appshare_comment_images (comment_id, sort_order);

alter table public.appshare_comment_images enable row level security;
-- ポリシーは作らない = 直接アクセス不可。RPC / Edge Function 経由のみ。

revoke all on table public.appshare_comment_images from anon, authenticated;

-- ---------------------------------------------------------
-- 2. 既存の1枚写真を引き継ぐ
--    元の列は消さないので、万一の際は元に戻せる。
--    何度実行しても重複しない
-- ---------------------------------------------------------
insert into public.appshare_comment_images (comment_id, image_path, image_mime, image_size, sort_order)
select c.id,
       c.image_path,
       coalesce(c.image_mime, 'image/jpeg'),
       coalesce(c.image_size, 0),
       0
  from public.appshare_comments c
 where c.image_path is not null
   and not exists (
         select 1 from public.appshare_comment_images i
          where i.image_path = c.image_path
       );

-- ---------------------------------------------------------
-- 3. コメント取得
--    images に写真の配列を入れて返す。
--    新テーブルに無い場合は、元の列から作る（引き継ぎ漏れへの保険）。
--    従来の image_path / image_mime / image_size も残すため、
--    画面を更新する前の状態でも1枚目は表示できる。
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
               confirmed_by_me boolean, is_mine boolean,
               image_path text, image_mime text, image_size integer,
               images jsonb)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  if p_app_id is null or btrim(p_app_id) = '' then
    raise exception 'アプリが指定されていません';
  end if;

  return query
    select q.id, q.app_id, q.author, q.body,
           q.status, q.created_at, q.staff_id,
           q.edited_at, q.confirm_count, q.confirmed_by_me, q.is_mine,
           q.image_path, q.image_mime, q.image_size, q.images
      from (
        select c.id, c.app_id, c.author, c.body,
               c.status, c.created_at, c.staff_id, c.edited_at,
               c.image_path, c.image_mime, c.image_size,
               coalesce(
                 (select jsonb_agg(
                           jsonb_build_object(
                             'path', i.image_path,
                             'mime', i.image_mime,
                             'size', i.image_size
                           )
                           order by i.sort_order, i.created_at
                         )
                    from public.appshare_comment_images i
                   where i.comment_id = c.id),
                 case
                   when c.image_path is not null then
                     jsonb_build_array(
                       jsonb_build_object(
                         'path', c.image_path,
                         'mime', coalesce(c.image_mime, 'image/jpeg'),
                         'size', coalesce(c.image_size, 0)
                       )
                     )
                   else '[]'::jsonb
                 end
               ) as images,
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
-- 4. 写真つきコメントの投稿（複数枚）
--    ブラウザからは呼べない（service_role だけに許可）。
--    p_images の形 : [{"path": "...", "mime": "image/jpeg", "size": 12345}, ...]
-- ---------------------------------------------------------
create or replace function public.appshare_comment_add_images(
  p_token  text,
  p_app_id text,
  p_body   text,
  p_images jsonb
)
returns table (id uuid, app_id text, author text, body text,
               status text, created_at timestamptz, staff_id uuid, images jsonb)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id  uuid;
  v_name      text;
  v_body      text;
  v_count     integer;
  v_comment   uuid;
  v_item      jsonb;
  v_path      text;
  v_mime      text;
  v_size      bigint;
  v_index     integer := 0;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  v_body := btrim(coalesce(p_body, ''));

  if p_images is null or jsonb_typeof(p_images) <> 'array' then
    raise exception '写真が指定されていません';
  end if;

  v_count := jsonb_array_length(p_images);
  if v_count < 1 then
    raise exception '写真が指定されていません';
  end if;
  if v_count > 4 then
    raise exception '写真は1コメントにつき4枚までです';
  end if;
  if length(v_body) > 2000 then
    raise exception 'コメントが長すぎます（2000文字まで）';
  end if;
  if p_app_id is null or btrim(p_app_id) = '' then
    raise exception 'アプリが指定されていません';
  end if;

  select s.display_name into v_name
    from public.appshare_staff s where s.id = v_staff_id;

  insert into public.appshare_comments
    (app_id, author, body, status, staff_id)
  values
    (p_app_id, v_name, v_body, 'pending', v_staff_id)
  returning appshare_comments.id into v_comment;

  for v_item in select * from jsonb_array_elements(p_images)
  loop
    v_path := btrim(coalesce(v_item->>'path', ''));
    v_mime := coalesce(v_item->>'mime', '');
    v_size := coalesce((v_item->>'size')::bigint, 0);

    if v_path = '' then
      raise exception '写真の置き場所が正しくありません';
    end if;
    if v_path !~ ('^' || v_staff_id::text || '/') then
      raise exception '写真の置き場所が正しくありません';   -- 他人の場所には置けない
    end if;
    if v_mime not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception '対応していない画像の種類です';
    end if;
    if v_size <= 0 or v_size > 3145728 then
      raise exception '写真の大きさが上限を超えています（3MBまで）';
    end if;

    if v_index > 3 then
      raise exception '写真は1コメントにつき4枚までです';   -- 念のための二重確認
    end if;

    insert into public.appshare_comment_images
      (comment_id, image_path, image_mime, image_size, sort_order)
    values
      (v_comment, v_path, v_mime, v_size, v_index);

    v_index := v_index + 1;
  end loop;

  return query
    select c.id, c.app_id, c.author, c.body, c.status, c.created_at, c.staff_id,
           coalesce(
             (select jsonb_agg(
                       jsonb_build_object('path', i.image_path, 'mime', i.image_mime, 'size', i.image_size)
                       order by i.sort_order)
                from public.appshare_comment_images i
               where i.comment_id = c.id),
             '[]'::jsonb)
      from public.appshare_comments c
     where c.id = v_comment;
end;
$$;

-- ---------------------------------------------------------
-- 5. コメントの削除（写真のパスをすべて返す）
--    写真の行は連動して消えるため、
--    先にパスを集めてから削除する
-- ---------------------------------------------------------
drop function if exists public.appshare_comment_delete(text, uuid);

create function public.appshare_comment_delete(
  p_token      text,
  p_comment_id uuid
)
returns table (ok boolean, message text, image_path text, image_paths text[])
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_owner    uuid;
  v_legacy   text;
  v_paths    text[];
begin
  v_staff_id := public.appshare_session_staff(p_token);

  select c.staff_id, c.image_path into v_owner, v_legacy
    from public.appshare_comments c
   where c.id = p_comment_id
   for update;

  if not found then
    return query select false, 'コメントが見つかりません'::text, null::text, null::text[];
    return;
  end if;

  if v_owner is null or v_owner <> v_staff_id then
    return query select false, '自分が投稿したコメントだけ削除できます'::text, null::text, null::text[];
    return;
  end if;

  -- 削除前に、紐づく写真のパスをすべて集める
  select coalesce(array_agg(x.path), '{}')
    into v_paths
    from (
      select i.image_path as path
        from public.appshare_comment_images i
       where i.comment_id = p_comment_id
      union
      select v_legacy where v_legacy is not null
    ) x;

  delete from public.appshare_comments c where c.id = p_comment_id;

  return query select true, null::text, v_legacy, v_paths;
end;
$$;

-- ---------------------------------------------------------
-- 6. コメントの編集
--    写真つきコメントは本文が空でも保存できる（新旧どちらの持ち方でも）
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
  v_legacy   text;
  v_images   integer;
  v_body     text;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  v_body := btrim(coalesce(p_body, ''));
  if length(v_body) > 2000 then
    return query select false, 'コメントが長すぎます（2000文字まで）'::text;
    return;
  end if;

  select c.staff_id, c.image_path into v_owner, v_legacy
    from public.appshare_comments c
   where c.id = p_comment_id
   for update;

  if not found then
    return query select false, 'コメントが見つかりません'::text;
    return;
  end if;

  if v_owner is null or v_owner <> v_staff_id then
    return query select false, '自分が投稿したコメントだけ編集できます'::text;
    return;
  end if;

  select count(*)::integer into v_images
    from public.appshare_comment_images i
   where i.comment_id = p_comment_id;

  if v_body = '' and v_images = 0 and v_legacy is null then
    return query select false, 'コメントが入力されていません'::text;
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
-- 7. 写真がまだ使われているかの確認（新旧どちらも見る）
-- ---------------------------------------------------------
create or replace function public.appshare_image_in_use(p_image_path text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.appshare_comment_images i
     where i.image_path = p_image_path
  ) or exists (
    select 1 from public.appshare_comments c
     where c.image_path = p_image_path
  );
$$;

-- ---------------------------------------------------------
-- 8. 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_comments_list(text, text, integer)   from public;
revoke all on function public.appshare_comment_delete(text, uuid)           from public;
revoke all on function public.appshare_comment_update(text, uuid, text)     from public;
revoke all on function public.appshare_comment_add_images(text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.appshare_comments_list(text, text, integer) to anon, authenticated, service_role;
grant execute on function public.appshare_comment_delete(text, uuid)         to anon, authenticated, service_role;
grant execute on function public.appshare_comment_update(text, uuid, text)   to anon, authenticated, service_role;
grant execute on function public.appshare_comment_add_images(text, text, text, jsonb) to service_role;
grant execute on function public.appshare_image_in_use(text)                 to service_role;

-- 内部関数は引き続きブラウザから実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
grant execute on function public.appshare_session_staff(text) to service_role;
