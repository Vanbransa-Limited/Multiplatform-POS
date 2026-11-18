# Performance and Artesano payment investigation — 16 November 2026

Status: deployed to Firebase Hosting on 16 November 2026 after explicit user approval. Main working copy and its new eTIMS work remain untouched. No production orders, payments or balances were changed.

## Changes

- Settings, Customers, Staff, Inventory, Shifts and Finance show cached controls/data before advisory cloud refreshes complete. Settings refreshes four reads concurrently and blocks saves until refreshed, retaining non-owner restrictions and edits already typed.
- Till loads cached products, customers and open tabs together. Customer refresh runs afterwards and preserves the selected customer. Customer cache reads are batched instead of one IndexedDB transaction per customer.
- Inventory search keeps the input mounted, caches the catalogue during typing, reads page stock in parallel, appends rows as one fragment, and ignores superseded responses. Background refresh preserves edited count/import forms.
- Orders reads branch-relevant sale children/customer/product records and reports orders still held locally. It now reads the tenant's trading hours instead of always using default hours.
- Paid sales drain before advisory shared-order history/snapshot work. Advisory reads have an eight-second UI deadline; no sale or payment write is raced against a timeout.
- Finance renders its filters immediately while waiting for trusted trading hours before computing the report. Stale/disposed results cannot repaint a later screen. Financial arithmetic and payment verification rules were not changed.

## Evidence and verification

- 217 frontend unit tests passed.
- 12 Chromium payment/dropdown checks passed: pending registration, verified payment commit, safe retry without duplicate sale/payment/stock, failure rollback, and mobile/desktop dropdown behavior.
- Separate two-browser cross-device settlement check passed: one sale/settlement, original device releases the paid table.
- Production build (next build --webpack) passed.
- Isolated Chromium with 1,500 synthetic products: ledger initial render 186 ms before / 80 ms after. Rapid typing keeps the same focused input and exact text.
- Settings with four injected 150 ms reads: readiness 635 ms before / under 1 ms after. This demonstrates removal of network blocking, not a production latency SLA. New data still requires a successful server refresh.

## Artesano, read-only findings

Tenant: tenant-artesano. Configured trading day: 06:00 Nairobi to 05:59 the next morning; night begins 17:00.

| Trading day | Recorded sales | Server sales total | Collections | Unmatched confirmed money |
| --- | ---: | ---: | ---: | ---: |
| Friday 13 Nov | 3 | KES 3,500 | KES 3,500 | KES 0 |
| Saturday 14 Nov | 3 | KES 1,150 | KES 1,150 | KES 0 |

At inspection, 16 verified M-Pesa intents were consumed and all pointed to existing canonical sales. No orphan payment rows or unused verified intents were found. The six failed attempts and one ambiguous KES 2,660 attempt were from 10–11 November, before the reported Friday/Saturday incidents; their statuses were left untouched. A completed tenant-scoped server warning check found no refusals; a later repeat hit the logging API's rate limit and was not retried.

These figures describe records actually on the server. They do not establish staff's expected takings or rule out cash/typed-code orders still held in an affected browser. The two reported missing orders are not yet identified: their amounts, table/order references, receipts and original device state remain needed. Do not erase the affected browsers' local ledgers.

Orders and Financials can also differ if the date window, staff/branch scope, running-tab grouping, or local/server sync state differ. No historical totals were altered to force a match.

Diagnostics: scripts/artesano-incident.cjs (read-only projections; does not output credentials or customer contact details). Evidence logs: artesano-incident.log, latency-tests.log, latency-browser.log, latency-build.log. Local benchmark: frontend/e2e/module-latency-check.mjs.

## Deployment verification

Firebase CLI confirmed Deploy complete. Live till, orders, finance, settings, customers, inventory and shifts pages returned HTTP 200 and exactly matched the verified build. Hosting only; no backend Functions, rules or production financial records were changed. Deployment log: performance-deploy.log.
