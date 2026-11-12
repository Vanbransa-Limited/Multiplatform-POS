# POS performance audit — 7 November 2026

The source contains concrete causes of slowdown as sales history accumulates,
even with three or four concurrent staff. The strongest evidence is repeated
browser database scans, rather than insufficient server capacity. Production
latency, Firestore volumes, transaction retries, network conditions and device
memory were not available in this session, so this is a source audit and local
verification, not a claim that every live bottleneck is resolved.

## Findings and executed changes

| Priority | Evidence | Change |
| --- | --- | --- |
| High | `SyncManager.syncOutbox` scanned every sale to find pending work and scanned again to count the remainder, every ten seconds. | Added IndexedDB v7 `sync_pending` index. Both queries now visit pending sales only. |
| High | `localHeldOrders` loaded all sales, lines and payments on every publication, including quiet tills. | Read pending sales first; return immediately if empty; fetch child rows through `sale_id` indexes and relevant customer IDs only. |
| High | `tabItems` and `roundsBeingSettled` loaded the entire payment ledger during checkout. | Query payments for the selected tab's round IDs. |
| Medium | Identical held-order snapshots called a Function and rewrote their server documents every ten seconds, sometimes twice per drain. | Publish changed snapshots immediately and acknowledged unchanged snapshots once per minute. Failed publications remain retryable next tick. Empty snapshots still clear settled orders. Cache keys include tenant, staff, branch and device. |
| Medium | Till checkout renewed its held-order lease on an interval, but the view had no `dispose` method. Leaving checkout could retain view state and renew indefinitely. | Dispose stops lease renewal; asynchronous order registration checks disposal before starting another timer. The existing lease expires naturally. |
| Medium | Financial M-Pesa reconciliation repeatedly scanned sale UUID maps for truncated references, potentially multiplying sales history by payment attempts. | Build reusable prefix indexes by reference length. Preserve exact-match priority and the previous first-prefix behavior. |
| Medium | `pullSales` searched the whole payment response for each locally matched sale when reconciling credit settlements. | Build a set of settled credit sale IDs once. |
| Medium | Offline/demo stock lookup loaded every stock movement for each product. | Use the existing `product_id` index before branch/location filtering. |

On a quiet authenticated till, the original scheduler could scan sale history
three times per ten-second tick: outbox selection, held-order publishing, and
outbox counting. At 20,000 sales that is approximately 21.6 million sale-row
visits per hour per till, plus line and payment history scans. This is a code
path calculation, not a measured production read count; IndexedDB reads are
local browser work, separate from billable Firestore reads.

## Migration and correctness

`synced_at` is frequently null or absent, which IndexedDB cannot use as an
index key. The numeric materialized index avoids that problem. The upgrade
scans existing sales once and writes only unsynced records. It does not delete
or reseed records. Creating/updating hooks maintain membership in the same
transaction as the original sale write, covering add, put, bulkPut, update and
modify paths. Synced historical records may have no membership field; queries
only require pending records to carry `1`.

Queue policy still excludes voided orders, open unpaid tab rounds, and active
checkout leases. Publication still includes held orders that are not ready for
transmission. Failed publication acknowledgements are never cached.

## Verification

- Frontend unit suite: **143 passed**.
- Backend unit suite and TypeScript build: **119 passed**.
- Frontend production build and type checking passed during verification; the
  final build is repeated after the last source changes.
- Real headless Chromium/IndexedDB check: **20,003 pre-upgrade sales**, plus
  20,000 historical lines and 20,000 historical payments. Verified migration,
  absent/null timestamps, inserts, synced updates, replacement puts, unrelated
  updates, bulk imports, indexed queries, held-order line/payment contents,
  void exclusion and an empty queue after drain.
- The held-order test throws if sales, payments or lines use whole-table
  `toArray`, guarding against returning to the expensive historical reads.

Representative final browser run on this machine:

| Operation | Time |
| --- | ---: |
| v6 → v7 upgrade, 20,003 sales | 469.7 ms |
| Previous full-history pending lookup | 144.2 ms |
| Indexed lookup, same two eligible sales | 0.6 ms |

