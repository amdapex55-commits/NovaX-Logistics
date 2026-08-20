-- ============================================================================
-- Enable Supabase Realtime on the tables both portals subscribe to.
--
-- Both client.html and admin.html open postgres_changes channels, but Supabase
-- only broadcasts a table's changes if that table is a member of the
-- supabase_realtime publication. If it is not, the subscription succeeds and
-- then sits silent forever -- which is exactly what "I have to hard refresh to
-- see a new booking" looks like.
--
-- The portals now also poll every 30s and refresh on tab focus, so they stay
-- current either way. This makes updates instant instead of up-to-30s.
-- ============================================================================

-- STEP 1 -- what is currently published? Run this first.
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;

-- STEP 2 -- add anything missing. Safe to re-run: each is wrapped so an
-- already-published table does not abort the batch.
do $$
declare
  t text;
begin
  foreach t in array array[
    'parcels','invoices','withdrawals','clients',
    'wallet_ledger','pickup_requests','reviews'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'added %', t;
    exception
      when duplicate_object then raise notice 'already published: %', t;
      when undefined_table  then raise notice 'no such table: %', t;
    end;
  end loop;
end $$;

-- STEP 3 -- confirm.
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
