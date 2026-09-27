# NovaX Rider Launch Audit

Scope: rider.html, its new standalone scripts, shared payment rules, service worker, rider status/expense/cash RPCs and their existing status/column guards. Launch scope is deliveries, pickups and returns. This is not a claim that every possible device, production trigger or network condition has been tested.

## Launch Decision

Controlled rider pilot recommended, not an unconditional full-fleet launch. The code and backend safety fixes are implemented. Local SQL and DOM regressions pass. Real rider login, camera/GPS permissions and a supervised physical cash handover still need a production acceptance check.

## Confirmed Issues Addressed

| # | Severity | Previous failure | Change |
|---|---|---|---|
| 1 | Critical | Pickup statuses were absent from the route query. | Assigned New booked and Collected by rider jobs have a Pickups screen. |
| 2 | Critical | Return stages were absent. | Four active return stages plus recent returned-to-shipper history are loaded. |
| 3 | High | Karachi riders without destination city metadata could not load. | Assignment, not inferred Lahore/Islamabad city names, determines the route. |
| 4 | High | Pickup and return cards showed recipient details. | Origin tasks use the assigned parcel's shipper contact. |
| 5 | High | Failed return attempts could look like destination deliveries. | Recent return history preserves the origin contact context. |
| 6 | Critical | One global offline queue could replay under a different rider. | Queues are scoped to authenticated user and rider IDs; session is checked before sending. |
| 7 | Critical | Storage failure was swallowed while the UI claimed an action was saved. | Durable writes are verified before any network submission. |
| 8 | Critical | Weak internet with navigator.onLine=true lost status intent. | Every write starts with a persisted request, not only offline writes. |
| 9 | Critical | A response lost after commit produced a new request key. | Retries retain the original persisted idempotency reference. |
| 10 | Critical | Retry failures were removed from the queue. | Transient failures remain pending; rejected requests remain visible for review. |
| 11 | High | Reconnect and initial-load flushing could be skipped by loading flags. | Flushing starts after loading finishes and on periodic recovery. |
| 12 | High | GPS was captured on reconnection rather than at delivery. | Location is captured and persisted with the original action. |
| 13 | High | There was no recoverable offline route snapshot. | An owner-scoped snapshot is cached; offline identity reuse is limited to 24 hours. |
| 14 | High | An initial load failure trapped the rider behind a spinner. | Retry and sign-in recovery actions are available. |
| 15 | High | A missing application script could leave an endless spinner. | An independent startup timeout exposes recovery. |
| 16 | High | Profile/session changes did not stop active UI actions. | Auth changes close access; refresh rechecks role, status and rider assignment. |
| 17 | High | Logout ignored returned errors and could sign out other devices. | Local-device sign-out is used and failures are displayed. |
| 18 | Critical | Frontend batch validation silently submitted only valid AWBs. | The whole submitted batch is validated or nothing is submitted. |
| 19 | Medium | Empty and oversized batches reached the server. | Both browser and RPC enforce 1-200 AWBs. |
| 20 | Medium | Already-received rescans were treated as failures. | Idempotent no-op acknowledgement is supported. |
| 21 | Critical | Concurrent same-key RPCs could race before replay was recorded. | Per-rider transaction locks cover status, expense and handover writes. |
| 22 | High | Status RPC relied only on broad generic transition rules. | A rider-specific transition whitelist is enforced. |
| 23 | High | Refusal/unavailable reasons were not enforced server-side. | Both layers require a bounded reason. |
| 24 | High | Malformed GPS could fail arbitrary numeric casts. | JSON numeric types and coordinate ranges are validated. |
| 25 | Critical | Prepaid markings could hide a positive COD amount. | The shared payment classifier is loaded; conflicts block delivery and cash handover. |
| 26 | High | One accidental Delivered tap committed immediately. | A modal confirms physical delivery and exact expected collection. |
| 27 | High | Browser and server history field names differed. | Readers accept status/to; new history writes include both. |
| 28 | High | Legacy Pakistan timestamps were treated as the phone's timezone. | Legacy timestamps are parsed as PKT; day boundaries are computed in Asia/Karachi. |
| 29 | High | Updated-at changes could shift delivery into the wrong day. | Delivered-at is preferred, then actual delivery history. |
| 30 | High | limit(2000) could still silently hit a server row cap. | Stable 500-row pagination is used; >1,000 assigned rows were tested. |
| 31 | Critical | Old cash rows with absent cashReceived metadata could disappear. | All-age undeposited deliveries include absent and false metadata. |
| 32 | Critical | Cash UI subtracted today's expenses while the server used all unsettled expenses. | Server reconciliation drives the figures and confirmation. |
| 33 | Critical | One expense could be deducted again on the next handover. | Deducted expenses receive settled, settledBatch and settledAt atomically. |
| 34 | High | Duplicate embedded expenses could be counted repeatedly. | Expense IDs are deduplicated for reconciliation. |
| 35 | High | Browser expense read/merge/write could overwrite concurrent parcel metadata. | A locked, idempotent expense RPC appends the entry. |
| 36 | Critical | Direct rider metadata writes could tamper with financial state. | Protected fields and rider status/meta writes require the secure action path. |
| 37 | High | Riders could directly fabricate audit scans or COD ledger entries. | Evidence writes require the trusted rider transaction flag. |
| 38 | Critical | Blocked profiles still resolved through my_rider_id(). | The helper returns an ID only for an active rider profile. |
| 39 | Critical | Cash could change between UI confirmation and recording. | The checked handover RPC compares gross, expense and net amounts under locks. |
| 40 | Critical | Deposit retries used new keys and falsely claimed nothing changed after a network error. | Handover intent is persisted and response-loss language describes uncertainty accurately. |
| 41 | High | Expenses greater than gross were silently floored, losing the reconciliation problem. | Handover is blocked for office review; expenses remain unsettled. |
| 42 | Medium | Search claimed to match phone numbers that were not searchable. | Raw and normalized contact numbers are included in the search index. |
| 43 | Medium | A no-result search looked like a broken empty page. | Each filtered list shows a no-matching-parcels state. |
| 44 | Medium | Search was lost after re-rendering. | Search is reapplied after every render. |
| 45 | Medium | Reason overlay lacked native focus containment and Escape handling. | Native dialog semantics are used. |
| 46 | Medium | Unsupported barcode APIs failed without a clear alternative. | Capability checks, manual entry, image size limits and bitmap cleanup are included. |
| 47 | Medium | Short phone values became unreliable dial links. | Invalid dial links are omitted; Pakistan and explicit international formats are handled. |
| 48 | Medium | Long AWB/status text could squeeze or overflow small screens. | Responsive constraints, wrapping and stable status widths were added. |
| 49 | High | Offline navigation could return the merchant portal instead of the rider portal. | The service-worker fallback is route-specific. |
| 50 | High | Rider HTML and unpinned CDN code were not an offline-ready set. | A same-origin pinned SDK and matching app/CSS assets are precached. |
| 51 | Medium | A live realtime socket prevented polling even when reassignment events were missed. | Polling continues; visibility/reconnect refreshes are included. |
| 52 | Medium | Every parcel change globally reloaded this rider's route. | Realtime events are rider-filtered and debounced. |
| 53 | Medium | A broad button reset could enable blocked financial actions. | Action state is derived from authorization, queue, connection and reconciliation state. |
| 54 | Medium | Straight-line GPS distance was presented as route mileage/fuel. | It is explicitly a between-stop estimate, not road mileage or a fuel claim. |
| 55 | Medium | Rider bundles had no cache-version regression guard. | Content-hash URLs are checked before publication. |
| 56 | Medium | Configured rider cash limits were invisible. | Cash above the configured limit produces an office-contact warning. |

