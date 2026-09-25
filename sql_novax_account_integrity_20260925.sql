-- NovaX account integrity, 25 Sep 2026.  APPLIED TO PRODUCTION 25 Sep 2026.
--
-- THE INCIDENT. At 13:35:11 a client row (6803a895) was created for a merchant
-- who already had one. At 13:35:12 -- one second later, in a 17ms window -- all
-- 221 KKM SWEETS & NIMCO parcels were bulk-moved onto it. The invoices (20) and
-- wallet ledger (52 rows) stayed behind on 650e8502, the record the merchant
-- actually signs into. So the portal still rendered a Rs 51,394 balance and
-- last week's 141 deliveries, while the parcel list came back empty and the
-- merchant was shown "create your first booking".
--
-- Nothing recorded who did it. parcels_guard_columns() silently pins client_id
-- for every non-admin caller, so it had to be an admin or order-processing
-- session -- but there was no audit trail to name one, and no invariant to stop
-- an invoiced parcel walking away from its own invoice.
--
-- Note for whoever hits this next: running the repair UPDATE in the Supabase
-- SQL editor does NOT work. The editor connects as postgres, auth.uid() is
-- null, so the guard pins client_id and reports "UPDATE 221" having changed
-- nothing. The restore must come from an admin session or the RPC below.

begin;

-- 1. Every ownership change is recorded, whatever moves it ------------------
create table if not exists public.nv_parcel_owner_log (
  id bigserial primary key,
  parcel_id uuid not null, awb text,
  from_client uuid, to_client uuid,
  actor_uid uuid, actor_email text, reason text,
  at timestamptz not null default now()
);
alter table public.nv_parcel_owner_log enable row level security;
revoke all on table public.nv_parcel_owner_log from public, anon, authenticated;

create or replace function public.nv_log_parcel_owner_change()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  insert into public.nv_parcel_owner_log(parcel_id, awb, from_client, to_client, actor_uid, actor_email, reason)
  values (new.id, new.awb, old.client_id, new.client_id, auth.uid(),
          coalesce(auth.jwt() ->> 'email',
                   (select pr.email from public.profiles pr where pr.id = auth.uid()), '(no auth context)'),
          nullif(current_setting('novax.parcel_reassign_reason', true), ''));
  return new;
end $fn$;

drop trigger if exists nv_zzz_log_owner_change on public.parcels;
create trigger nv_zzz_log_owner_change
  after update of client_id on public.parcels
  for each row when (old.client_id is distinct from new.client_id)
  execute function public.nv_log_parcel_owner_change();

-- 2. The invariant that would have stopped it -------------------------------
-- A parcel may not belong to one client while its invoice belongs to another.
-- DEFERRABLE so a legitimate merge can move parcels and invoices in either
-- order inside one transaction and be checked at commit; a bulk move that
-- leaves the invoices behind aborts the whole transaction, all 221 rows.
create or replace function public.nv_parcel_owner_matches_invoice()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare v_inv_client uuid;
begin
  if new.invoice_id is null then return null; end if;
  select client_id into v_inv_client from public.invoices where id = new.invoice_id;
  if v_inv_client is not null and v_inv_client is distinct from new.client_id then
    raise exception
      'Parcel % cannot belong to client % while its invoice belongs to %. Move the invoices with the parcels, or clear the invoice first.',
      new.awb, new.client_id, v_inv_client using errcode = '23514';
  end if;
  return null;
end $fn$;

drop trigger if exists nv_zzz_owner_matches_invoice on public.parcels;
create constraint trigger nv_zzz_owner_matches_invoice
  after update of client_id, invoice_id on public.parcels
  deferrable initially deferred
  for each row when (old.client_id is distinct from new.client_id
                  or old.invoice_id is distinct from new.invoice_id)
  execute function public.nv_parcel_owner_matches_invoice();

