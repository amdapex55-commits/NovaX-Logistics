-- ============================================================================
-- NovaX backend audit -- diagnostics. All read-only, safe on production.
-- Run each block on its own and read the output.
-- ============================================================================

-- 1. HOW MANY TABLES DO YOU ACTUALLY HAVE?
--    The "PRIVATE (127)" in the SQL Editor sidebar is 127 SAVED QUERIES, not
--    tables. This is the real number.
select count(*) as real_table_count
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE';

select table_name,
       pg_size_pretty(pg_total_relation_size(('public.'||table_name)::regclass)) as size
from information_schema.tables
where table_schema='public' and table_type='BASE TABLE'
order by pg_total_relation_size(('public.'||table_name)::regclass) desc;

-- 2. THE 12 POSTGRES ERRORS PER HOUR.
--    Most likely RLS denials or a function raising. This shows what is slow
--    and what is being called most -- the usual suspects show up top.
--    (Needs pg_stat_statements; if it errors, enable it in Database > Extensions.)
select calls,
       round(total_exec_time::numeric, 1) as total_ms,
       round(mean_exec_time::numeric, 2)  as avg_ms,
       rows,
       left(query, 110) as query
from pg_stat_statements
order by total_exec_time desc
limit 25;

-- 3. QUERIES THAT RUN OFTEN -- these are what the portals hammer.
select calls, round(mean_exec_time::numeric,2) as avg_ms, left(query,110) as query
from pg_stat_statements
order by calls desc
limit 25;

-- 4. MISSING INDEXES ON THE HOT PATH.
--    Both portals filter almost everything by client_id, and order by
--    booked_at / created_at. Anything here with idx_scan = 0 and a large table
--    is being sequentially scanned on every single portal load.
select relname as table_name,
       seq_scan, seq_tup_read,
       idx_scan,
       n_live_tup as approx_rows
from pg_stat_user_tables
where schemaname='public'
order by seq_tup_read desc
limit 20;

-- 5. WHAT INDEXES EXIST ON THE TABLES THE PORTALS READ EVERY TIME?
select tablename, indexname, indexdef
from pg_indexes
where schemaname='public'
  and tablename in ('parcels','invoices','withdrawals','wallet_ledger',
                    'payment_logs','pickup_requests','clients','store_connections')
order by tablename, indexname;

-- 6. HOW BIG IS THE BIGGEST CLIENT'S PARCEL SET?
--    client.html does parcels.select("*") with NO limit, so this number is
--    pulled in full on every load for that merchant.
select client_id, count(*) as parcels
from public.parcels
group by client_id
order by 2 desc
limit 10;

-- 7. CONNECTION PRESSURE (dashboard showed 29/60 on a MICRO instance).
select state, count(*)
from pg_stat_activity
where datname = current_database()
group by state
order by 2 desc;