## Verification Completed

- `node scripts/test-rider-sql.mjs`: isolated PostgreSQL 17 fixture, current generic status trigger and latest column/delivery-time guards. Tests include ownership, rollback of mixed batches, pickups, returns, reasons, GPS, payment conflicts, replay, concurrent replay, blocked accounts, direct evidence tampering, expenses, expected handover figures and one-time deductions. No production parcel transitions or cash declarations were used for tests.
- `node scripts/test-rider-ui.mjs`: isolated JSDOM/Supabase fixture. Tests include scoped queues, storage rejection, PKT parsing, contacts, search, mixed batch rejection, a committed response lost in transit, offline persistence/reload, more than 1,000 rows, review retention and auth revocation.
- `node scripts/check-build.mjs`: HTML/JS syntax, tracked-file secret scan, merchant bundle preservation, rider asset hashes and payment-rule parity.
- Browser fixture: all six screens at an observed 320 CSS pixels had zero horizontal overflow. Main workflows also fit at observed 390 CSS pixels; desktop at 1280 CSS pixels and the brand image loaded. Cash confirmation dialog and native focus behavior were inspected. Browser warning/error log was empty during this fixture check.
- Supabase migration execution returned success. Live checks confirmed the summary, expense and checked-handover RPCs exist; anonymous summary access is denied; rider resolution requires active status.
- Before migration, production had two handover records with zero recorded expense deductions. No historical cash/expense backfill was performed.

