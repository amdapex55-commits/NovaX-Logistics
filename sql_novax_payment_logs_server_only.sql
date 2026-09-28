-- 28 Sep 2026: merchants can no longer insert payment_logs at all.
-- Both row types a merchant could insert are now written by the server:
--   'COD expected'                 trg_nv_log_cod_expected (booking transaction)
--   'Wallet withdrawal requested'  nv_request_wallet_withdrawal_core (21 Sep)
-- and the portal already skips both. nv_guard_payment_logs limited the damage
-- (server-set amount/status/client), but nothing stopped the same row being
-- inserted repeatedly. Admin keeps write access through payment_logs_admin_all.
drop policy if exists pl_ins on public.payment_logs;
revoke select on public.payment_logs from anon;
