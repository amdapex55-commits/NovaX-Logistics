-- NovaX: fields stamped by one outcome survived the next, 24 Sep 2026.
--
-- Same class as N7810135 (delivered_at kept after a delivery was reversed):
--
-- 1. The failure reason outlives the failure. 17 Delivered parcels still
--    carried the reason typed when they failed -- "cancel", "out of servies",
--    "contact nahi ho raha". Every one went Refused / Out of service area /
--    Consignee not available and was then delivered; admin processing never
--    touches exception, only the rider batch clears it. The portals read
--    exception as "something is wrong with this parcel":
--      client: statusClass() -> red row; nvAttentionParcels() -> counted in
--              "needs you" as "Exception raised"; drawer -> "What happened:
--              cancel" under a Delivered pill; isRefusalReview() -> Refused
--              and Reattempt rows added to a delivered parcel's journey
--      admin:  statusClass() -> "bad"; the exceptions list
--    A delivered parcel has no failure reason. It is now moved into
--    meta.exceptionHistory (kept, not deleted) whenever the parcel is, or
--    becomes, Delivered -- on every write, so a stale browser copy pushing the
--    old text back cannot resurrect it.
--
-- 2. "Delivered" stays in meta.steps after a delivery is reversed. The
--    merchant's parcel drawer builds an off-flow parcel's journey from
--    meta.steps, so N7810135 showed Delivered ticked above "Refused". Removed
--    from steps when a parcel leaves Delivered. ("COD collected" is left
--    alone: it is settlement evidence. No non-delivered parcel carries it.)

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
    -- has no delivery time and "Delivered" is not one of its steps; the
    -- reversal itself is in nv_parcel_status_log.
    new.delivered_at := null;
    if jsonb_typeof(new.meta -> 'steps') = 'array' then
      new.meta := jsonb_set(new.meta, '{steps}',
        coalesce((select jsonb_agg(s) from jsonb_array_elements(new.meta -> 'steps') s
                   where s <> '"Delivered"'::jsonb), '[]'::jsonb));
    end if;
  end if;

  -- A delivered parcel has no failure reason. Keep the old one in history.
  if new.status = 'Delivered' and coalesce(btrim(new.exception), '') <> '' then
    new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{exceptionHistory}',
      coalesce(new.meta -> 'exceptionHistory', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'reason', new.exception,
        'status', coalesce(old.status, new.status),
        'clearedAt', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'))));
    new.exception := '';
  end if;
  return new;
end
$function$;

-- Backfill both. A no-op UPDATE fires the trigger; status does not change, so
-- no store push, status log or transition check is involved.
update public.parcels
   set exception = exception
 where status = 'Delivered' and coalesce(btrim(exception), '') <> '';

update public.parcels
   set meta = jsonb_set(meta, '{steps}',
         coalesce((select jsonb_agg(s) from jsonb_array_elements(meta -> 'steps') s
                    where s <> '"Delivered"'::jsonb), '[]'::jsonb))
 where status <> 'Delivered' and meta -> 'steps' @> '"Delivered"';

commit;
