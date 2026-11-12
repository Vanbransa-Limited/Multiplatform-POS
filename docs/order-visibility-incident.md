# Disappearing orders incident — 7 November 2026

## Cross-device settlement — 11 November 2026

The user authorized payment from other devices and then testing and production
deployment of the changes in this session. Unpaid table rounds now synchronize
as receivables before settlement, using their original sale UUIDs. Table IDs
and order references are retained so another device groups the same rounds
into one bill. Shared snapshots offer Pay now and resolve existing server sales;
they never create a replacement sale or a second stock movement.

Checkout reserves the authoritative rounds transactionally. A second device is
refused while payment is in progress, and an unresolved M-Pesa attempt continues
to block a new prompt after the short checkout reservation expires. Settlement
remains idempotent, identifies the staff member receiving the payment, and
checks the provider proof for STK payments. Duplicate button presses are guarded
on the Orders screen. Opening an invoice retains its local, offline read path.

The original device polls its acknowledged open-table rounds and frees a table
only when every round is paid. Snapshots are read before sales history so the
handover from a shared snapshot to its canonical sale cannot leave a gap.
Uploading a round freezes local item removal, preserving the server's financial
record; additional rounds can still be added to the table. Existing devices
must load the new frontend and synchronize before their previously local-only
rounds become payable elsewhere. Shared checkout requires a server connection.

Validation: 186 frontend tests, 144 backend tests, eight desktop/phone browser
checks, the production frontend build and a two-context real-IndexedDB payment
check passed. The latter starts the receiving device with no original local
sale, pays the shared table, refreshes the creating device, and verifies one
sale, one settlement and a freed original table. Financial writes in that check
use a substituted transport; production verification uses read-only checks and
unauthenticated requests that must be rejected before any ledger mutation.

Production deployment completed with the user's explicit authorization.
`createSale`, `settleSale`, `voidSale`, `publishOpenOrders` and the new
`claimSalePayment` were verified ACTIVE after rollout. The tenant/idempotency-key
lookup index reached READY, and the targeted live sale query passed before
frontend publication. Hosting version `9682480dc15ec5c9` was released on
11 November 2026 at 21:28:50 EAT. Live Orders, Till and Tabs HTML and 18 referenced
JavaScript assets matched the built artifacts byte-for-byte. Unauthenticated
requests to all five payment-related callables were correctly refused.
No synthetic production sale or payment was created for verification.

Operators must refresh each device once while online so existing local-only
rounds can synchronize under the new lifecycle before another device pays them.

## Follow-up: Running orders — 11 November 2026

The user reported paid orders remaining in the list and further missing orders
by Judith Nandacha. Added a default Running view with table, staff, age and
amount sorting. Running ignores date filters so an unpaid table cannot fall
off the board at a trading-day boundary. Confirmed payments remain in history.

Pending sales without receivable rows now remain unpaid rather than being
labelled paid. Settled receivables and actual tenders still clear the bill.
Shared held sales use their payment state independently of upload state,
including explicit payment state for zero-value sales. Known round UUIDs prevent
an old shared snapshot from duplicating a sale already present in the ledger.
The board refreshes every minute and offers manual refresh; failed remote
reads retain the previous list with a warning.

Publishing reads the local ledger in one readonly transaction and serializes
requests within the page to prevent overlapping whole-snapshot requests from
finishing in reverse order. This does not serialize separate browser tabs or
recover previously lost records.

Validation: 183 frontend tests, 141 backend tests and desktop/phone browser
checks pass. These are local code changes; no production deployment performed.

Read-only production checks for Judith Nandacha on 11 November found nine saved
sales today and two current running table snapshots: ORD-319-487430 (KES 2,850)
and ORD-709-021474 (KES 520), both matching the supplied screenshot. Six older
held standalone sales had zero outstanding but were still labelled unpaid by
the legacy publisher, confirming the misleading running-state presentation.

All four Judith snapshots archived today match canonical saved sales by their
original sale UUIDs: ORD-319-701709 maps to invoices 002257/002258;
ORD-013-125656 maps to 002265/002266; standalone references 657695 and 050187
map to invoices 002262 and 002267 respectively (all INV-BH001). The fiscal
references differ from the original order references. This establishes that
those four removals have corresponding saved sales, not that every unspecified
missing order has been recovered or every completed sale has been paid.
No production sale, payment, or snapshot was changed by these checks.

Removed the customer-facing labels “ON A TILL” and “Watching only”; shared
orders now state RUNNING/PAID and identify the staff member. The existing
restriction on editing or taking payment for another device's local order is
explained beside the order rather than used as its status.

The user reported orders disappearing from Orders/Tab Management after the
performance releases. They identified a possible Table 20 by Sherryl and an
additional order by Stacy, and confirmed Table 20 was also missing on its
creating browser. Treat recovery as **unconfirmed** until that browser's local
ledger is inspected. Passing synthetic tests does not establish recovery.

Read-only production checks found the sale and publishing Functions ACTIVE,
history indexes READY, and history query smoke checks successful. The project
contained 2,110 sales at inspection time; new sales continued arriving. Recent
saved sales associated with Ayuma Sherryl and Stacy Amondi were present. The
targeted canonical `tableNumber == "20"` query returned no sale, and none of the
four current held-order snapshots matched those staff members or Table 20.
These checks cannot read the original till's IndexedDB, identify an uncertain
reference conclusively, or prove a missing record was ever committed.

