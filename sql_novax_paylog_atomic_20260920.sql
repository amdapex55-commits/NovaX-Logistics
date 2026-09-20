-- NovaX — "COD expected" payment logs become part of the booking transaction.
--
-- WHY. No booking function has ever written payment_logs. The row was invented
-- in the merchant's BROWSER after a booking succeeded and pushed up later by a
-- background sync loop. Two consequences, both already in production:
--
--   * 195 parcels have NO "COD expected" row at all -- the tab was closed, or
--     the sync never completed, so the money record for a real booking simply
--     does not exist.
--   * 23 AWBs have DUPLICATE rows (27 extra) -- the loop ran twice.
--
-- A money record must be created by the same transaction that creates the
-- thing it describes. Only two functions insert into public.parcels
-- (nv_book_parcel_core and client_book_parcel), but a trigger covers both and
-- every future path -- admin, API, Shopify -- without touching their bodies.
--
-- Behaviour is deliberately IDENTICAL to what the browser did: one row per
-- parcel, amount = cod_amount (prepaid parcels get a 0 row; 158 such rows
-- already exist), status 'Awaiting delivery'. This changes WHERE and WHEN the
-- row is written, never what it says.

begin;

-- 1. Dedupe before the unique index can be added. Keeps the EARLIEST row per
--    (client, reference) -- the one written by the booking that actually
--    happened; later ones are the sync loop repeating itself.
with ranked as (
  select id, row_number() over (
           partition by client_id, reference order by created_at asc, id asc) rn
  from public.payment_logs
  where type = 'COD expected' and coalesce(reference,'') <> ''
)
delete from public.payment_logs pl using ranked r
where pl.id = r.id and r.rn > 1;

-- 2. Backfill the parcels whose money record was lost with a closed tab.
--    created_at is the parcel's booking time, not now, so history stays true.
insert into public.payment_logs (client_id, type, amount, status, reference, created_at)
select p.client_id, 'COD expected', coalesce(p.cod_amount,0), 'Awaiting delivery', p.awb, p.booked_at
from public.parcels p
where not exists (
  select 1 from public.payment_logs pl
  where pl.type='COD expected' and pl.reference=p.awb and pl.client_id=p.client_id);

-- 3. Make a duplicate impossible from any source, not merely unlikely.
create unique index if not exists payment_logs_cod_expected_uniq
  on public.payment_logs (client_id, reference)
  where type = 'COD expected' and coalesce(reference,'') <> '';

-- 4. The booking writes its own money record, in its own transaction.
create or replace function public.nv_log_cod_expected()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.payment_logs (client_id, type, amount, status, reference, created_at)
  values (new.client_id, 'COD expected', coalesce(new.cod_amount,0),
          'Awaiting delivery', new.awb, coalesce(new.booked_at, now()))
  on conflict do nothing;   -- idempotent against the partial unique index above
  return null;              -- AFTER trigger; return value is ignored
end
$$;

drop trigger if exists trg_nv_log_cod_expected on public.parcels;
create trigger trg_nv_log_cod_expected
  after insert on public.parcels
  for each row execute function public.nv_log_cod_expected();

commit;
