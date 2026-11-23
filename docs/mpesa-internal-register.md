# Ongoing internal M-Pesa register

The owner requested an ongoing internal receipt workflow on 21 November 2026,
because the direct-payment provider feed is not yet available. On 22 November
the owner clarified that cashiers must enter only the code, use the amount
already saved in the ledger, and spend only its unused balance. This supersedes
the overnight policy described in `mpesa-internal-entry-tonight-2026-11-21.md`.

The shared Firestore register is durable across till/browser/server restarts.
Each business has its own server-only policy. The current shared standard uses
`mode: internal`, `duration: ongoing`, `policyVersion: 2`, `until: null`,
`branchScope: tenant` and an audit authorization ID. `entryMode: recorded_only`
prevents new cashier amounts from creating receipt balances. The server checks
branch ownership and active status. Missing or malformed controls do not enable
the policy, and it has no calendar expiry. Titanium and Artesano now use it;
new businesses inherit it during onboarding. See
`shared-receipt-standard-2026-11-22.md` for the rollout and verification. Version 1
and Titanium-only rollout references below are historical records.

## Cashier workflow

1. Read the merchant receipt/SMS and enter its ten-character code only.
2. Check the code. The screen loads the saved total, amount used and balance.
3. Apply the displayed amount. A smaller payment leaves the rest of the bill due;
   the remaining money on a larger receipt can be applied to another bill.
4. Once the full receipt balance is used, its code cannot pay another bill.

There is no receipt-amount field in Orders or Till. In recorded-only mode the
server also rejects an unknown reference even if an older client or a direct
API request supplies an amount. Unknown codes must first reach the register
with their received amount through a provider record or an audited
reconciliation/import. No automatic amount feed or statement import was created
by this change; a code alone cannot supply the actual payment amount.

Historical internal entries are staff assertions, not evidence from Safaricom. Staff must
inspect the receipt and management must reconcile recorded takings against the
merchant's actual receipts/statement. An invented, unused ten-character code
cannot be detected by an internal register alone. Paid prompts and existing
provider proofs retain their stronger verification rules.

## Integrity and availability

- Checkout performs indexed reference lookups, not a scan of historical takings.
  It includes the existing payment ledger and paid M-Pesa prompts; history is
  never reset when a new policy is enabled.
- Preview is read-only. It never creates a receipt or a payment. The frontend
  bounds the whole check, including authentication initialization, to 12 seconds;
  late responses and changes of business/staff are discarded. No balance is
  cached for a subsequent payment.
- Allocation rechecks receipt and bill inside a Firestore transaction. The first
  saved internal entry fixes its total. Competing tills cannot exceed it.
- Each request has a stable payment ID. Replaying a committed request after a
  lost response returns the same payment instead of applying it again.
- Receipt creation, reduction of debt, payment and audit are one transaction.
  Stock is unchanged. The register records the original staff member, branch,
  policy authorization, allocations and limits; each settlement audit includes
  the request ID, payment ID, reference, amount and verification status.
- New receipt entry requires the shared server connection. An outage produces
  an error/retry state rather than a local-only successful payment that another
  till cannot see.
- Later provider proof uses previous internal allocations when calculating
  headroom. A provider total below the money already allocated blocks use and
  requires reconciliation. Original staff attribution is retained.

No implementation guarantees indefinite uninterrupted service. The database,
network and account permissions remain operating dependencies.

## Health check and corrections

Run the read-only consistency check during operational review:

```powershell
node scripts/audit-internal-receipts.cjs --project vanbransa-pos
```

It reads a consistent snapshot, compares claim limits/allocations with successful
ledger payments, checks internal entry attribution, and exits nonzero on an
inconsistency. Historical references without a claim are reported separately;
they are already checked during checkout and are not fresh money. This audit
runs outside checkout and is not a scheduled job. A passing audit proves internal
consistency; it does not prove the merchant actually received the money.

For an incorrect receipt total, a wrong code, a refund or an exhausted historical
receipt with a genuine unrecorded balance, review the merchant evidence and the
affected invoices first. Use an audited correction with a reviewed before/after
plan; do not delete claims or edit cashier-entered totals to make a code reusable.

## Administrative policy transition

The policy tool previews by default. It never changes bills, stock, provider
configuration or payment history:

```powershell
node scripts/rollout-receipt-standard.cjs --project vanbransa-pos
```