## Reproduced risks and containment

- A failed local Orders snapshot read cleared `posOrders`. Keep the last
  complete list and show an explicit stale-data warning instead.
- Overlapping refreshes could finish out of order and overwrite a newer list.
  Reject stale generations and read the local tables in one readonly transaction.
- Tab creation and round persistence were separate commits. Resolve/create the
  tab inside the sale transaction, and serialize automatic close checks in a
  transaction over tabs, sales and payments.
- An unpaid round whose header was missing or incorrectly SETTLED was excluded
  by the open-tab query. Surface it as a read-only recovery candidate without
  changing the tab or creating a replacement sale. Explicitly CLOSED write-offs
  stay closed. Remote unpaid table-numbered snapshots also remain visible even
  when published as standalone sales rather than tab snapshots.
- Booked server credit sales could move to the Completed board while still
  unpaid. Keep them on the floor's Pending board until their receivable settles;
  financial booking status and server balances are unchanged.
- Seed-version cleanup could clear synchronized history and tab identities.
  Refuse automatic clearing whenever sales, payments or tabs are present, and
  remove the boot-error suggestion to clear browser data.

Tab Management now has **Check saved orders on this till**. Enter `20` in the
search field, then use the check on the original creating browser. It reads
saved local records, including closed and voided rows, and shows their original
reference, status, acknowledgement and tab-header state. It performs no writes.
The result determines whether a specific order can be recovered from the saved
ledger or whether other evidence is required. Do not recreate or charge an
order based only on an absent card.

## Validation

167 frontend tests passed. New regression cases cover read failures, late
snapshots, unpaid-round visibility with missing/settled headers, explicit
write-off exclusion, credit remaining pending, and seed cleanup refusing to
erase synchronized history. The production build and type checking passed.

`node frontend/e2e/order-integrity-check.mjs` uses isolated Chromium/IndexedDB
and the actual till registration methods. It injects a line-write failure and
checks that no partial tab, sale, payment or line remains; a successful retry
produces one coherent pending order. The read-only local check finds that
synthetic Table 20 without changing the ledger.

No production sale, payment, stock record or tab has been rewritten as part of
this investigation. Actual Table 20 and Stacy order recovery remains open.

Containment Hosting release `9448e6320d8a48dd` deployed on 7 November 2026 at
19:46 EAT. The original creating browser must perform the local saved-order
check; its browser database is not accessible from the server diagnostics.

## Follow-up: Tables 4, 8 and 16

The user subsequently identified Tables 4, 8 and/or 16. Targeted server reads
found older sales for Tables 4/16 and an older Table 8 sale, but no current held
snapshot for those tables or Table 20. The four existing held snapshots were
last published in September/October. The original browsers were not remotely
available for local-ledger inspection.

A concrete publishing defect was found: `SyncManager.publishOpenTabs` returned
silently when the local `devices` table was empty. Firebase-mode seed does not
populate that table, although the build's configured `DEVICE_ID` is already
used by checkout and shift creation. Publishing now uses the configured ID and
current branch, with a legacy device-row branch fallback. Publishing failures
warn the operator instead of being silently swallowed. Reads of other tills'
snapshots use that same identity. This code path can explain absent shared
copies; it does not prove what happened to a particular original local record.

Unsubmitted carts and parked carts were memory-only. Added session-storage
backup scoped to tenant/staff/branch in the same browser tab, restoring table
selection and work across reload/navigation. A draft ID on the local sale
prevents restoring a committed cart as a second sale after a crash. Restored
unresolved M-Pesa drafts cannot take payment again before reconciliation.
This is forward protection; it cannot restore earlier memory-only work that
was already discarded. It does not guarantee survival after a browser tab is
closed or its storage cleared.

The publisher now archives each omitted open-order snapshot in
`open_order_archive` in the same commit that removes it from the live board.
Archive entries are server-only under the existing default-deny rules. This is
observability/recovery data, never a new financial sale or payment. Malformed
and oversized snapshots are rejected without clearing existing orders, and
large replacements preserve archive/delete pairs in bounded batches.

Read-only Firestore historical queries at 15/30/45/55 minutes before inspection
also found no matching held snapshots. Point-in-time recovery was disabled;
the available database history extended back about one hour. This is a limit
of inspected server recovery evidence, not proof that a local order was never
saved. No historical order was fabricated or charged.

172 frontend and 121 backend tests passed. Real-browser tests verified
same-tab reload restores draft/table/parked state, avoids restoring a committed
order twice, and blocks repeat payment for an unresolved recovered attempt.
The existing real IndexedDB order-transaction integrity check also passed.
The publisher Function update completed successfully at approximately
20:12 EAT on 7 November 2026, retaining existing instance capacity.
Hosting release `fe2b4c305b9257e1` completed at 20:13 EAT. Live Till, Tabs and
Orders HTML matched the built artifacts, and production metadata confirmed the
publisher ACTIVE with the new update timestamp. Actual reported order recovery
remains unconfirmed pending original-browser inspection.
