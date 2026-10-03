-- =========================================================
-- あぷりんく : プッシュ通知に載せる未読合計（アプリアイコンのバッジ用）
--
-- Edge Function（appshare-push）が、通知を送る端末ごとの未読合計を取り出す。
-- 数え方は appshare_unread_counts と同じ（全体チャット＋公開中アプリ）。
-- 未読管理をまだ始めていない職員の端末は返さない（件数を付けずに通知する）。
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- =========================================================

create or replace function public.appshare_push_unread_totals(p_endpoints text[])
returns table (endpoint text, unread_total integer)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select s.endpoint,
         (
           select count(*)::integer
             from public.appshare_comments c
            where c.staff_id is distinct from s.staff_id
              and c.created_at > coalesce(
                    (select p.read_at
                       from public.appshare_comment_read_positions p
                      where p.staff_id = s.staff_id
                        and p.app_id = c.app_id),
                    u.initialized_at
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
         )
    from public.appshare_push_subscriptions s
    join public.appshare_unread_staff u on u.staff_id = s.staff_id
   where s.endpoint = any (p_endpoints);
$$;

revoke all on function public.appshare_push_unread_totals(text[]) from public, anon, authenticated;
grant execute on function public.appshare_push_unread_totals(text[]) to service_role;
