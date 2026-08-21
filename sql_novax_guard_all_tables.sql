-- =====================================================================
-- NovaX — close the blank-overwrite class everywhere, not table by table
--
-- syncEntity() in admin.html sends FULL-ROW UPDATEs from the browser for
-- every table below. Any field that is blank in browser memory therefore
-- erases the stored value. That is exactly what emptied 298 parcel
-- addresses. parcels and clients already have bespoke guards; this closes
-- the rest with one generic rule.
--
-- The rule: an UPDATE may not replace a non-empty text value with an
-- empty one. Everything else -- real edits, nulls on columns that were
-- already null, non-text columns -- passes through untouched.
--
-- Deliberately clearing a field now needs an explicit RPC rather than a
-- background sync. That is the point.
-- =====================================================================

create or replace function public.nv_no_blank_overwrite()
returns trigger
language plpgsql
as $fn$
declare
  j_old jsonb := to_jsonb(old);
  j_new jsonb := to_jsonb(new);
  k     text;
  changed boolean := false;
begin
  for k in select jsonb_object_keys(j_new)
  loop
    -- only text-valued keys, only blank-over-non-blank
    if jsonb_typeof(j_new -> k) = 'string'
       and btrim(coalesce(j_new ->> k, '')) = ''
       and jsonb_typeof(j_old -> k) = 'string'
       and btrim(coalesce(j_old ->> k, '')) <> ''
    then
      j_new := jsonb_set(j_new, array[k], j_old -> k);
      changed := true;
    end if;
  end loop;

  if changed then
    new := jsonb_populate_record(new, j_new);
  end if;
  return new;
end
$fn$;

-- Attach to every table the browser writes whole rows to.
-- parcels and clients keep their existing, more specific guards.
do $do$
declare t text;
begin
  foreach t in array array[
    'riders','expenses','payment_logs','operations_issues',
    'resolved_alerts','manifest_logs','staff_users',
    'staff_activity','pickup_requests'
  ]
  loop
    if exists (select 1 from information_schema.tables
                where table_schema = 'public' and table_name = t) then
      execute format(
        'drop trigger if exists trg_nv_no_blank_overwrite on public.%I', t);
      execute format(
        'create trigger trg_nv_no_blank_overwrite before update on public.%I
           for each row execute function public.nv_no_blank_overwrite()', t);
      raise notice 'guarded: %', t;
    else
      raise notice 'skipped (no such table): %', t;
    end if;
  end loop;
end
$do$;

-- Confirm what is now protected.
select tgrelid::regclass::text as protected_table
  from pg_trigger
 where tgname in ('trg_nv_no_blank_overwrite',
                  'trg_nv_protect_parcel_contact',
                  'trg_nv_protect_client_contact')
 order by 1;
