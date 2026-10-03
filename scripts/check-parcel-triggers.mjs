// Drift check for the 23 triggers on public.parcels (2 Oct 2026).
// Fails if any trigger is renamed, added, removed, disabled or pointed at a
// different function. Postgres fires triggers of the same timing in NAME
// order, so a rename can silently reorder them -- that is why names matter.
// Run: node scripts/check-parcel-triggers.mjs   (uses ~/.pgpass)
// If a change is intended: update EXPECTED in the same commit, and run
// scripts/test-parcel-walk.sql against production (it always rolls back).
import { execFileSync } from 'node:child_process';

/* Firing order, top to bottom (BEFORE first, then AFTER; each alphabetical):
   BEFORE UPDATE novax_stamp_delivered_at_trg -> novax_stamp_delivered_at
   BEFORE UPDATE nv_auto_transit_batch_trg -> nv_auto_transit_batch
   BEFORE UPDATE nv_rider_write_guard -> nv_rider_write_guard
   BEFORE UPDATE parcels_guard_columns_trg -> parcels_guard_columns
   BEFORE UPDATE parcels_guard_merchant_meta_trg -> parcels_guard_merchant_meta
   BEFORE UPDATE parcels_guard_tracking_token_trg -> parcels_guard_tracking_token
   BEFORE INSERT parcels_set_tracking_token_trg -> parcels_set_tracking_token
   BEFORE UPDATE trg_enforce_parcel_status_transition -> enforce_parcel_status_transition
   BEFORE UPDATE trg_nv_freeze_parcel_money -> nv_freeze_parcel_money
   BEFORE UPDATE trg_nv_one_reattempt -> nv_one_reattempt
   BEFORE UPDATE trg_nv_protect_parcel_contact -> nv_protect_parcel_contact
   BEFORE INSERT/UPDATE zz_nv_stamp_status_since -> nv_stamp_status_since
   AFTER INSERT nv_email_first_booking -> nv_email_on_first_booking
   AFTER UPDATE nv_transit_batch_receipt_trg -> nv_transit_batch_receipt
   AFTER UPDATE nv_zzz_log_owner_change -> nv_log_parcel_owner_change
   AFTER UPDATE nv_zzz_owner_matches_invoice -> nv_parcel_owner_matches_invoice
   AFTER UPDATE nvsh_fulfill_on_handover -> nvsh_mark_ready_to_fulfill
   AFTER INSERT/UPDATE trg_nv_api_enqueue_status -> nv_api_enqueue_status
   AFTER INSERT trg_nv_log_cod_expected -> nv_log_cod_expected
   AFTER UPDATE trg_nv_log_parcel_contact -> nv_log_parcel_contact
   AFTER INSERT/UPDATE trg_nv_woo_enqueue_status -> nv_woo_enqueue_status
   AFTER INSERT/UPDATE trg_parcel_status_log -> nv_log_parcel_status
   AFTER UPDATE zz_nv_swap_sync -> nv_swap_sync
*/
const EXPECTED = [
  "BEFORE UPDATE novax_stamp_delivered_at_trg -> novax_stamp_delivered_at",
  "BEFORE UPDATE nv_auto_transit_batch_trg -> nv_auto_transit_batch",
  "BEFORE UPDATE nv_rider_write_guard -> nv_rider_write_guard",
  "BEFORE UPDATE parcels_guard_columns_trg -> parcels_guard_columns",
  "BEFORE UPDATE parcels_guard_merchant_meta_trg -> parcels_guard_merchant_meta",
  "BEFORE UPDATE parcels_guard_tracking_token_trg -> parcels_guard_tracking_token",
  "BEFORE INSERT parcels_set_tracking_token_trg -> parcels_set_tracking_token",
  "BEFORE UPDATE trg_enforce_parcel_status_transition -> enforce_parcel_status_transition",
  "BEFORE UPDATE trg_nv_freeze_parcel_money -> nv_freeze_parcel_money",
  "BEFORE UPDATE trg_nv_one_reattempt -> nv_one_reattempt",
  "BEFORE UPDATE trg_nv_protect_parcel_contact -> nv_protect_parcel_contact",
  "BEFORE INSERT/UPDATE zz_nv_stamp_status_since -> nv_stamp_status_since",
  "AFTER INSERT nv_email_first_booking -> nv_email_on_first_booking",
  "AFTER UPDATE nv_transit_batch_receipt_trg -> nv_transit_batch_receipt",
  "AFTER UPDATE nv_zzz_log_owner_change -> nv_log_parcel_owner_change",
  "AFTER UPDATE nv_zzz_owner_matches_invoice -> nv_parcel_owner_matches_invoice",
  "AFTER UPDATE nvsh_fulfill_on_handover -> nvsh_mark_ready_to_fulfill",
  "AFTER INSERT/UPDATE trg_nv_api_enqueue_status -> nv_api_enqueue_status",
  "AFTER INSERT trg_nv_log_cod_expected -> nv_log_cod_expected",
  "AFTER UPDATE trg_nv_log_parcel_contact -> nv_log_parcel_contact",
  "AFTER INSERT/UPDATE trg_nv_woo_enqueue_status -> nv_woo_enqueue_status",
  "AFTER INSERT/UPDATE trg_parcel_status_log -> nv_log_parcel_status",
  "AFTER UPDATE zz_nv_swap_sync -> nv_swap_sync"
];

const DB = process.env.NOVAX_DB || 'postgresql://postgres.rhzunbzbdzicajqtohwp@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres';
const Q = "select case when tgtype & 2 = 2 then 'BEFORE' else 'AFTER' end||' '||concat_ws('/', case when tgtype & 4 = 4 then 'INSERT' end, case when tgtype & 16 = 16 then 'UPDATE' end, case when tgtype & 8 = 8 then 'DELETE' end)||' '||tgname||' -> '||tgfoid::regproc||case when tgenabled <> 'O' then ' [DISABLED]' else '' end from pg_trigger where tgrelid='public.parcels'::regclass and not tgisinternal order by (tgtype & 2 = 2) desc, tgname";
const live = execFileSync('psql', [DB, '-Atc', Q], { encoding: 'utf8' }).trim().split('\n');
const missing = EXPECTED.filter(x => !live.includes(x)), extra = live.filter(x => !EXPECTED.includes(x));
const sameOrder = live.length === EXPECTED.length && live.every((x, i) => x === EXPECTED[i]);
if (missing.length || extra.length || !sameOrder) {
  console.error('FAIL: parcel triggers drifted.');
  for (const m of missing) console.error('  expected, not live: ' + m);
  for (const x of extra) console.error('  live, not expected: ' + x);
  if (!missing.length && !extra.length) console.error('  same triggers, different firing order');
  process.exit(1);
}
console.log('PASS: ' + live.length + ' parcel triggers match, in the same firing order.');
