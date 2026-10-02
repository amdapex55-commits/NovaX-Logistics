-- NovaX data checks (2 Oct 2026). Added NOT VALID (new writes only), then
-- validated against every existing row in a second step.
--  * withdrawals: known status, a Paid row has a paid date, dates in order,
--    positive amount, no negative fee or net. (The reject function stamps
--    paid_at as its decision time, so a rejected row may carry one.)
--  * parcels.status: exactly the 18 statuses enforce_parcel_status_transition
--    knows; if a status is ever added there, add it here in the same change.
-- One row fixed first: a Paid withdrawal with no paid date gets the time its
-- payout was recorded in the wallet ledger.

begin;
update public.withdrawals set paid_at = '2026-07-11 13:51:35.096812+00'
 where id = '08392c8f-b18d-4883-9ccb-c9a5ae275942' and status = 'Paid' and paid_at is null;

alter table public.withdrawals drop constraint if exists withdrawals_status_known;
alter table public.withdrawals add constraint withdrawals_status_known
  check (status in ('Pending admin payout', 'Paid', 'Rejected / Cancelled')) not valid;
alter table public.withdrawals drop constraint if exists withdrawals_paid_has_date;
alter table public.withdrawals add constraint withdrawals_paid_has_date
  check (status <> 'Paid' or paid_at is not null) not valid;
alter table public.withdrawals drop constraint if exists withdrawals_dates_ordered;
alter table public.withdrawals add constraint withdrawals_dates_ordered
  check (paid_at is null or paid_at >= created_at) not valid;
alter table public.withdrawals drop constraint if exists withdrawals_amounts_sane;
alter table public.withdrawals add constraint withdrawals_amounts_sane
  check (amount > 0 and fee >= 0 and net >= 0) not valid;

alter table public.parcels drop constraint if exists parcels_status_known;
alter table public.parcels add constraint parcels_status_known
  check (status in ('New booked', 'Collected by rider', 'Arrived at warehouse', 'Parcel now in transit',
    'Parcel received at destination', 'Parcel out for delivery', 'Delivered', 'Refused', 'Consignee not available',
    'Reattempt', 'Reassigned', 'Out of service area', 'Ready for return', 'Return in transit',
    'Return received at origin', 'Return out for delivery', 'Return to shipper', 'Cancelled by client')) not valid;
commit;

alter table public.withdrawals validate constraint withdrawals_status_known;
alter table public.withdrawals validate constraint withdrawals_paid_has_date;
alter table public.withdrawals validate constraint withdrawals_dates_ordered;
alter table public.withdrawals validate constraint withdrawals_amounts_sane;
alter table public.parcels validate constraint parcels_status_known;
