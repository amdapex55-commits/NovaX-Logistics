-- 4 Nov 2026: egress. The merchant portal re-read every parcel (with its
-- whole meta) on each realtime nudge, tab return and fallback poll: ~92% of
-- NovaX's egress, which went over the Free plan's 5 GB last cycle.
-- changed_at lets the portal fetch only parcels that changed since its last
-- read. updated_at is left alone: rider_station_view and the API give it a
-- meaning of their own.
alter table public.parcels add column if not exists changed_at timestamptz not null default now();
create index if not exists parcels_client_changed_idx on public.parcels (client_id, changed_at);

create or replace function public.nv_parcels_touch_changed()
returns trigger language plpgsql set search_path to '' as $$
begin
  new.changed_at := now();
  return new;
end $$;
revoke all on function public.nv_parcels_touch_changed() from public, anon, authenticated;

-- zzzz_: runs after every guard trigger, so none of them sees this column move.
drop trigger if exists zzzz_nv_parcels_changed_at on public.parcels;
create trigger zzzz_nv_parcels_changed_at before insert or update on public.parcels
  for each row execute function public.nv_parcels_touch_changed();