To apply a reviewed preview, repeat with `--apply --expected-hash <fingerprint>`.
The fingerprint binds the transition to the existing control, and the transaction
archives that control in `audit_logs`. Replaying the same application is safe.

The earlier `set-internal-receipt-mode.cjs` tool targets Titanium's original
branch only; it is not the shared-standard rollout tool. Provider-only exceptions
or rollbacks require an explicitly scoped, audited policy transition. Deploy the
backend before enabling a newer policy version: an older backend may not
understand its branch scope. Receipt claims and historical allocations must
remain intact during any transition.

## Validation for this change

Node 22, matching production: 201 backend tests, 251 frontend tests, 17 tooling
tests and 19 browser checks passed for code-only checkout. The focused Firestore emulator suite covers real transactions for:
simultaneous identical requests; lost-response replay; eight competing tills;
conflicting first-entry amounts; split receipts; late provider proof; policy
switch/expiry; role rejection; audit completeness; and unchanged stock.

Run the repeatable transaction suite with Node 22:

```powershell
npm run test:receipts
```

The whole-system emulator run did not complete because its Functions emulator
discovery timed out. The focused suite uses the actual compiled receipt callables
and Firestore transactions directly, without that Functions process. No
production money was entered by these tests. The code-only frontend was rebuilt
and inspected on phone and desktop; the amount field is absent and Apply remains
reachable.

Before deployment, the read-only production audit checked 130 tracked receipts,
including three staff-recorded receipts, with no inconsistencies.

## Initial ongoing-policy verification

The deployed function revisions are `settlesale-00024-pal` and
`lookupmpesareceipt-00004-goj`, both active on Node 22. Authentication probes
passed, the receipt lookup retains its 12-second server limit, and business and
Safaricom settings matched the pre-release snapshot. The existing frontend
release remains `f4410f512ee6f602`.

The ongoing policy was applied with fingerprint
`0b35898dbf0020a4d3cfecd575f4461d5242ee56031fbd0c3e9a9cb437c788a6` and audit ID
`receipt-policy-0b35898dbf0020a4d3cfecd575f4461d`. Live read-only checks confirmed
no expiry, the audit record, exhausted historical references, required amounts
for new references and unverified previews with zero writes.

The post-release production snapshot checked 158 tracked receipts, including 26
staff-recorded receipts, with no claim/ledger inconsistencies. This is a point-in-
time consistency check; no automatic monitoring job was added. Release checks
did not settle any customer bill or alter historical payment records.

## Code-only rollout — 22 November 2026

Active function revisions: `settlesale-00025-xif` and
`lookupmpesareceipt-00005-qug`. The code-only frontend release is
`ede931ef7aaec8ed`. The current control keeps `duration: ongoing`, `until: null`
and sets `entryMode: recorded_only`. It was applied with reviewed fingerprint
`a99dd4e615490ddecc0f397c5fa14945e36009c6892c42984dbef4a92a39bf2e` and audit ID
`receipt-policy-a99dd4e615490ddecc0f397c5fa14945`.

Production read-only verification confirmed that unknown codes are rejected even
with a supplied amount, exhausted historical receipts remain exhausted, previews
write nothing, and the policy has no expiry. The consistency audit checked 158
tracked receipts, including 26 historical staff-recorded receipts, with no issues.
Business and Safaricom settings matched the pre-release snapshot. The update
does not change receipt totals, apply money, reset references or create an amount
feed. The owner explicitly confirmed that unused balances remain reusable across
bills until exhausted.

## Cashier message simplification — 22 November 2026

Orders and Till now show only `Amount: KES … Available: KES …` after a successful
check. Exhausted codes say `This code has already been fully used.` Missing
payments say `Payment not found. Check the code and try again.` Connection and
other failures use short retry or manager-help messages. Raw technical errors
and payment-source terminology are not displayed in the receipt-check note.
Financial verification flags and the code-only allocation policy are unchanged.

The frontend production build, 251 frontend tests and 19 browser checks passed.
The messages and reachable Apply controls were inspected at phone and desktop
widths. This release changes only frontend presentation and does not write any
payment, receipt or business/provider configuration.

Hosting release `2ab132820cbc2aed` was verified against the built artifacts for
nine routes and 23 JavaScript assets. All ten checked callable authentication
gates remained enforced.
