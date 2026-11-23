# Temporary internal receipt entry — 21 November 2026

Historical rollout record. The owner's later request for ongoing operation
supersedes this expiry; see `mpesa-internal-register.md` for the current policy.

The user requested that tonight's typed-code checkout use an internal register
instead of requiring a Safaricom confirmation, and explicitly required existing
M-Pesa tab records to be included.

The register is the existing `payment_receipt_claims` collection. Every check also
reads historical `payments` by both reference and provider transaction ID. New
internal entries additionally check paid `mpesa_payments` and `mpesa_receipts`,
which protects paid prompts already shown in the M-Pesa tab even when a legacy
intent is missing. The reviewed production inventory covered 2,896 historical
references; no canonicalisation changes were needed. No payment history is copied,
rewritten or reset.

For an unseen reference, staff must enter the amount on the receipt. Checking is
read-only and does not reserve the code. Applying money atomically creates the
receipt claim and settlement, fixes the receipt total, records the staff member,
and deducts only the portion applied. Other bills can use its remaining balance;
the total cannot be inflated or spent twice. Legacy used references with no
reliable recorded receipt total are treated as exhausted, not as new money.
Existing confirmed and manually reconciled balances retain their existing rules.

New internal receipts have `verified: false` and
`amountSource: staff_recorded_receipt`. The UI explicitly says “Internal register
(unverified)”. No provider verification is claimed. New internal receipts require
an authenticated selling role and the shared server connection.

The server-only control is `mpesa_receipt_controls/tenant-01`, scoped to
`branch-nai-01`, expiring at **22 November 2026, 06:00 EAT** (03:00 UTC), the
business's next trading-day start. That expiry stops new unconfirmed references.
Receipt balances legitimately recorded during the window remain tracked.
Other tenants, STK prompts and Safaricom configuration are unchanged.

Activation script: `scripts/enable-internal-receipts-tonight.cjs`. It defaults to a
read-only preview. Applying requires the explicit production project and reviewed
fingerprint `9cfee10e236c4c9a176102b7c0119e5a4167a442931ddde562bb0eace4e88e4d`.
The activation has its own audit record, `internal-receipts-tenant-01-20261121`.

Validation: 195 backend tests, 251 frontend tests, 19 distinct browser checks and
the production frontend build. Coverage includes existing references without
claims, paid prompts without intents, immutable totals, partial allocations across
bills, expiry, branch/tenant scoping, retries and duplicate checks. Phone and
desktop layouts were inspected; Apply remains reachable by scrolling on phones.

Production rollout completed on 21 November 2026. Hosting version
`f4410f512ee6f602` matched all nine checked routes and 25 JavaScript assets.
Active function revisions are `settlesale-00023-laj` and
`lookupmpesareceipt-00003-giv`; authentication checks passed and business/M-Pesa
settings matched the pre-release snapshot.

The audited control is enabled until 22 November 2026 at 06:00 EAT. Activation
counted 2,897 historical references (one more arrived after the preview), with no
normalisation changes or rewritten history. Read-only production checks confirmed
that the two reconciled receipts and a historical ledger reference remain
exhausted, new references require an amount and preview as unverified, and checking
a new reference creates no claim or payment. No customer bill was settled by
these release checks.
