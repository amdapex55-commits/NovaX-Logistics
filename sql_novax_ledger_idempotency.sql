-- ===========================================================================
-- wallet_ledger idempotency -- 30 Aug 2026
--
-- The rider app and the COD queue both key their ledger writes on
-- "cod:<parcel uuid>" and rely on that key to avoid crediting a merchant
-- twice. Nothing in the database enforced it: the only unique index on
-- wallet_ledger was the primary key on id, so idempotency was a client-side
-- convention. A retried flush after an offline period, or two tabs finishing
-- the same queue, would have written the credit twice and paid a merchant
-- twice.
--
-- Verified before applying: 363 rows, and no (client_id, entry_type,
-- reference_type, reference_id) combination appears more than once -- so this
-- has never actually happened. The window closes here rather than after it
-- does.
--
-- PARTIAL on reference_id is not null, deliberately. Rows with no reference --
-- manual admin adjustments, opening balances -- are legitimately repeatable
-- and must stay that way. Rehearsed under BEGIN/ROLLBACK against production:
-- the index builds clean, a duplicate is rejected, two identical
-- NULL-reference rows still insert, and a distinct reference still inserts.
-- ===========================================================================

create unique index if not exists nv_wl_idem_uq
  on public.wallet_ledger (client_id, entry_type, reference_type, reference_id)
  where reference_id is not null;
