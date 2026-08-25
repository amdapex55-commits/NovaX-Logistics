-- =====================================================================
-- NovaX — backend inventory and automated defect scan
--
-- READ-ONLY. Runs no DDL, moves no money, changes nothing. Safe on live
-- traffic at any time of day.
--
-- WHY THIS EXISTS
--   88 distinct RPCs are called by the portals. 40 functions exist in the
--   repo. 71 of the 88 have no source anywhere outside the deployed
--   database -- including client_book_parcel, admin_push_invoice_to_wallet,
--   admin_mark_withdrawal_paid, request_wallet_withdrawal and
--   client_wallet_incoming. Every one of those is a money path that cannot
--   be reviewed, diffed, or restored if it is dropped.
--
--   The live parcels table carries 14 triggers. The repo accounts for five.
--
--   This script does the detection IN SQL so the output is a short findings
--   table rather than 100KB of function bodies. Each section prints only
--   what is wrong; a section returning zero rows is a section that passed.
--
-- HOW TO USE
--   Run the whole thing in the Supabase SQL editor. Copy back the output of
--   every section, including the empty ones -- "0 rows" is a result.
--   REDACT any Bearer token you see in section 8 before sending it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. OVERLOADED FUNCTIONS  --  the exact fault that took bookings down
--
--    CREATE OR REPLACE with a changed argument list does not replace the
--    function, it creates a SECOND one. PostgREST then resolves by argument
--    names and can pick either. On 2026-08-22 client_book_parcel had two
--    signatures and bookings failed with 42725 until the stale one was
--    dropped. Any row here is a live repeat of that bug.
-- ---------------------------------------------------------------------
select p.proname,
       count(*) as signatures,
       string_agg(p.oid::regprocedure::text, E'\n' order by p.oid) as all_signatures
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
group by p.proname
having count(*) > 1
order by count(*) desc, p.proname;


-- ---------------------------------------------------------------------
-- 2. SECURITY DEFINER WITHOUT A PINNED search_path
--
--    A definer function runs as its owner. Without `set search_path`, a
--    caller who can create objects in a schema earlier on the path can
--    shadow a table or function name and have it executed as the owner.
--    Every definer function here should pin its path.
-- ---------------------------------------------------------------------
select p.oid::regprocedure as function,
       pg_get_userbyid(p.proowner) as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}')) c
    where c like 'search_path=%'
  )
order by 1;


-- ---------------------------------------------------------------------
-- 3. FUNCTIONS THE PUBLIC INTERNET CAN CALL
--
--    anon is the role behind the publishable key, which ships in the HTML.
--    Anything executable by anon or PUBLIC is reachable by anyone who views
--    source. That is correct for public tracking; it is not correct for
--    anything that reads merchant data or moves money.
-- ---------------------------------------------------------------------
select p.oid::regprocedure as function,
       p.prosecdef as security_definer,
       case when has_function_privilege('anon',   p.oid, 'execute') then 'anon '   else '' end ||
       case when has_function_privilege('public', p.oid, 'execute') then 'public ' else '' end as callable_by
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
  and (has_function_privilege('anon', p.oid, 'execute')
    or has_function_privilege('public', p.oid, 'execute'))
order by p.prosecdef desc, 1;


-- ---------------------------------------------------------------------
-- 4. TABLES EXPOSED WITH RLS OFF
--
--    Everything in `public` is served by PostgREST. A table here with RLS
--    disabled is fully readable, and often writable, with the publishable
--    key.
-- ---------------------------------------------------------------------
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policies pol
         where pol.schemaname = 'public' and pol.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (not c.relrowsecurity
    or (select count(*) from pg_policies pol
         where pol.schemaname='public' and pol.tablename=c.relname) = 0)
order by c.relrowsecurity, c.relname;


-- ---------------------------------------------------------------------
-- 5. POLICIES THAT ARE A BARE `true`
--
--    RLS is permissive: policies OR together, so ONE policy of USING(true)
--    defeats every other policy on that table. novax_state was found in
--    exactly this state, holding staff PII, reachable with the publishable
--    key.
-- ---------------------------------------------------------------------
select tablename, policyname, cmd, roles::text,
       coalesce(qual, '(none)') as using_expr,
       coalesce(with_check, '(none)') as with_check_expr
from pg_policies
where schemaname = 'public'
  and (btrim(coalesce(qual, '')) = 'true' or btrim(coalesce(with_check, '')) = 'true')
order by tablename, policyname;


-- ---------------------------------------------------------------------
-- 6. DUPLICATE / OVERLAPPING POLICIES
--
--    More than one permissive policy for the same role and command on the
--    same table. Not automatically wrong, but it is how a permissive rule
--    survives after the restrictive one it was meant to replace, and it is
--    where "we fixed that" turns out to be false.
-- ---------------------------------------------------------------------
select tablename, cmd, roles::text, count(*) as policy_count,
       string_agg(policyname, ', ' order by policyname) as policies
from pg_policies
where schemaname = 'public' and permissive = 'PERMISSIVE'
group by tablename, cmd, roles::text
having count(*) > 1
order by count(*) desc, tablename;


-- ---------------------------------------------------------------------
-- 7. TRIGGER LOAD PER TABLE
--
--    Two triggers writing the same derived value is how a merchant gets
--    charged twice. parcels is known to carry 14. Anything above a couple
--    deserves a read.
-- ---------------------------------------------------------------------
select c.relname as table_name,
       count(*) as triggers,
       string_agg(t.tgname, E'\n' order by t.tgname) as trigger_names
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
group by c.relname
having count(*) > 1
order by count(*) desc;


-- ---------------------------------------------------------------------
-- 8. WEBHOOK TRIGGERS -- CHECK FOR EMBEDDED SECRETS BEFORE SENDING
--
--    supabase_functions.http_request triggers store their auth header in
--    the trigger definition. Two of them were found carrying the
--    service_role JWT in cleartext -- the key that bypasses RLS entirely.
--
--    REDACT every Bearer value before pasting this section anywhere.
-- ---------------------------------------------------------------------
select c.relname as table_name, t.tgname,
       (pg_get_triggerdef(t.oid) ~ 'Bearer') as contains_a_token,
       regexp_replace(pg_get_triggerdef(t.oid),
                      '(Bearer )[A-Za-z0-9._\-]+', '\1<REDACTED>', 'g') as definition_redacted
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
  and pg_get_triggerdef(t.oid) like '%http_request%'
order by c.relname, t.tgname;


-- ---------------------------------------------------------------------
-- 9. SECURITY DEFINER VIEWS
--
--    A view owned by a privileged role bypasses the caller's RLS. Supabase
--    flags these in its own linter for the same reason.
-- ---------------------------------------------------------------------
select c.relname as view_name,
       pg_get_userbyid(c.relowner) as owner,
       coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'not set') as security_invoker
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
order by 1;


-- ---------------------------------------------------------------------
-- 10. THE FULL FUNCTION INVENTORY  --  names and shapes only, no bodies
--
--     This is the map of what actually exists. Cross-referenced against the
--     88 RPCs the portals call, it shows what is live, what is dead, and
--     what the portals call that is not there at all.
-- ---------------------------------------------------------------------
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end as volatility,
       p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_can_call,
       length(p.prosrc) as body_chars
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
order by p.proname;
