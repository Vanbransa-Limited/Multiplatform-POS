# Server-backed Pay Now

Requested on 10 November 2026. Pay Now saves the till's unpaid order to the
server before taking payment. It appears under Orders > Pending with the existing
Pay now action. The local `server_pending` flag bypasses the older checkout hold;
editable tab rounds retain their earlier behavior until checkout.

Publication waits for the existing `createSale` acknowledgement. Failed saves
retain the local order and report the connection or validation error. A payment
attempt cannot proceed until that order is published. Closing checkout uses Leave
pending rather than automatically voiding the saved order, and starts the next
cart with a fresh draft identity.

Settlement calls `settleSale` for already-published orders. It clears their
receivable rows and records the tender against the same invoice without another
sale creation or stock deduction. The callable returns a stable payment document
ID, including on retry, so the local payment cache and later downloads agree.
The existing refresh logic clears an originating till's receivable when payment
is taken on another till.

Confirmed STK settlement requires an unused verified intent for the same tenant,
attempt and branch. It consumes that intent as well as allocating the attempt's
received amount, so the same receipt cannot fund both a new sale and a pending
invoice. One prompt may still cover several rounds within its received total.

Validation: production frontend build, 179 frontend tests, 140 backend tests and
15 browser checks. Focused cases cover unpaid server publication, settlement of
the same order, failed settlement retaining Pending, idempotent registration,
stock remaining unchanged during settlement, receipt consumption and round limits.
No production order or payment is created to test this release.

Released to Firebase Hosting and the `settleSale` function on 10 November 2026.
