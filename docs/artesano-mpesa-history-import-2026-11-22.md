# Artesano M-Pesa history import — 22 November 2026

The user requested importing the saved M-Pesa history, then rechecking invoice
`INV-BH001-000052` against code `UKLC82RLYH`.

The inventory covered all saved Artesano records in `payments`, `mpesa_payments`,
`payment_intents`, `mpesa_receipts`, `mpesa_c2b_events`, receipt claims and held
orders. There were 35 successful M-Pesa payment rows and 27 paid provider attempts.
No saved record contained the reported code, including legacy fields. No merchant
statement/export was present in the workspace; this was an import of POS history,
not a download of Safaricom merchant transactions.

The audited import added 20 missing historical reference claims. Each claim
records previously applied money with its limit equal to its allocated amount,
so it creates no spendable balance. Source payment IDs and original dates are
retained, and verification is not upgraded. Existing claims, original payment
rows and invoice debts are not rewritten. One old payment has a nine-character
reference; that entry was left unchanged instead of padding or guessing its code.

Tool: `scripts/import-mpesa-history.cjs`, explicit project and tenant required.
Preview fingerprint:
`90b7bc43b0cb04622a6b20791b965d47988854b00a10688c123e65fbe210e599`.
The import is atomic, skips ambiguous source references, archives source IDs and
imported allocations, and safely replays an already-completed import.

Planner tests passed. Real demo Firestore tests verified concurrent import/replay,
unchanged original payment rows and unpaid bills, preservation of an existing
unused balance, original receipt dates, invalid-code exclusion, no new spendable
money, and continued rejection of the unknown reported code. No app deployment
or merchant configuration change was needed.

Production verification found 35 tracked claims, no historical references without
a claim, and no claim/payment inconsistencies. A fresh preview was up to date.
The post-import read-only check still found no record for `UKLC82RLYH`, and invoice
`INV-BH001-000052` still owed KES 250. Direct-till confirmation remains staged;
the merchant's actual payment record/statement is needed to import that new code.
No customer bill was settled by the import or verification.
