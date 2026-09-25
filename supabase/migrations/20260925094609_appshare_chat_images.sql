-- =========================================================
-- あぷりんく : チャットへの写真添付
--
-- 写真そのものは Supabase Storage の非公開バケットに置く。
-- データベースには「置き場所（パス）」だけを記録する。
-- base64 や本文への埋め込みは行わない。
--
-- ブラウザは Storage に直接アクセスしない。
-- Edge Function（appshare-chat-image）だけが service_role で読み書きし、
-- その中で appshare_staff_sessions のトークンを検証する。
--
-- 対象は appshare_* のみ。shortstay_* と既存バケットには一切触れない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. コメントに写真の情報を追加（すべてNULL可能）
--    既存の文章だけのコメントはそのまま表示できる
-- ---------------------------------------------------------
alter table public.appshare_comments
  add column if not exists image_path text,
  add column if not exists image_mime text,
  add column if not exists image_size integer;

comment on column public.appshare_comments.image_path is 'Storage内のパス。写真なしは null';
comment on column public.appshare_comments.image_mime is '画像の種類（image/jpeg など）';
comment on column public.appshare_comments.image_size is '保存した画像の大きさ（バイト）';

create index if not exists appshare_comments_image_path_idx
  on public.appshare_comments (image_path)
  where image_path is not null;

-- ---------------------------------------------------------
-- 2. 非公開バケットの作成
--    public = false。ポリシーは作らないため、
--    anon / authenticated からは読み書きできない。
--    既存のバケットには触れない（id が一致したときは何もしない）
-- ---------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'appshare-chat-images',
  'appshare-chat-images',
  false,
  3145728,                                            -- 3MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------
-- 3. コメント取得（写真の情報を追加）
--    引数と取得順は従来どおり
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
               image_path text, image_mime text, image_size integer)
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
           q.image_path, q.image_mime, q.image_size
      from (
        select c.id, c.app_id, c.author, c.body,
               c.status, c.created_at, c.staff_id, c.edited_at,
               c.image_path, c.image_mime, c.image_size,
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
-- 4. 写真つきコメントの投稿
--    ブラウザからは呼べない（service_role だけに許可）。
--    Edge Function が写真を保存したあとに呼ぶ。
--    画像のパスをブラウザが自由に指定できないようにするため、
--    既存の appshare_comment_add とは分けている。
-- ---------------------------------------------------------
create or replace function public.appshare_comment_add_image(
  p_token      text,
  p_app_id     text,
  p_body       text,
  p_image_path text,
  p_image_mime text,
  p_image_size integer
)
returns table (id uuid, app_id text, author text, body text,
               status text, created_at timestamptz, staff_id uuid,
               image_path text, image_mime text, image_size integer)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_name     text;
  v_body     text;
  v_path     text;
begin
  -- Edge Function 経由でも、必ずセッションを検証する
  v_staff_id := public.appshare_session_staff(p_token);

  v_body := btrim(coalesce(p_body, ''));
  v_path := btrim(coalesce(p_image_path, ''));

  if v_path = '' then
    raise exception '写真が指定されていません';
  end if;
  if v_path !~ ('^' || v_staff_id::text || '/') then
    raise exception '写真の置き場所が正しくありません';   -- 他人の場所には置けない
  end if;
  if length(v_body) > 2000 then
    raise exception 'コメントが長すぎます（2000文字まで）';
  end if;
  if p_app_id is null or btrim(p_app_id) = '' then
    raise exception 'アプリが指定されていません';
  end if;
  if p_image_mime is null or p_image_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception '対応していない画像の種類です';
  end if;
  if p_image_size is null or p_image_size <= 0 or p_image_size > 3145728 then
    raise exception '写真の大きさが上限を超えています（3MBまで）';
  end if;

  select s.display_name into v_name
    from public.appshare_staff s where s.id = v_staff_id;

  return query
  insert into public.appshare_comments
    (app_id, author, body, status, staff_id, image_path, image_mime, image_size)
  values
    (p_app_id, v_name, v_body, 'pending', v_staff_id, v_path, p_image_mime, p_image_size)
  returning appshare_comments.id, appshare_comments.app_id, appshare_comments.author,
            appshare_comments.body, appshare_comments.status,
            appshare_comments.created_at, appshare_comments.staff_id,
            appshare_comments.image_path, appshare_comments.image_mime,
            appshare_comments.image_size;
end;
$$;

-- ---------------------------------------------------------
-- 5. コメントの削除（写真のパスも返す）
--    投稿した本人のみ。返したパスをもとに、
--    Edge Function が Storage の写真を消す
-- ---------------------------------------------------------
drop function if exists public.appshare_comment_delete(text, uuid);

create function public.appshare_comment_delete(
  p_token      text,
  p_comment_id uuid
)
returns table (ok boolean, message text, image_path text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_owner    uuid;
  v_path     text;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  select c.staff_id, c.image_path into v_owner, v_path
    from public.appshare_comments c
   where c.id = p_comment_id
   for update;

  if not found then
    return query select false, 'コメントが見つかりません'::text, null::text;
    return;
  end if;

  if v_owner is null or v_owner <> v_staff_id then
    return query select false, '自分が投稿したコメントだけ削除できます'::text, null::text;
    return;
  end if;

  delete from public.appshare_comments c where c.id = p_comment_id;

  return query select true, null::text, v_path;
end;
$$;

-- ---------------------------------------------------------
-- 6. コメントの編集
--    写真つきコメントは本文が空でも保存できるようにする
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
  v_image    text;
  v_body     text;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  v_body := btrim(coalesce(p_body, ''));
  if length(v_body) > 2000 then
    return query select false, 'コメントが長すぎます（2000文字まで）'::text;
    return;
  end if;

  select c.staff_id, c.image_path into v_owner, v_image
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

  -- 写真がない場合は、本文を空にできない
  if v_body = '' and v_image is null then
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
-- 7. 写真がまだ使われているかの確認
--    Edge Function が Storage から消す前に呼ぶ。
--    どのコメントからも参照されていない写真だけ削除できるようにする
-- ---------------------------------------------------------
create or replace function public.appshare_image_in_use(p_image_path text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.appshare_comments c
     where c.image_path = p_image_path
  );
$$;

-- ---------------------------------------------------------
-- 8. 実行権限
--    ・一覧と削除と編集 … これまでどおり anon / authenticated
--    ・写真つき投稿と使用確認 … service_role のみ（Edge Function用）
-- ---------------------------------------------------------
revoke all on function public.appshare_comments_list(text, text, integer)              from public;
revoke all on function public.appshare_comment_delete(text, uuid)                      from public;
revoke all on function public.appshare_comment_update(text, uuid, text)                from public;
revoke all on function public.appshare_comment_add_image(text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.appshare_image_in_use(text)                              from public, anon, authenticated;

grant execute on function public.appshare_comments_list(text, text, integer)   to anon, authenticated, service_role;
grant execute on function public.appshare_comment_delete(text, uuid)           to anon, authenticated, service_role;
grant execute on function public.appshare_comment_update(text, uuid, text)     to anon, authenticated, service_role;
grant execute on function public.appshare_comment_add_image(text, text, text, text, text, integer) to service_role;
grant execute on function public.appshare_image_in_use(text)                   to service_role;

-- 内部関数は引き続きブラウザから実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
grant execute on function public.appshare_session_staff(text) to service_role;
