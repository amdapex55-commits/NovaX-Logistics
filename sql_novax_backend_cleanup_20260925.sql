-- NovaX backend cleanup, 25 Sep 2026.  APPLIED TO PRODUCTION 25 Sep 2026.
--
-- Result: database 177 MB -> 86 MB. hooks 97,059 -> 8,328 rows (13 MB -> 1 MB
-- after vacuum full). Store-push webhooks 3 per status change -> 0 for every
-- merchant without a store connection, verified end to end in a rollback.
--
-- The backup was downloaded and row-count verified (413,182) BEFORE the drop.
-- pg_stat_user_tables reported n_live_tup = 0 for it because it had never been
-- analyzed; trusting that would have destroyed 413,182 rows while reporting an
-- empty table. count(*) before any drop.
--
-- Triggered by a 45.9% success rate and "exceeding usage limits" on a t4g.nano
-- holding 967 parcels. Audit found 144 MB of a 177 MB database was a dead
-- backup, two unbounded logs and an unread queue, and that every parcel status
-- change fired three store-push webhooks that all answered "not my parcel".
--
-- NOT IN THIS FILE, deliberately: the realtime WAL reader. It runs at a
-- constant 1.33 calls/second whether or not anything changed and whether or
-- not anyone is subscribed (replication slot lag was 56 bytes -- fully caught
-- up -- while the query had 811,443 calls). That is Realtime's own poll timer,
-- not something a subscription count or an index can move.

begin;

-- 1 ------------------------------------------------------------------------
-- 413,182 rows, 79 MB, 45% of the database, last written 25 Aug. This is the
-- table the 30 Aug audit found readable AND deletable by anyone on the
-- internet; it was locked down then rather than removed. Downloaded in full to
-- the owner's machine and row-count verified (413,182) before this ran.
drop table if exists public.operations_issues_backup_20260825;

-- 2 ------------------------------------------------------------------------
-- The three status-push triggers fire on every status change regardless of
-- where the parcel came from: 231 edge invocations in five hours, 77 each of
-- "Not a WooCommerce-sourced parcel", "Not a Shopify-sourced parcel" and
-- "Not a Custom Web/API-sourced parcel". A hundred percent waste.
--
-- The obvious fix -- test meta->>'source' in the trigger's WHEN clause -- does
-- not work: every parcel carries shopifyOrderId, shopifyStoreUrl and
-- externalOrderId as keys but not one has a value, so nothing on the row says
-- which store it came from. The answer lives in store_connections, and a
-- trigger WHEN clause may not contain a subquery. It MAY call a function.
--
-- Self-maintaining on purpose: connect a store tomorrow and its pushes resume
-- with no migration, because the gate reads the connection table live.
create or replace function public.nv_client_has_store(p_client uuid, p_aliases text[])
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select exists (
    select 1
    from public.store_connections sc
    where sc.client_id = p_client
      and sc.connected
      and lower(sc.platform) = any (select lower(a) from unnest(p_aliases) a)
  );
$fn$;

revoke all on function public.nv_client_has_store(uuid, text[]) from public, anon, authenticated;

-- Rewritten from pg_get_triggerdef rather than typed out, because each
-- definition embeds a service key in its header argument. Splicing the gate
-- into the existing WHEN keeps that key inside the database and out of this
-- (publicly served) file.
do $$
declare
  r record;
  v_def text;
  v_aliases text;
begin
  for r in
    select t.tgname, pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'parcels'
      and not t.tgisinternal
      and pg_get_triggerdef(t.oid) like '%functions/v1/%-status-push%'
  loop
    v_aliases := case
      when r.def like '%shopify-status-push%' then 'ARRAY[''shopify'']'
      when r.def like '%woo-status-push%'     then 'ARRAY[''woocommerce'',''woo'']'
      when r.def like '%web-status-push%'     then 'ARRAY[''web'',''custom'',''custom_web'',''api'']'
      else null
    end;
    if v_aliases is null then
      continue;
    end if;

    -- already gated (re-run of this migration)
    if r.def like '%nv_client_has_store%' then
      continue;
    end if;

    v_def := replace(
      r.def,
      'WHEN ((old.status IS DISTINCT FROM new.status))',
      'WHEN ((old.status IS DISTINCT FROM new.status) AND public.nv_client_has_store(new.client_id, '
        || v_aliases || '))'
    );

    if v_def = r.def then
      raise exception 'Trigger % did not match the expected WHEN clause; not touching it.', r.tgname;
    end if;

    execute format('drop trigger %I on public.parcels', r.tgname);
    execute v_def;
    raise notice 'gated %', r.tgname;
  end loop;
end $$;

-- 3 ------------------------------------------------------------------------
-- Retention. Three tables grew without a ceiling; job_run_details already had
-- a nightly prune (job 8) and is the pattern followed here.
--
--   nv_api_request_log     143,908 rows / 36 MB, ~5,300 a day, 27 days deep.
--                          Nothing is older than 30 days yet, so this frees
--                          nothing today -- it caps the table at roughly
--                          160,000 rows instead of letting it run forever.
--   supabase_functions.hooks 97,059 rows / 13 MB, back to 8 Jul, never read
--                          once (0 sequential and 0 index scans). 88,725 rows
--                          are older than 7 days and go immediately.
--   net._http_response     the webhook response log, which only matters while
--                          debugging a push.
create or replace function public.nv_prune_logs()
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  delete from public.nv_api_request_log where created_at < now() - interval '30 days';
  delete from supabase_functions.hooks   where created_at < now() - interval '7 days';
  begin
    delete from net._http_response where created < now() - interval '3 days';
  exception when undefined_table or insufficient_privilege then
    null;  -- pg_net not present or not ours to prune; the rest still ran
  end;
end;
$fn$;

revoke all on function public.nv_prune_logs() from public, anon, authenticated;

commit;

-- Scheduled outside the transaction: cron.schedule commits on its own.
select cron.unschedule('nv_prune_logs') where exists (select 1 from cron.job where jobname = 'nv_prune_logs');
select cron.schedule('nv_prune_logs', '41 3 * * *', 'select public.nv_prune_logs();');
