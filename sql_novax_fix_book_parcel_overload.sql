-- ===========================================================================
-- URGENT: bookings are failing with
--   "Could not choose the best candidate function between:
--    public.client_book_parcel(... 13 args ...),
--    public.client_book_parcel(... 13 args ..., p_allow_open => text)"
--
-- WHAT HAPPENED
-- Adding p_allow_open did not replace client_book_parcel, it created a second
-- one. CREATE OR REPLACE FUNCTION only replaces when the argument list is
-- identical; change the arguments and Postgres treats it as a NEW overload and
-- keeps the old one. So the database now holds two functions with the same
-- name, and any call that could satisfy both -- a 13-argument call, when the
-- 14-argument version gives p_allow_open a DEFAULT -- is ambiguous. Postgres
-- refuses to guess and raises 42725, which the merchant sees raw on the
-- booking form.
--
-- WHY IT REACHED PRODUCTION
-- novax_allow_open_v1.sql is referenced in client.html but does not exist in
-- this repository -- it was run straight against the database. Nothing in the
-- repo could have flagged the collision, and there is no test that books a
-- parcel. This file is committed for exactly that reason: the fix must not
-- live only in the database as well.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR, IN ORDER.
-- ===========================================================================


-- STEP 1 -- look before you cut. Confirms there really are two, and shows
-- whether the 14-arg version defaults p_allow_open (it must, or 13-arg callers
-- break when the old one is dropped).
SELECT p.oid,
       pg_get_function_identity_arguments(p.oid) AS signature,
       pg_get_function_arguments(p.oid)          AS args_with_defaults,
       p.pronargs                                AS arg_count,
       p.pronargdefaults                         AS defaulted_args
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
AND    p.proname = 'client_book_parcel'
ORDER  BY p.pronargs;


-- STEP 2 -- back up BOTH bodies before dropping anything. Copy the output into
-- a file. These functions exist nowhere else; a wrong drop with no backup is
-- unrecoverable.
SELECT pg_get_functiondef(p.oid)
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public' AND p.proname = 'client_book_parcel'
ORDER  BY p.pronargs;


-- STEP 3 -- does anything else call the old 13-argument form? client_book_parcel_geo
-- wraps it, and if it calls with 13 arguments it will start failing the moment
-- the old one is gone (unless STEP 1 showed p_allow_open has a default).
SELECT p.proname, pg_get_functiondef(p.oid) AS body
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
AND    pg_get_functiondef(p.oid) ILIKE '%client_book_parcel(%'
AND    p.proname <> 'client_book_parcel';


-- STEP 4 -- the fix. Drops ONLY the older 13-argument overload, leaving the
-- one that accepts p_allow_open. The argument types below are taken verbatim
-- from the error message, so this cannot match the wrong function.
DROP FUNCTION IF EXISTS public.client_book_parcel(
    text,      -- p_consignee
    text,      -- p_phone
    text,      -- p_pickup_city
    text,      -- p_city
    text,      -- p_address
    numeric,   -- p_cod
    text,      -- p_weight
    text,      -- p_service
    text,      -- p_category
    text,      -- p_fragile
    text,      -- p_payment_mode
    text,      -- p_order_id
    text       -- p_reference_no
);


-- STEP 5 -- verify exactly one remains, and that it is the 14-argument one.
SELECT pg_get_function_identity_arguments(p.oid) AS remaining_signature
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public' AND p.proname = 'client_book_parcel';
-- Expect ONE row, ending in ", p_allow_open text".


-- STEP 6 -- book a real parcel from the merchant portal before calling it done.
-- A Karachi destination specifically: that is the path in the screenshot, and
-- it is the one that routes through client_book_parcel_geo.
