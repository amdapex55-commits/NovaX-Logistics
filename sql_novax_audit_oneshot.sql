-- =====================================================================
-- NovaX — the whole backend defect scan, as ONE query
--
-- READ-ONLY. The Supabase SQL editor only displays the result of the LAST
-- statement, which is why a ten-query file returns one table and silently
-- discards the other nine. This is a single UNION ALL, so one Run gives
-- every finding in one grid you can copy in one go.
--
-- Each row is a PROBLEM. A section that is healthy contributes no rows.
-- If this returns nothing at all, nothing here is wrong.
--
-- Bearer tokens are redacted in section 8's output before they ever leave
-- the database, so this is safe to paste back as-is.
-- =====================================================================

with
-- 1. Two functions with the same name = the fault that took bookings down
overloads as (
  select '1. OVERLOADED FUNCTION' as section,
         p.proname as item,
         count(*)::text || ' signatures: ' || string_agg(p.oid::regprocedure::text, ' | ' order by p.oid) as detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
  group by p.proname having count(*) > 1
),
-- 2. SECURITY DEFINER runs as its owner; without a pinned path it can be hijacked
definers as (
  select '2. DEFINER, NO search_path', p.oid::regprocedure::text,
         'runs as ' || pg_get_userbyid(p.proowner) || ' with an unpinned search_path'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')
),
-- 3. Callable by the key that ships in your HTML
anon_fns as (
  select '3. ANON CAN CALL', p.proname,
         p.oid::regprocedure::text ||
         case when p.prosecdef then '  [SECURITY DEFINER]' else '' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.prokind='f'
    and has_function_privilege('anon', p.oid, 'execute')
),
-- 4. Served by PostgREST with no row security at all
rls_off as (
  select '4. TABLE NOT PROTECTED', c.relname::text,
         case when not c.relrowsecurity then 'RLS is DISABLED'
              else 'RLS on but ZERO policies -- nothing can be read or written' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and (not c.relrowsecurity
      or (select count(*) from pg_policies pol where pol.schemaname='public' and pol.tablename=c.relname)=0)
),
-- 5. RLS is permissive: one bare `true` defeats every other policy on the table
bare_true as (
  select '5. POLICY IS BARE TRUE', tablename || ' / ' || policyname,
         cmd || ' to ' || roles::text || '  using=' || coalesce(qual,'-') || '  check=' || coalesce(with_check,'-')
  from pg_policies
  where schemaname='public'
    and (btrim(coalesce(qual,''))='true' or btrim(coalesce(with_check,''))='true')
),
-- 6. How a permissive rule outlives the restrictive one meant to replace it
dupe_pol as (
  select '6. OVERLAPPING POLICIES', tablename || ' / ' || cmd || ' / ' || roles::text,
         count(*)::text || ' permissive policies: ' || string_agg(policyname, ', ' order by policyname)
  from pg_policies where schemaname='public' and permissive='PERMISSIVE'
  group by tablename, cmd, roles::text having count(*) > 1
),
-- 7. Two triggers writing the same derived value is how a merchant gets charged twice
trg_load as (
  select '7. TRIGGER LOAD', c.relname::text,
         count(*)::text || ' triggers: ' || string_agg(t.tgname, ', ' order by t.tgname)
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and not t.tgisinternal
  group by c.relname having count(*) > 3
),
-- 8. Webhook triggers store their auth header in the trigger body
secrets as (
  select '8. TRIGGER HOLDS A TOKEN', c.relname || ' / ' || t.tgname,
         regexp_replace(pg_get_triggerdef(t.oid),'(Bearer )[A-Za-z0-9._\-]+','\1<REDACTED>','g')
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and not t.tgisinternal
    and pg_get_triggerdef(t.oid) ~ 'Bearer'
),
-- 9. A view owned by a privileged role bypasses the caller's RLS
sd_views as (
  select '9. VIEW BYPASSES RLS', c.relname::text,
         'owned by ' || pg_get_userbyid(c.relowner) || ', security_invoker not set'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='v'
    and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off') <> 'true'
)
select * from overloads
union all select * from definers
union all select * from anon_fns
union all select * from rls_off
union all select * from bare_true
union all select * from dupe_pol
union all select * from trg_load
union all select * from secrets
union all select * from sd_views
order by 1, 2;
