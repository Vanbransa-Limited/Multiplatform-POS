# Stop the recurring tab, bill and correction patches

Agreed 26 Nov 2026 with the owner. Deferred: M-Pesa provider confirmation (C2B) and a
staging release step.

## Why the same issues keep returning

1. **Every device computes its own truth.** Tab headers live only on the device that
   opened them; each till decides open/owed/paid/free from its local copy. The
   server has the bills but no tab record. Paid tables that never freed up, tablets
   that could not add to another till's tab, and "paid but pending" were all
   devices disagreeing.
2. **A bill cannot take more items.** Staff ring a second bill or re-ring
   duplicates (003423, 003403, 003457 + 003463, Nicole's five table-3 voids).
3. **Corrections are one-off scripts.** A mistyped amount or a duplicate needs a
   developer; the 25 Nov script was committed and never applied.
4. **No multi-device test.** Nothing proves "open on A, add on B, pay on C, table
   free everywhere" before a release.

## Decisions

- Tablets may ring rounds offline; they queue and upload on reconnect. Whenever a
  device is online, tab state comes from the server only. Offline, the last known
  view is shown and marked offline.
- Ship phase by phase. Each phase goes live only after its emulator scenario passes.

## Phases

| Phase | Change | Gate (emulator scenario) |
| --- | --- | --- |
| A | Multi-device tab lifecycle scenario (`backend/functions/e2e/tab-lifecycle.cjs`), run by `npm run test:emulator` on Node 22. | Open on device A, add on B, settle from C; the next round on that table starts a new tab; a voided-only tab owes nothing. |
| B | Server-side table record. `table_sessions/{table}` becomes the tab: status, tabId, order reference, due, round ids. Recomputed from the bills by one helper (`refreshTableSession`) right after each writer commits (`createSale`, `settleSale`, `voidSale`, `addRoundStaffDiscount`); after a reconciliation script, run `scripts/backfill-table-sessions.cjs --apply`. Clients watch open sessions live; Tab Management and the till's table picker read them. Local headers remain only for rounds not yet uploaded. | Session status/due match the bills after every step of phase A, including from scripts. |
| C | Add items to any unpaid bill. `createSale` accepts the bill to join; the round takes that bill's tab (a bill without a table gets one). Orders shows Add items on every unpaid bill. | Adding to an unpaid walk-in bill yields one bill to pay, one payment settles both, no duplicate. |
| D | Owner correction tools in the app, audited, replacing scripts: correct a staff-recorded M-Pesa total (`correctReceiptTotal`, never below what is already allocated, stays unverified) and void a duplicate bill from Orders. | Correcting 500 → 850 lets the remaining 350 settle; a non-owner is refused; every change has an audit row. |

Order of delivery: A, then B, C, D, each deployed separately (functions before
hosting).

## Status (26 Nov 2026)

| Phase | Commit | Live |
| --- | --- | --- |
| A, B, C (server) | `861fe18` | createSale, settleSale, voidSale, addRoundStaffDiscount; rules; 207 tables backfilled, 21 open |
| B, C, D (devices, owner tools) | `722a904` | correctReceiptTotal; hosting |

Gate: `npm run test:emulator` on Node 22, 9 stages (adds `tab-lifecycle`, `receipt-correction`).
Remaining: M-Pesa provider confirmation (C2B) and a staging release step, deferred by the owner.
Known limits: a tab whose rounds were all rung offline shows only on that device until it uploads;
Void bill and Correct M-Pesa amount use simple browser prompts.
