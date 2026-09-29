-- Deleting a merchant must delete their logo file too (29 Sep 2026).
-- Storage has no cascade: admin_delete_client removes the clients row (and
-- merchant_brand with it) but the file at merchant-logos/<client_id>/logo
-- stayed behind. Deleting rows from storage.objects in SQL would not remove
-- the file itself, so admin.html removes it through the Storage API right
-- after the account is deleted -- which needs this admin delete permission.
drop policy if exists merchant_logos_admin_delete on storage.objects;
create policy merchant_logos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'merchant-logos' and (select public.is_admin()));
-- A delete only reaches rows the caller can also SELECT (Storage's remove()
-- looks the object up first), so admin needs to be able to see them too.
drop policy if exists merchant_logos_admin_select on storage.objects;
create policy merchant_logos_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'merchant-logos' and (select public.is_admin()));