These are single-run synthetic timings, not an end-to-end checkout benchmark
or a production SLA. The earlier all-record rewrite migration took tens of
seconds and was replaced before delivery with the pending-only migration.

Reproduce with `node frontend/e2e/performance-check.mjs`. It uses an isolated
localhost browser origin and synthetic data, and does not contact Firebase.
Chromium must be installed for the existing Playwright dependency.

## Remaining recommendations, in order

1. **Redesign cloud history reads.** `pullSales` downloads tenant-wide `sales`,
   `payments` and `sale_lines` before applying its 90-day default locally.
   `loadFinancialSnapshot` downloads five tenant collections for each report;
   `watchCustomerOrders` subscribes to all customer-order history. Pagination
   currently limits displayed rows, not transferred rows. Add server-side
   date/status queries and cursor pagination, then incremental refresh using
   trusted update timestamps. Fetch related lines/payments by sale IDs in
   bounded batches. First inventory timestamp completeness and legacy formats.
2. **Preserve reconciliation coverage when bounding reports.** Financials
   deliberately surfaces undated receipts, payments outside the chosen period,
   outstanding orders and receipts against older sales. Simply adding a
   `paidAt >= from` limit would change those results. Use separate indexed
   queries or server aggregates for period activity, unpaid balances, undated
   exceptions and out-of-period summaries. Backfill canonical timestamps and
   staff attribution before switching queries. Add matching Firestore indexes
   and validate against an authoritative ledger on staging.
3. **Measure four-client behavior on staging.** Use representative historical
   volumes and four separate browser contexts. Record p50/p95 for sign-in,
   catalogue readiness, order view, reports and sale confirmation; monitor
   queue age/count, browser long tasks/heap, Function duration/errors/cold
   starts, Firestore document reads and transaction retries. Suggested starting
   acceptance targets: local cart interactions under 100 ms p95, no repeated
   main-thread tasks above 50 ms while idle, and queue drain comfortably inside
   the ten-second scheduler period on the normal connection. Set network
   operation targets from measured regional latency.
4. **Investigate shared-document contention only if measured.** Every sale
   reads the branch invoice counter and writes stock, shift and customer
   records transactionally. These are possible contention points, but three
   or four users alone do not establish that they are saturated. Preserve
   atomic stock/payment/idempotency behavior and invoice requirements. Do not
   shard invoice counters or weaken the transaction speculatively.
5. **Confirm deployment region and cold starts.** Source defaults align
   frontend callables and backend Functions on `europe-west1`; the backend
   comment says Firestore is there too. Verify actual resources before
   considering a region migration. Consider paid minimum instances only if
   cold-start measurements justify them.
6. **Plan retention after synchronization is proven.** Keep queued sales and
   payments intact. Historical browser data can eventually be archived or
   evicted only when server persistence, reconciliation, recoverability and
   retention obligations have been established. Clearing browser storage is
   not a performance fix for an offline-first till.

The README describes frontend directories that are absent in this workspace;
the running implementation uses `frontend/app`, `frontend/components` and
`frontend/src/services` with Dexie. This audit follows the actual source.

## Rollout

Following user authorization, deployed to `vanbransa-pos` Firebase Hosting on
7 November 2026 at 16:26 EAT. Live version: `54af361c35f9c19f`.
HTTP checks of `/till/`, `/orders/` and `/finance/` returned 200 and their
SHA-256 hashes matched the built HTML exactly; page cache headers require
revalidation. This release changes frontend behavior and IndexedDB schema
only; Functions and Firestore rules were not deployed. Reload live tills
during a quiet period. Close older application tabs to allow the version upgrade.
Verify queued sales survive the upgrade, settle a tab, confirm it on another
device, and compare financial totals before/after. A code rollback can retain
the additive database field/index; do not delete IndexedDB to roll back.

## Primary references

- [Firebase Firestore best practices](https://firebase.google.com/docs/firestore/best-practices): asynchronous reads, cursor pagination and workload testing.
- [Firestore real-time queries at scale](https://firebase.google.com/docs/firestore/real-time_queries_at_scale): query scope, location and listener scaling.
- [Dexie updating hooks](https://dexie.org/docs/Table/Table.hook%28%27updating%27%29): atomic membership maintenance across update and put paths.
