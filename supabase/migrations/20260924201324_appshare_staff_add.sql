-- =========================================================
-- app-share : 設定画面からの職員登録
--
-- appshare_staff への直接INSERTは行わず、このRPC経由で登録する。
-- パスワード（4桁数字）は平文で保存せず bcrypt でハッシュ化する。
-- ハッシュはブラウザへ返さない。
--
-- 対象は appshare_* のみ。shortstay_* には一切触れない。
-- 既存のRPC（ログイン / コメント）には変更を加えない。
-- =========================================================

-- ---------------------------------------------------------
-- 1. 表示名の重複を防ぐ
--    関数内でも確認するが、同時に登録された場合に備えて索引でも守る
-- ---------------------------------------------------------
create unique index if not exists appshare_staff_display_name_key
  on public.appshare_staff (display_name);

-- ---------------------------------------------------------
-- 2. 職員の追加
--    戻り値の名前は、テーブルの列名と衝突しないものにする
--    （staff_id / staff_name）
-- ---------------------------------------------------------
create or replace function public.appshare_staff_add(
  p_display_name text,
  p_password     text
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
  -- 前後の空白を削除する
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

  -- 登録順に並ぶよう、現在の最大値に10を足した値を使う
  select coalesce(max(s.sort_order), 0) + 10 into v_order from public.appshare_staff s;

  insert into public.appshare_staff (display_name, pin_hash, is_active, sort_order)
  values (v_name, crypt(p_password, gen_salt('bf', 10)), true, v_order)
  returning appshare_staff.id into v_id;

  -- pin_hash は返さない
  return query select true, null::text, v_id, v_name;

exception
  when unique_violation then
    return query select false, 'この職員名はすでに登録されています'::text, null::uuid, null::text;
end;
$$;

-- ---------------------------------------------------------
-- 3. 実行権限
--    今回は試作運用のため、職員追加に管理者認証は付けない
-- ---------------------------------------------------------
revoke all on function public.appshare_staff_add(text, text) from public;
grant execute on function public.appshare_staff_add(text, text) to anon, authenticated;
