-- 資料バケットにExcel（.xlsx）のMIMEを追加。10MB上限・非公開は維持。
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]
where id = 'appshare-files';