## Remaining Launch Gates And Limitations

1. Run one supervised pilot on the actual Android/iPhone hardware: sign in as a real rider, receive an assigned pickup, make a delivery and complete a return. Camera and GPS permission behavior cannot be certified from desktop fixtures.
2. Test one physical cash handover with the Karachi office and verify its existing Admin confirmation screen. The admin confirmation implementation was not redesigned into a new atomic RPC in this task.
3. Assignment still happens through existing office workflows. This page does not claim unassigned parcels or create rider applications/accounts.
4. A failed return attempt remains an office exception. The existing backend has no distinct return-reattempt state; do not repurpose a destination delivery reattempt for it without an office decision.
5. Native photo BarcodeDetector is not available in every browser. Manual AWB entry and a keyboard scanner remain supported; a universal camera-scanning library was not added.
6. Offline actions require an already verified, unexpired/cached rider session. First-time sign-in offline, expired authentication, cleared storage and disabled JavaScript are not supported.
7. Legacy unscoped queue entries are not blindly replayed or deleted. The office must reconcile them to the correct rider. Rejected new actions retain their reference and can be retried after office correction.
8. Expenses keep the existing immediate-deduction business policy. This is not an expense approval or receipt-photo workflow. Above-gross or invalid expenses require office reconciliation.
9. A cash-limit warning is not an enforced collection lock. Confirm your operational policy before making it block deliveries.
10. Offline snapshots contain route contact information on the device. Use rider-controlled phones, device locks and logout on shared devices. Cash handover is online-only; every saved status remains provisional until acknowledged.
11. Universal proof-of-delivery photos, customer OTP/signature, turn-by-turn route optimization, bank transfer automation and device-level background syncing are not included. Decide which are required before expanding beyond the pilot.
12. The test fixture does not reproduce every production trigger/RLS combination or a 1,000-parcels/day multi-rider load. Monitor database latency, rejected RPCs and reconciliation daily during the pilot.

## Tomorrow's Acceptance Checklist

- Office assigns separate pickup, destination delivery and origin return jobs to an active rider.
- Rider signs in on their actual phone, checks shipper/recipient contact and correct COD amount.
- Office and rider verify a controlled delivery confirmation, including a prepaid Rs 0 delivery.
- Switch to airplane mode after loading the route, save an action, restore signal and confirm one server acknowledgement with the same reference. Do not clear browser data while actions are pending.
- Add one legitimate route expense, physically hand over the reconciled amount and have the office confirm receipt. Verify the expense does not deduct from the next handover.
- Keep the first release to a small supervised rider group until these checks pass.
