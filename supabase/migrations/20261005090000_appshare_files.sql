-- 説明資料専用。既存の職員・設定セッション検証をEdge Functionから利用する。
-- shortstay側のテーブル・関数・Storageは変更しない。
begin;

create table public.appshare_files (
  id uuid primary key default gen_random_uuid(),
  -- 資料の処理中・未回収の行があればアプリ削除を止める（直接RPCや同時アップロード対策）。
  app_id uuid not null references public.appshare_apps(id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 255),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  uploaded_by uuid references public.appshare_staff(id) on delete set null
);

create index appshare_files_app_created_idx on public.appshare_files(app_id, created_at);
create index appshare_files_pending_created_idx on public.appshare_files(created_at) where status = 'pending';
alter table public.appshare_files enable row level security;
revoke all on table public.appshare_files from public, anon, authenticated;
grant select, insert, update, delete on table public.appshare_files to service_role;

-- 非公開。ブラウザ向けStorageの許可ポリシーは追加しない。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('appshare-files', 'appshare-files', false, 10485760, array['application/pdf']);

-- 共用プロジェクトに広い許可ポリシーがあっても、この新規バケットだけは直接アクセス不可。
-- 他バケットでは常にtrueとなるため、既存Storageの権限には影響しない。
create policy appshare_files_no_direct_access on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'appshare-files')
  with check (bucket_id <> 'appshare-files');

-- 既存の内部関数だけを使用。Supabase Authには依存しない。
grant execute on function public.appshare_session_staff(text) to service_role;
grant execute on function public.appshare_settings_session_ok(text) to service_role;

commit;
