-- NovaX outside-audit fixes, 6 Oct 2026.
-- Apply in one transaction: psql -1 -v ON_ERROR_STOP=1 -f sql_novax_audit_fixes_20261006.sql

-- NX-02: booking was hidden from Finance and Support seats only in the
-- portal; the booking functions checked just workspace membership, so such a
-- login could book from the browser console. The boundary now lives on the
-- parcels table itself, so every path (direct, geo, idempotent, bulk, swap,
-- and any future one) is covered. Owner and Warehouse seats, logins with no
-- seat row (the workspace owner), NovaX admins and the service role (API,
-- WooCommerce, Shopify) are unaffected.
create or replace function public.nv_parcel_seat_may_book()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_email text;
begin
  if v_uid is null or new.client_id is null then return new; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if exists (
    select 1 from public.staff_users su
     where su.client_id = new.client_id
       and (su.auth_user_id = v_uid or lower(su.email) = coalesce(v_email, ''))
       and (lower(coalesce(su.status, 'Active')) = 'revoked'
            or lower(coalesce(su.role, '')) in ('finance', 'support'))
  ) then
    raise exception 'Your team role cannot book parcels. Ask the account owner or a warehouse login.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.nv_parcel_seat_may_book() from public, anon, authenticated;
drop trigger if exists nv_parcel_seat_may_book on public.parcels;
create trigger nv_parcel_seat_may_book before insert on public.parcels
  for each row execute function public.nv_parcel_seat_may_book();

-- NX-01: a Merchant API booking with neither an Idempotency-Key header nor an
-- order_id skipped the duplicate guard, so a retry after a lost response
-- booked a second parcel. Such a request now gets an automatic key from the
-- parcel's own details, honoured for 15 minutes (a genuine second identical
-- parcel inside that window needs a distinct Idempotency-Key, as documented).
-- Explicit keys (api:, order:, woo:) no longer expire after 24 hours, and an
-- Idempotency-Key reused with different parcel details is refused instead of
-- silently answering with the old parcel.
alter table public.nv_booking_idempotency add column if not exists payload_hash text;

create or replace function public.nv_book_parcel_api_idem(
  p_client_id uuid, p_idem_key text, p_consignee text, p_phone text, p_pickup_city text,
  p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_id text default ''::text,
  p_reference_no text default ''::text, p_source text default 'merchant_api'::text,
  p_actor_role text default 'api'::text)
 returns parcels language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_key text := left(btrim(coalesce(p_idem_key, '')), 200);
  v_hash text := md5(concat_ws('|', lower(btrim(coalesce(p_consignee, ''))), regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'),
                     lower(btrim(coalesce(p_city, ''))), lower(regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g')),
                     coalesce(p_cod, 0)::text, lower(btrim(coalesce(p_weight, ''))), lower(btrim(coalesce(p_pickup_city, '')))));
  v_auto boolean := false;
  v_hit public.nv_booking_idempotency;
  v_row public.parcels;
begin
  if p_client_id is null then raise exception 'Select a client first.'; end if;
  if v_key = '' then v_key := 'auto:' || v_hash; v_auto := true; end if;
  perform pg_advisory_xact_lock(hashtext('novax_idem_' || p_client_id::text || ':' || v_key));
  select * into v_hit from public.nv_booking_idempotency where client_id = p_client_id and idem_key = v_key;
  if found and (not v_auto or v_hit.created_at > now() - interval '15 minutes') then
    select * into v_row from public.parcels where id = v_hit.parcel_id and client_id = p_client_id;
    if found and v_row.status is distinct from 'Cancelled by client' then
      if v_key like 'api:%' and v_hit.payload_hash is not null and v_hit.payload_hash <> v_hash then
        raise exception 'This Idempotency-Key was already used for a different parcel (%). Use a new key for a new parcel.', v_row.awb
          using errcode = 'P0001';
      end if;
      return v_row;
    end if;
  end if;
  v_row := public.nv_book_parcel_core(p_client_id, p_consignee, p_phone, p_pickup_city, p_city, p_address,
    p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id, p_reference_no,
    p_source, p_actor_role);
  insert into public.nv_booking_idempotency (client_id, idem_key, parcel_id, awb, payload_hash)
  values (p_client_id, v_key, v_row.id, v_row.awb, v_hash)
  on conflict (client_id, idem_key) do update
    set parcel_id = excluded.parcel_id, awb = excluded.awb, payload_hash = excluded.payload_hash, created_at = now();
  return v_row;
end
$function$;
revoke execute on function public.nv_book_parcel_api_idem(uuid,text,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.nv_book_parcel_api_idem(uuid,text,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) to service_role;
