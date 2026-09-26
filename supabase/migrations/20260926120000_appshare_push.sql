-- =========================================================
-- あぷりんく : 新着チャットのプッシュ通知（Web Push）
--
-- ・通知を受け取る端末（Push Subscription）を職員ごと・端末ごとに保存する
-- ・登録／解除は職員ログインだけで行える（設定パスワードは不要）
-- ・送信は Edge Function（appshare-push）が service_role で行う
-- ・同じコメントで2回通知しないよう、appshare_comments.push_sent_at を使う
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. 通知を受け取る端末
--    職員を削除すると、その職員の端末も一緒に消える
-- ---------------------------------------------------------
create table if not exists public.appshare_push_subscriptions (
  id         uuid        primary key default gen_random_uuid(),
  staff_id   uuid        not null references public.appshare_staff (id) on delete cascade,
  endpoint   text        not null unique,
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table  public.appshare_push_subscriptions          is 'チャット通知を受け取る端末（1端末1行）';
comment on column public.appshare_push_subscriptions.endpoint is 'プッシュサービスの宛先URL。端末ごとに一意';

create index if not exists appshare_push_subscriptions_staff_idx
  on public.appshare_push_subscriptions (staff_id);

alter table public.appshare_push_subscriptions enable row level security;
-- ポリシーは作らない = 直接アクセス不可。RPC経由のみ。
revoke all on table public.appshare_push_subscriptions from anon, authenticated;

-- ---------------------------------------------------------
-- 2. 通知済みの目印
-- ---------------------------------------------------------
alter table public.appshare_comments
  add column if not exists push_sent_at timestamptz;

comment on column public.appshare_comments.push_sent_at is 'プッシュ通知を送った日時。同じコメントで2回送らないために使う';

-- ---------------------------------------------------------
-- 3. 端末の登録（ログイン中の本人のみ）
--    同じ端末で別の職員が登録した場合は、その職員に付け替える
-- ---------------------------------------------------------
create or replace function public.appshare_push_subscribe(
  p_token    text,
  p_endpoint text,
  p_p256dh   text,
  p_auth     text
)
returns table (ok boolean, message text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  -- 未ログイン・期限切れならここで停止
  v_staff_id := public.appshare_session_staff(p_token);

  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or length(p_p256dh) > 200
     or coalesce(p_auth, '')   = '' or length(p_auth)   > 100 then
    return query select false, '通知の登録情報が正しくありません'::text;
    return;
  end if;

  insert into public.appshare_push_subscriptions (staff_id, endpoint, p256dh, auth)
  values (v_staff_id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set staff_id   = excluded.staff_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        updated_at = now();

  return query select true, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 4. 端末の登録解除（ログイン中の本人の端末のみ）
-- ---------------------------------------------------------
create or replace function public.appshare_push_unsubscribe(
  p_token    text,
  p_endpoint text
)
returns table (ok boolean, message text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  delete from public.appshare_push_subscriptions s
   where s.endpoint = p_endpoint
     and s.staff_id = v_staff_id;

  return query select true, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 5. 通知の対象を取り出す（Edge Function 専用）
--    ・投稿した本人のトークンであること
--    ・まだ通知していないこと（ここで通知済みにする）
--    ・投稿から10分以内であること
--    を満たすときだけ、投稿者以外の職員の端末を返す
-- ---------------------------------------------------------
create or replace function public.appshare_push_claim(
  p_token      text,
  p_comment_id uuid
)
returns table (author text, endpoint text, p256dh text, auth text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_staff_id uuid;
  v_author   text;
begin
  v_staff_id := public.appshare_session_staff(p_token);

  update public.appshare_comments c
     set push_sent_at = now()
   where c.id = p_comment_id
     and c.staff_id = v_staff_id
     and c.push_sent_at is null
     and c.created_at > now() - interval '10 minutes'
  returning c.author into v_author;

  if not found then
    return;
  end if;

  return query
    select v_author, s.endpoint, s.p256dh, s.auth
      from public.appshare_push_subscriptions s
     where s.staff_id <> v_staff_id;
end;
$$;

-- ---------------------------------------------------------
-- 6. 無効になった端末を消す（Edge Function 専用）
-- ---------------------------------------------------------
create or replace function public.appshare_push_forget(p_endpoints text[])
returns void
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  delete from public.appshare_push_subscriptions s
   where s.endpoint = any (p_endpoints);
$$;

-- ---------------------------------------------------------
-- 実行権限
-- ---------------------------------------------------------
revoke all on function public.appshare_push_subscribe(text, text, text, text) from public;
revoke all on function public.appshare_push_unsubscribe(text, text)          from public;
revoke all on function public.appshare_push_claim(text, uuid)                from public, anon, authenticated;
revoke all on function public.appshare_push_forget(text[])                   from public, anon, authenticated;

grant execute on function public.appshare_push_subscribe(text, text, text, text) to anon, authenticated;
grant execute on function public.appshare_push_unsubscribe(text, text)          to anon, authenticated;
grant execute on function public.appshare_push_claim(text, uuid)                to service_role;
grant execute on function public.appshare_push_forget(text[])                   to service_role;

-- 内部関数は引き続きブラウザから実行できないようにする
revoke all on function public.appshare_session_staff(text) from public, anon, authenticated;
grant execute on function public.appshare_session_staff(text) to service_role;
