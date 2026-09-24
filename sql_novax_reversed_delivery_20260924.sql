-- NovaX: a refused parcel showed "Delivered 22 Sept, 11:08 am", 24 Sep 2026.
--
-- Hayat Scents asked why N7810135 "shows both Refused and Delivered". At
-- 11:08 PKT on 22 Sep an admin bulk batch pushed eight parcels to Out for
-- delivery and then Delivered, and N7810135 -- Refused since 19 Sep and
-- already invoiced as a return -- was in the list. It was put back to Refused
-- at 12:23. The status was corrected; delivered_at was not.
--
-- novax_stamp_delivered_at() stamped delivered_at on entering Delivered and,
-- by design, never cleared it. So a parcel that is no longer delivered kept a
-- delivery time, and everything that reads delivered_at believed it:
--   * the public tracking page printed "Delivered <time>" under "Delivery
--     refused" (what the merchant screenshotted);
--   * the merchant API returned delivered_at on a Refused parcel;
--   * client_delivery_estimate counted it as a delivery;
--   * the portal's elapsed-time clock ended at the reversed delivery.
-- Three parcels are in that state: N7810135, N7810122, N8530092.
--
-- delivered_at now means "when this parcel was delivered, if it is". It is
-- cleared when a parcel leaves Delivered and stamped afresh if it returns.
-- The history of the reversal is not lost: nv_parcel_status_log keeps every
-- step with its time.

begin;

CREATE OR REPLACE FUNCTION public.novax_stamp_delivered_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.status = 'Delivered'
     and coalesce(old.status, '') is distinct from 'Delivered'
     and new.delivered_at is null then
    new.delivered_at := now();
  elsif coalesce(old.status, '') = 'Delivered'
     and new.status is distinct from 'Delivered' then
    -- Delivered was reversed (an admin correction). It is not delivered, so it
    -- has no delivery time; the reversal itself is in nv_parcel_status_log.
    new.delivered_at := null;
  end if;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.parcels_guard_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;

  new.awb := old.awb;
  new.client_id := old.client_id;
  new.rider_id := old.rider_id;
  new.fee := old.fee;
  new.booked_at := old.booked_at;

  /* Consignee details and COD change in exactly one situation: the merchant
     correcting their own booking through nv_edit_parcel_core(), which re-checks
     ownership, status, invoicing and rider assignment and sets this
     transaction-local flag right before its UPDATE. nv_freeze_parcel_money
     still refuses COD once a parcel has moved. */
  if coalesce(current_setting('novax.parcel_edit', true), '') <> '1' then
    new.consignee := old.consignee;
    new.city := old.city;
    new.address := old.address;
    new.phone := old.phone;
    new.cod_amount := old.cod_amount;
    /* Payment mode decides whether the rider collects at the door. It is
       part of the booking, like cod_amount, and changes only through the
       same edit path. A direct meta write could flip a COD parcel to
       prepaid after booking, so the rider collects Rs 0 and invoicing then
       refuses the parcel as a COD/prepaid conflict. */
    if (new.meta ->> 'paymentMode') is distinct from (old.meta ->> 'paymentMode') then
      new.meta := case
        when old.meta ? 'paymentMode'
          then jsonb_set(coalesce(new.meta, '{}'::jsonb), '{paymentMode}', old.meta -> 'paymentMode')
        else coalesce(new.meta, '{}'::jsonb) - 'paymentMode'
      end;
    end if;
  end if;

  /* Settlement state. invoice_id decides whether a parcel can be invoiced
     again; a merchant clearing it made the same parcel invoiceable twice. */
  new.invoice_id := old.invoice_id;
  new.invoiced_at := old.invoiced_at;
  new.delivery_charge_posted_at := old.delivery_charge_posted_at;

  /* delivered_at is delivery evidence: it dates the delivery on the public
     tracking page and in delivery-time figures. A merchant session could
     write it onto a parcel that was never delivered (rehearsed 24 Sep:
     New booked parcel, delivered_at = now(), accepted). The only
     legitimate non-admin change is novax_stamp_delivered_at() stamping the
     first entry into Delivered, which runs before this trigger. */
  if new.delivered_at is distinct from old.delivered_at
     and not (old.delivered_at is null
              and new.status = 'Delivered'
              and old.status is distinct from 'Delivered')
     -- novax_stamp_delivered_at() clearing it as the parcel leaves Delivered
     and not (new.delivered_at is null
              and old.status = 'Delivered'
              and new.status is distinct from 'Delivered') then
    new.delivered_at := old.delivered_at;
  end if;

  /* Delivery evidence. "COD collected" in meta.steps makes a parcel
     invoiceable; cashReceived and deliveredBy are what the rider records at
     the door. Only the rider carrying the parcel may add them. */
  if not (old.rider_id is not null and old.rider_id = public.my_rider_id()) then
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
    new.meta := (coalesce(new.meta, '{}'::jsonb) - 'cashReceived' - 'deliveredBy')
                || jsonb_strip_nulls(jsonb_build_object(
                     'cashReceived', old.meta -> 'cashReceived',
                     'deliveredBy',  old.meta -> 'deliveredBy'));
  elsif coalesce(new.status, '') <> 'Delivered' then
    -- Even the carrying rider records cash only on a delivered parcel.
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
  end if;

  return new;
end;
$function$;

-- Backfill: the three parcels whose delivery was reversed before this fix.
-- Admin-bypassed triggers are not involved: parcels_guard_columns only
-- restores delivered_at for non-admin sessions, and a postgres session is not
-- admin, so the guard is suspended for this one statement.
alter table public.parcels disable trigger parcels_guard_columns_trg;
update public.parcels
   set delivered_at = null
 where status <> 'Delivered' and delivered_at is not null;
alter table public.parcels enable trigger parcels_guard_columns_trg;

commit;
