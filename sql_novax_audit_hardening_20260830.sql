-- ═══════════════════════════════════════════════════════════════════════════
-- NovaX Logistics — hardening pass from the Codex hard audit (2026-08-30)
-- Closes: HIGH-002 (partial), HIGH-003, HIGH-004, HIGH-005
-- Deferred by Aisha to later this week: all Shopify / WooCommerce findings.
--
-- SAFETY NOTES
--  * The public signup flow writes signup_leads as anon. That grant is KEPT.
--  * Public pages call: create_client_workspace, public_reviews,
--    public_track_awb, public_track_parcel. Those EXECUTE grants are KEPT.
--  * TRUNCATE is NOT filtered by RLS, which is why it is revoked everywhere.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ROOT CAUSE: future objects must not ship open ───────────────────────
-- Every new table in public was inheriting ALL privileges for anon and
-- authenticated. That is how operations_issues_backup_20260825 ended up
-- readable by the internet. Stop it at the source.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- ── 2. TRUNCATE / TRIGGER / REFERENCES on every existing public table ──────
-- RLS does not filter TRUNCATE. PostgREST never issues any of these three,
-- so removing them is behaviour-neutral for the app.
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
  loop
    execute format(
      'revoke truncate, trigger, references on public.%I from anon, authenticated',
      r.relname);
  end loop;
end $$;

-- ── 3. anon must never write to money or shipment tables ───────────────────
-- authenticated keeps its writes (RLS-filtered); only anon loses them.
do $$
declare t text;
begin
  foreach t in array array[
    'parcels','clients','invoices','withdrawals',
    'store_secrets','store_connections','wallet_ledger'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('revoke insert, update, delete on public.%I from anon', t);
    end if;
  end loop;
end $$;

-- ── 4. security-definer RPCs must not be callable anonymously ──────────────
-- These run as owner and bypass RLS. Only signed-in merchants may call them.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('client_book_parcel','client_book_parcel_geo',
                        'client_set_store_credentials',
                        'client_generate_shopify_link','client_shopify_status')
  loop
    execute format('revoke execute on function %s from anon, public', f.sig);
    execute format('grant  execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- ── 5. HIGH-004: close the unrate-limited tracking surface ─────────────────
-- track_parcel_public has no rate limit; public_track_awb does. All public
-- pages are migrated to public_track_awb in the same commit as this file.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'track_parcel_public'
  loop
    execute format('revoke execute on function %s from anon, authenticated, public', f.sig);
  end loop;
end $$;

-- ── 6. HIGH-005: manual booking idempotency ────────────────────────────────
-- 7 duplicate (client_id, orderId) groups already exist in production; those
-- are Aisha's call to merge, so this index only binds rows created from now
-- on and therefore builds cleanly against live data.
create unique index if not exists parcels_manual_order_uidx
  on public.parcels (client_id, ((meta ->> 'orderId')))
  where coalesce(meta ->> 'orderId','') <> ''
    and coalesce(meta ->> 'source','manual') = 'manual'
    and booked_at > timestamptz '2026-08-30 12:00:00+00';

-- ── 7. HIGH-002 (partial): constrain the delivery-proofs bucket ────────────
-- rider.html uploads with getPublicUrl(), so flipping the bucket to private
-- would break rider proof capture. The bucket holds 0 objects today, so there
-- is no live exposure; this pass adds the limits that do not break riders and
-- leaves the signed-URL migration as a tracked follow-up.
update storage.buckets
   set file_size_limit = 10485760,                          -- 10 MB
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'delivery-proofs';

drop policy if exists delivery_proofs_authenticated_insert on storage.objects;
create policy delivery_proofs_authenticated_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'delivery-proofs'
    and (storage.foldername(name))[1] is not null       -- must be filed under a parcel folder
    and octet_length(coalesce(name,'')) < 512
  );
