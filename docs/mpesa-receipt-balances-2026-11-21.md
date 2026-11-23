# M-Pesa receipt balances — 21 November 2026

Linda's invoice INV-BH001-003042 (ORD-55-861692) was still owed KES 1,200.
UKL6537WE3 had already paid invoices 003029 and 003017 for KES 350 and KES 150.
The original checkout claim incorrectly limited the receipt to KES 500, despite
the supplied SMS showing KES 1,700 paid to SAVAHOPE LIMITED 1.

The guarded reconciliation was applied with source fingerprint
`52f55fb5acb69d234ccbb5a3938e06734fb83bd6c450dc2f10d706deebbe123c`.
It archives the original records, retains the original KES 500 and payment dates,
and allocates the remaining KES 1,200 to invoice 003042. It does not change goods
or stock. Verification confirms one KES 1,700 receipt, zero outstanding across
the three invoices, and zero new collection in the correction's trading day.
There is no provider confirmation for this code; the correction remains explicitly
manual and unverified. Archive: `linda-UKL6537WE3-20261121`.

The prepared checkout changes add `lookupMpesaReceipt`, showing received, used
and available money before application in Orders and Till. Server transactions
recheck proof and remaining money when applying each payment. Confirmed receipts
can pay multiple bills within their actual amount. Multiple codes can pay one
bill in parts. Unknown, quarantined, foreign and exhausted receipts cannot clear
debt. An audited historical reconciliation can supply a manually reviewed amount;
an ordinary legacy typed payment cannot establish a spendable receipt balance.

Partial payments preserve the remaining receivable. Local mirroring is atomic
and keyed by the server payment ID. Refreshing the selling till imports partial
payments from other devices without duplicating its credit row. Financials counts
explicit portions of one shared receipt once, including multiple portions on one
bill. Existing offline history remains uploadable under its prior review rules.

Validation: 189 backend tests, 246 frontend tests, 13 distinct browser cases,
backend TypeScript and frontend production build. Phone and desktop receipt
lookup layouts were inspected. Browser checks include KES 400 + KES 600 paying
KES 1,000, delayed lookup responses, unknown codes, partial mirroring and replay.

The checkout code was deployed on 21 November 2026 after the user's explicit
deployment approval, using `scripts/safe-deploy.cjs`. Hosting version:
`e7fdb165e5fa937c`. `settleSale` and `lookupMpesaReceipt` were verified ACTIVE on
Node.js 22, revisions `settlesale-00021-qon` and `lookupmpesareceipt-00001-miy`.
Live checks matched nine HTML routes and 25 JavaScript assets to the tested build.
Both updated endpoints and nine other related callables enforced authentication.
The release reran 189 backend tests, 246 frontend tests, the production build and
13 browser checks successfully. No live payment or STK prompt was submitted.

Business settings and M-Pesa configuration hashes match the pre-release snapshot.
STK remains `live` and C2B remains `staged`; no provider URL registration or feed
activation was included. Receipt lookup checks confirmations already held by this
business or an audited manual reconciliation. Absence from that feed does not
establish that an SMS is fake. New direct till payments require a received provider
confirmation or manual reconciliation before the strict checkout accepts them.
