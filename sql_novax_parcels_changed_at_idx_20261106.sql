-- 6 Nov 2026: admin reads changed parcels across all merchants (nvAdminParcels in admin.html).
create index if not exists parcels_changed_at_idx on public.parcels (changed_at);
