# Receipt checking stall — 21 November 2026

The inspected production window showed one completed authenticated receipt lookup
in 0.566 seconds and successful sale settlements in approximately 0.09–0.81
seconds. There was no long-running lookup in those server records. This does not
measure the wait before a request reaches the server.

The browser used a 70-second callable timeout. Inspection of the installed Firebase
SDK confirmed that it waits for authentication headers before starting that timer.
A stalled initialization or token refresh could therefore leave the cashier on
“Checking the receipt balance” without an overall deadline.

Receipt checks now have a 12-second overall deadline, including initialization and
authentication, and a 10-second SDK HTTP timeout. Timeout or network failure leaves
payment disabled, releases Check for retry, and states that no payment was applied.
Late responses cannot enable payment. Concurrent checks share a request only for
the same business, staff member, branch and code. Completed balances are never
cached for later payment; a new check fetches the current balance.

The server preview uses a read-only Firestore transaction, avoiding allocation
locks and write-transaction retries. Independent proof, claim and legacy-ledger
reads run together. Both legacy receipt queries remain, preserving duplicate and
remaining-balance checks. Applying payment still uses a write transaction and
rechecks all available money. Provider verification, manual-review policy, C2B
lifecycle and other payment-call timeouts are unchanged.

Validation: 250 frontend tests, 190 backend tests and 15 browser checks. Browser
cases reproduce a never-resolving check on Orders and Till, advance the clock
past the deadline, confirm that late replies do not enable payment, and verify
that retry succeeds. Existing multi-bill, partial payment, unknown code, stale
balance and replay cases remain covered. The production frontend build passes.

Deployed with the existing production release authorization. Hosting version:
`fb6edf324e8f00b8`. Both functions were verified ACTIVE on Node.js 22:
`settlesale-00022-tak` and `lookupmpesareceipt-00002-riq`. The lookup's live server
timeout was verified at 12 seconds. Business and M-Pesa configuration hashes match
the pre-release snapshot. No C2B activation or live payment was performed.

Live verification matched nine HTML routes and 25 JavaScript assets to the tested
build. A transient asset-fetch failure passed on retry. Authentication checks
passed. The actual read-only algorithm was also run against both reconciled
receipts: KES 1,700 and KES 62,650, each correctly reporting zero available and
manual reconciliation. Workstation-to-Firestore round trips were 2,344 ms for
the initial connection and 766 ms for the next check; these are two read samples,
not a browser performance guarantee. Script: `scripts/check-receipt-read-path.cjs`.
