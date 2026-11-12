# Performance follow-up — 7 November 2026

The first release improved background synchronization but left expensive work
on the normal till/tab path. This follow-up also checks production metrics,
rather than extrapolating every delay from synthetic history size.

## Production observations

Read-only Firestore aggregation and Cloud Monitoring checks found approximately
2,106 sales, 2,206 payments, 4,947 sale lines, 2,357 M-Pesa attempts and five menu
orders. Counts were project-wide, not per tenant, and changed slightly during
the investigation as the business continued trading. Firestore's actual region
is `europe-west1`, matching the source's Function region default.

Over the preceding 24 hours, the **maximum hourly p95** by service was:

| Service | Request latency | Container startup latency |
| --- | ---: | ---: |
| createSale | 651 ms | 5,345 ms |
| getMpesaCapability | 1,244 ms | 2,755 ms |
| initiateMpesaStk | 12,661 ms | 4,417 ms |
| queryMpesaStatus | 10,368 ms | 3,031 ms |
| mpesaCallback | 14,411 ms | 3,634 ms |

These are separate Cloud Run metrics, not additive timings or end-to-end
checkout measurements. They show material latency in M-Pesa endpoints and
cold starts, alongside the browser-side inefficiencies. They do not identify
how much of a particular cashier's wait came from the network, provider,
database or startup. Daraja verification remains required before confirming
payment; no change treats an unverified callback as successful money.

`node scripts/performance-status.cjs vanbransa-pos --check-queries` reproduces
the read-only checks using the existing Firebase CLI login. It prints counts,
timings and index states, never customer rows or authentication material. Query
smoke checks use a sampled tenant internally and projected metadata, with no
payment initiation or business writes. Do not interpret the aggregate count
request's network time as the full POS query's performance.

## Executed fixes

- `readOpenTabs` now queries open tabs by branch/status, their sales by tab ID,
  then only their payments and lines. With no open tabs it performs no sales,
  payment or line reads. `freeSettledTab` likewise reads only its rounds' payments.
- Finding the tab for a new round now searches open tabs only.
- `pullSales` uses indexed server-side date candidate queries. Both Firestore
  Timestamps and legacy ISO strings are included, with `createdAt` fallback;
  duplicate candidates are merged and the existing `soldAt || createdAt`
  precedence is applied before selecting children. The existing 90-day default
  is unchanged; reports can request another start date.
- Narrow line/payment reads use tenant-scoped `saleId in [...]` batches of at
  most 30, with at most four concurrent requests per child collection. Selections
  over 120 sales use a bulk tenant query filtered by the selected IDs, avoiding
  dozens of query waves on broad history views. Failed batches fail the refresh
  rather than returning incomplete history as success. Bulk history reads remain
  a candidate for a separate incremental-sync design as history grows.
- Matching local sales use the `sale_uuid` index. The cache refresh commits in
  one local transaction and skips unchanged sale updates, preserving local IDs,
  cross-device credit settlement and duplicate-payment protections.
- Reports read local lines/payments only after selecting the relevant sales.
  Financials loads local queued sales and their payments only; server records
  remain the source for synchronized financial history.
- Orders renders cached rows and starts its live subscription before awaiting
  history refresh. It marks cached data as refreshing and updates after the
  server response. Tab Management renders local tabs before reading remote tabs.
  Disposed views do not redraw after navigation. This directly addresses the
  user's clarification that Orders and tab management remain slow.
- STK initiation no longer calls `getMpesaCapability` first. Checkout still
  displays server-read capability, and the initiation transaction itself
  enforces tenant, active staff, lifecycle, branch and payment configuration.
  Server refusals remain unavailable; success still needs provider confirmation.

## Verification

- 157 frontend tests passed and the production build/type check passed.
- New tests cover batch size/concurrency, tenant/date scoping, legacy dates,
  partial-read failures, unchanged-sale writes, credit settlement, exact open-tab
  totals, branch boundaries and STK rejection without a duplicate preflight.
- Deferred-server tests prove cached Orders renders and live subscription setup
  complete while server history is still pending; completion after navigation
  cannot redraw the disposed view.
- Real Chromium with 20,003 synthetic sales: open-tab loading fell from
  **195.5 ms to 7 ms**, with the same total and item count. Whole-history sales,
  payment and line reads are forbidden by the new-path browser harness.
- The queue migration and outbox checks still pass; representative queue
  selection was 188.8 ms versus 0.6 ms in that browser run.

Synthetic timings are single-machine observations. Production user-visible
latency remains the acceptance criterion.

## Deployment and remaining work

Four additive Firestore indexes are required: `tenantId + soldAt`,
`tenantId + createdAt` on sales, and `tenantId + saleId` on payments and sale
lines. Deploy and wait for READY before deploying Hosting; query smoke checks
must succeed first. Existing production indexes are retained.

All four indexes reached READY and production query smoke checks passed
(54 recent candidate sales, with 30 sampled sales yielding 30 payments and
73 lines). Hosting release `16648ac9f53ac7f8` went live on 7 November 2026 at
17:19 EAT. No Function capacity or payment lifecycle changes were deployed.

Keeping checkout/payment Functions warm could address measured startup delays
but incurs recurring charges. The user chose to keep current costs and optimize
code first; capacity remains unchanged. M-Pesa provider latency still requires
separate measurement and cannot be solved by browser history optimizations.
The full Financials reconciliation fetch still includes all tenant financial
records to preserve undated/out-of-period exceptions and older linked receipts.
Replacing it with scoped queries/aggregates remains a distinct change that
requires financial parity checks.
