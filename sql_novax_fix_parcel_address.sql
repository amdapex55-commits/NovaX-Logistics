-- ============================================================================
-- Let admin write a missing consignee address/phone back onto a parcel.
-- SECURITY DEFINER + explicit admin role check, so it cannot be called by a
-- merchant. Refuses to overwrite a value that is already present -- this is a
-- repair tool, not an edit tool.
-- ============================================================================
create or replace function public.admin_fix_parcel_contact(
  p_awb text, p_address text, p_phone text
)
returns json
language plpgsql security definer set search_path = public
as $fn$
declare v_ok boolean; v_hit int;
begin
  select exists(select 1 from public.profiles pr
                where pr.id = auth.uid()
                  and lower(pr.role::text) in ('admin','owner','superadmin','ops','ops manager'))
    into v_ok;
  if not v_ok then raise exception 'Admin access required.'; end if;

  update public.parcels
  set address = case when coalesce(address,'') = '' and coalesce(btrim(p_address),'') <> ''
                     then btrim(p_address) else address end,
      phone   = case when coalesce(phone,'')   = '' and coalesce(btrim(p_phone),'')   <> ''
                     then btrim(p_phone) else phone end,
      updated_at = now()
  where awb = upper(btrim(p_awb));

  get diagnostics v_hit = row_count;
  if v_hit = 0 then raise exception 'AWB % not found.', p_awb; end if;
  return json_build_object('ok', true);
end;
$fn$;

revoke all on function public.admin_fix_parcel_contact(text, text, text) from public;
grant execute on function public.admin_fix_parcel_contact(text, text, text) to authenticated;