-- 3. Detection, so a split surfaces before a merchant finds it --------------
create or replace function public.nv_account_split_check()
returns table(severity text, finding text, detail text)
language sql stable security definer set search_path to 'public' as $fn$
  select 'critical', 'client holds parcels but has no login',
         c.name||' ('||substr(c.id::text,1,8)||') — '||(select count(*) from parcels p where p.client_id=c.id)||' parcels, nobody can sign in'
  from clients c
  where exists(select 1 from parcels p where p.client_id=c.id)
    and not exists(select 1 from profiles pr where pr.client_id=c.id)
  union all
  select 'critical', 'parcel owner differs from its invoice owner',
         p.awb||' — parcel on '||substr(p.client_id::text,1,8)||', invoice on '||substr(i.client_id::text,1,8)
  from parcels p join invoices i on i.id=p.invoice_id where i.client_id is distinct from p.client_id
  union all
  select 'warning', 'duplicate client records share a name',
         lower(btrim(c.name))||' — '||count(*)||' records: '||string_agg(substr(c.id::text,1,8)||'='||
           (select count(*) from parcels p where p.client_id=c.id)||'p', ', ' order by c.created_at)
  from clients c group by lower(btrim(c.name)) having count(*) > 1
  union all
  select 'warning', 'client has money history but no parcels',
         c.name||' ('||substr(c.id::text,1,8)||') — '||(select count(*) from wallet_ledger w where w.client_id=c.id)||' ledger rows, 0 parcels'
  from clients c
  where exists(select 1 from wallet_ledger w where w.client_id=c.id)
    and not exists(select 1 from parcels p where p.client_id=c.id);
$fn$;
revoke all on function public.nv_account_split_check() from public, anon;

-- Critical findings land in the ops queue admin already reads, hourly, without
-- piling up a duplicate row while one is still open.
create or replace function public.nv_account_split_alert()
returns int language plpgsql security definer set search_path to 'public' as $fn$
declare n int := 0; r record;
begin
  for r in select * from public.nv_account_split_check() where severity='critical' loop
    if not exists (select 1 from public.operations_issues oi
                   where oi.problem = r.finding||': '||r.detail and not coalesce(oi.resolved,false)) then
      insert into public.operations_issues (branch, urgency, problem, resolved, meta)
      values ('System','super urgent', r.finding||': '||r.detail, false,
              jsonb_build_object('source','nv_account_split_alert','raised_at', now()));
      n := n + 1;
    end if;
  end loop;
  return n;
end $fn$;
revoke all on function public.nv_account_split_alert() from public, anon;

-- 4. One controlled way to move parcels between clients ---------------------
create or replace function public.admin_reassign_client_parcels(p_from_client uuid, p_to_client uuid, p_reason text default null)
returns table(moved int) language plpgsql security definer set search_path to 'public' as $fn$
declare v_moved int;
begin
  if not (public.is_admin() or public.can_process_orders()) then
    raise exception 'Only an admin may reassign parcels between clients.';
  end if;
  if p_to_client is null or not exists (select 1 from public.clients where id = p_to_client) then
    raise exception 'Target client % does not exist.', p_to_client;
  end if;
  perform set_config('novax.parcel_reassign_reason', coalesce(p_reason,''), true);
  update public.parcels set client_id = p_to_client where client_id = p_from_client;
  get diagnostics v_moved = row_count;
  return query select v_moved;
end $fn$;
revoke all on function public.admin_reassign_client_parcels(uuid, uuid, text) from public, anon;
grant execute on function public.admin_reassign_client_parcels(uuid, uuid, text) to authenticated;

commit;

select cron.unschedule('nv_account_split_alert') where exists (select 1 from cron.job where jobname='nv_account_split_alert');
select cron.schedule('nv_account_split_alert','17 * * * *','select public.nv_account_split_alert();');

-- Verified after applying:
--   KKM parcels on the login account ... 221    (0 left on the duplicate)
--   critical findings .................. 0
--   wallet reconciliation gap .......... 0 across 276 clients
--   incident replayed against the guard  aborts: "Parcel N8530165 cannot
--                                        belong to ... while its invoice
--                                        belongs to ..."
