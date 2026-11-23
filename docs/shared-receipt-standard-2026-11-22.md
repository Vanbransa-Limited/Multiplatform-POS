# Shared receipt standard — 22 November 2026

## Current revision: manual code and amount entry

The owner subsequently restored staff entry of the M-Pesa code and receipt
amount. Version 3 uses `entryMode: staff_entry`, with ongoing operation and no
expiry. It replaces the recorded-only requirement described in the historical
release notes below.

Till checkout, saved bills, customer orders and proforma invoices accept the
code and receipt amount directly. There is no separate lookup button or
Safaricom lookup requirement. A successful payment atomically creates the
receipt claim and payment allocation, records the staff member and preserves the
original receipt total. Manually entered payments remain unverified unless
provider proof exists. STK still uses its provider confirmation path.

Only unused balances can be allocated. A changed amount, exhausted receipt,
foreign business reference or invalid branch is refused. Till bills retain an
unpaid remainder when the receipt pays only part of the bill. Customer menu
orders and issued invoices still require enough unused balance for their full
amount. Existing payment history and merchant settings are preserved.

Validation: 254 frontend tests, 203 backend tests, the rollout fingerprint test,
checkout browser checks and phone/desktop form checks passed on Node 22.
Firestore emulator checks covered concurrent requests, lost responses, immutable
amounts and one manual receipt paying a sale, an invoice and a customer order
without a preview lookup. No test payments were created in production.

Version 3 was applied to both current tenants and all three active branches with
reviewed fingerprint
`9f430b1655e288276e9dc4df696430df5ef681cfa4fa013129270154516aeeea`.
Hosting version `9db031aafff364c8` is live. `settleSale`, `lookupMpesaReceipt`,
`payProforma`, `settleCustomerOrderByCode` and `createPlatformTenant` are active
on Node 22. Live checks verified authentication gates, unchanged merchant and
business settings, the manual-entry controls, and matching Till, Orders and
Finance artifacts (17 JavaScript assets).

## Earlier recorded-only release

The owner requested that Titanium's current code-only payment workflow and
general product improvements apply to Artesano and future clients. General
improvements belong in shared product code; business configuration and data stay
tenant-specific. This principle is recorded in the root `AGENTS.md`.

The shared frontend already serves the same code-only screens and short cashier
messages to every business. This release standardises the stored receipt policy
for existing businesses and the platform onboarding path.

`standardReceiptPolicy` is the common policy builder used by onboarding and the
rollout tool. Version 2 specifies ongoing operation, no expiry and recorded-only
amounts. Cashiers cannot create receipt totals. Unknown codes are rejected,
remaining balances can pay other bills within the existing branch/proof rules,
and exhausted references cannot be spent again.

Version 2 covers active branches belonging to the tenant, including future
branches. The server reads the branch document and verifies its tenant and active
status. Missing, inactive or foreign branches are refused, including for known
receipts. Claim identifiers and historical payment filtering remain tenant-scoped.
No payment, inventory, staff, pricing, accepted-tender or merchant configuration
is copied between businesses.

`createPlatformTenant` creates this policy atomically with the new tenant and its
first branch, linked to the existing onboarding audit. Account creation, platform
administrator authorization, credential handling and interruption/retry semantics
remain intact. The retired provisioning callable stays unexported.

Production inventory found two active tenants and three active branches:

- `tenant-01`: `branch-nai-01`, `branch-nai-02`.
- `tenant-artesano`: `tenant-artesano-main`.

The rollout tool previews those targets and their current controls, then requires
the reviewed fingerprint to apply. It atomically writes only controls and audit
records, archiving previous controls separately for each tenant. Retries verify
the completed rollout rather than duplicating it. A changed tenant, branch or
control requires a fresh preview. Suspended/inactive businesses are not targets.

Validation on Node 22: 203 backend tests and 18 tooling tests passed. Real
Firestore emulator transactions passed receipt contention/replay checks and the
new cross-business isolation and future-branch checks. The onboarding regression
asserts the new tenant's policy and verifies that Titanium's policy is untouched
by creating another business. No production test business or payment is created.

Before rollout, Artesano's read-only audit checked 15 tracked receipts and found
no inconsistencies; 20 historical references without claims remain protected by
the existing ledger checks. The previous shared frontend release is
`2ab132820cbc2aed`; no frontend update is needed for this policy rollout.

## Production outcome

All three targeted functions deployed and are active on Node 22:
`settlesale-00026-lap`, `lookupmpesareceipt-00006-yem` and
`createplatformtenant-00003-qow`. Authentication gates passed, lookup remains
bounded to 12 seconds, and all business/Safaricom settings matched the pre-release
snapshot.

The reviewed rollout fingerprint was
`75a96296c590c26f26e0e072f5fb2da8ec24e13ee1d2e1bc216972fd75e69f74`.
The policy was applied atomically to both tenants and all three current active
branches. Its manifest is `audit_logs/receipt-standard-75a96296c590c26f26e0e072f5fb2da8`;
each control links to its own tenant audit under the same prefix. Replaying the
rollout returned `already applied` without extra writes.

Live read-only checks confirmed code-only amounts, no expiry and rejection of
unknown amounts and foreign branches for both businesses. Final ledger audits
found no inconsistencies in Titanium's 158 tracked receipts or Artesano's 15.
No payment history was rewritten and no customer payment was recorded by the
rollout or verification. Future businesses use the deployed onboarding default;
future active branches inherit their own tenant's standard without a new rollout.
