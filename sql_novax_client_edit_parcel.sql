-- =====================================================================
-- NovaX — let a merchant fix their own booking, but only while it is
--         still nothing more than a booking.
--
-- Run in the Supabase SQL Editor. Safe on live traffic: it adds one new
-- function and does not alter any table, policy or existing function.
--
-- WHY AN RPC AND NOT A PLAIN UPDATE FROM THE BROWSER
--
--   Policy parcels_client_upd already lets a merchant UPDATE their own
--   parcel rows, and RLS cannot express "only these columns, and only in
--   this status". A browser-side update would therefore also be able to
--   set fee = 0, or edit a parcel that a rider is already carrying. The
--   browser gate in client.html decides what BUTTON to show; this
--   function is the actual boundary, and it re-checks everything.
--
-- WHAT IT DELIBERATELY WILL NOT DO
--
--   * It never touches `fee`. Delivery charges are not a merchant-editable
--     field -- that was the explicit requirement, and it is also the hole
--     that sql_novax_rls_hardening.sql exists to close.
--   * It never touches status, client_id, awb, invoice_id or tracking_token.
--
-- INTERACTION WITH THE OTHER TRIGGERS ON public.parcels
--
--   trg_nv_protect_parcel_contact (sql_novax_protect_parcel_contact.sql)
--       Silently restores a BLANK address/phone/consignee over a non-blank
--       one. This function rejects blanks up front instead, so the merchant
--       gets a real error message rather than an edit that appears to save
--       and then quietly does nothing.
--
--   trg_nv_log_parcel_contact (same file)
--       Writes every address/phone change to parcel_contact_history with
--       changed_by = auth.uid(). Merchant edits land there automatically --
--       no extra work needed here, and ops keeps a recoverable old value.
--
--   trg_nv_freeze_parcel_money (sql_novax_rls_hardening.sql, NOT YET
--   APPLIED as of this writing)
--       Raises on ANY cod_amount change from a non-admin. That would block
--       this feature outright the day the hardening file is run. The
--       hardening file has been amended in the same commit to allow the
--       change when this function has set the transaction-local flag
--       below AND the parcel is still "New booked". Run order does not
--       matter -- the flag is read at runtime.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Diagnostic. Read-only. Run this FIRST and keep the output.
--    If the edit ever fails with a message that is not one of ours, the
--    answer is almost certainly a trigger listed here.
-- ---------------------------------------------------------------------
select tgname,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t
where t.tgrelid = 'public.parcels'::regclass
  and not t.tgisinternal
order by tgname;


-- ---------------------------------------------------------------------
-- 1. The function
-- ---------------------------------------------------------------------
create or replace function public.client_edit_new_booked_parcel(
  p_awb          text,
  p_consignee    text,
  p_phone        text,
  p_address      text,
  p_city         text,
  p_cod          numeric,
  p_weight       text,
  p_category     text,
  p_fragile      text,
  p_service      text,
  p_payment_mode text,
  p_allow_open   text,
  p_order_id     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_client uuid := public.nv_ai_my_client();
  v_row    public.parcels%rowtype;
  v_meta   jsonb;
  v_hist   jsonb;
  v_len    int;
begin
  if v_client is null then
    raise exception 'You are not signed in as a merchant.' using errcode = '28000';
  end if;

  -- Ownership is resolved from the JWT, never from anything the browser sent.
  select * into v_row
    from public.parcels
   where awb = btrim(p_awb)
     and client_id = v_client
   for update;

  if not found then
    raise exception 'That parcel is not on your account.' using errcode = 'P0002';
  end if;

  -- The same three conditions as delete_new_booked_parcel / the Cancel button.
  if coalesce(v_row.status, '') <> 'New booked' then
    raise exception
      'This parcel is already "%", so it can no longer be edited. Open a support ticket and our team will change it for you.',
      v_row.status
      using errcode = 'P0001';
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel has already been invoiced, so it can no longer be edited.'
      using errcode = 'P0001';
  end if;

  if coalesce(v_row.rider_id::text, '') <> '' then
    raise exception 'A rider is already assigned to collect this parcel, so it can no longer be edited.'
      using errcode = 'P0001';
  end if;

  -- Required fields. Rejected here rather than being silently reverted by
  -- trg_nv_protect_parcel_contact, so the merchant actually sees why.
  if btrim(coalesce(p_consignee, '')) = '' then
    raise exception 'Consignee name cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_phone, '')) = '' then
    raise exception 'Consignee phone cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_address, '')) = '' then
    raise exception 'Delivery address cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_city, '')) = '' then
    raise exception 'Destination city cannot be empty.' using errcode = 'P0001';
  end if;
  if p_cod is null or p_cod < 0 then
    raise exception 'COD amount must be zero or more.' using errcode = 'P0001';
  end if;

  -- ---- audit trail, inside the parcel's own meta -----------------------
  v_meta := coalesce(v_row.meta, '{}'::jsonb);
  v_hist := coalesce(v_meta -> 'editHistory', '[]'::jsonb);

  v_hist := v_hist || jsonb_build_array(jsonb_build_object(
    'at',   to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'by',   auth.uid(),
    'from', jsonb_build_object(
              'consignee', v_row.consignee,
              'phone',     v_row.phone,
              'address',   v_row.address,
              'city',      v_row.city,
              'cod',       v_row.cod_amount,
              'weight',    v_meta ->> 'weight'),
    'to',   jsonb_build_object(
              'consignee', btrim(p_consignee),
              'phone',     btrim(p_phone),
              'address',   btrim(p_address),
              'city',      btrim(p_city),
              'cod',       p_cod,
              'weight',    btrim(coalesce(p_weight, '')))
  ));

  -- Keep the last 20. meta is carried on every parcel read; an unbounded
  -- array here would grow the payload of every dashboard load forever.
  v_len := jsonb_array_length(v_hist);
  if v_len > 20 then
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb)
      into v_hist
      from jsonb_array_elements(v_hist) with ordinality as t(e, i)
     where i > v_len - 20;
  end if;

  v_meta := v_meta || jsonb_build_object(
    'weight',       btrim(coalesce(p_weight, '')),
    'category',     btrim(coalesce(p_category, '')),
    'fragile',      case when btrim(coalesce(p_fragile, '')) = 'Yes' then 'Yes' else 'No' end,
    'service',      nullif(btrim(coalesce(p_service, '')), ''),
    'paymentMode',  nullif(btrim(coalesce(p_payment_mode, '')), ''),
    'allowOpen',    case when btrim(coalesce(p_allow_open, '')) = 'Yes' then 'Yes' else 'No' end,
    'orderId',      btrim(coalesce(p_order_id, '')),
    'editHistory',  v_hist,
    'lastEditedAt', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI')
  );

  -- Transaction-local. Tells trg_nv_freeze_parcel_money that this specific,
  -- re-checked path is the one changing cod_amount -- a browser doing a raw
  -- UPDATE cannot set this, because it never runs inside this function.
  perform set_config('novax.parcel_edit', '1', true);

  update public.parcels
     set consignee  = btrim(p_consignee),
         phone      = btrim(p_phone),
         address    = btrim(p_address),
         city       = btrim(p_city),
         cod_amount = p_cod,
         meta       = v_meta,
         updated_at = now()
   where id = v_row.id;
  --   fee is NOT in this list, and must never be added to it.

  return jsonb_build_object('ok', true, 'awb', v_row.awb);
end
$fn$;

revoke all on function public.client_edit_new_booked_parcel(
  text, text, text, text, text, numeric, text, text, text, text, text, text, text) from public;

grant execute on function public.client_edit_new_booked_parcel(
  text, text, text, text, text, numeric, text, text, text, text, text, text, text) to authenticated;


-- ---------------------------------------------------------------------
-- 2. Verify
-- ---------------------------------------------------------------------
-- Exactly ONE function of this name should exist. If this returns two
-- rows, an older overload is still there and PostgREST may resolve to the
-- wrong one -- this is the failure mode that took bookings down on
-- 2026-08-22. Drop the stale signature before using the feature.
--
--   select p.oid::regprocedure as signature
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname = 'client_edit_new_booked_parcel';
--
-- As a MERCHANT, editing one of your own "New booked" parcels must work:
--   select public.client_edit_new_booked_parcel(
--     'N5990018','Ayesha Khan','03001234567','12 Street, DHA Phase 5',
--     'Karachi', 2500, '1.2 kg','Kurta set','No','COD Standard','COD','No','#1042');
--
-- And the same call against a parcel that has moved must FAIL with
-- 'This parcel is already "..."'.
