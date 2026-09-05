# M-Pesa staged handover

## Decision and current safety state

This repository contains the complete application-side STK flow, but M-Pesa is
fail-closed. A tenant whose `mpesa_configs/{tenantId}.lifecycle` is absent or
`staged` cannot send an STK prompt. The final Daraja wire helper repeats that
check, so hiding or showing a browser button is never the payment control.

No production deployment, Daraja URL registration, lifecycle activation, or
real-money test is part of this handover. The future STK cutover is the audited
`staged -> live` lifecycle change after the release checklist is signed off.

The credentials copied into the legacy handover document must be treated as
exposed because they were stored in plaintext. Do not copy them into this
repository or reuse them for go-live. The merchant should rotate them first and
store replacements only in the target Firebase project's Secret Manager.

## What the new developer owns in Daraja

Use a developer-controlled Daraja application only for sandbox development. A
live application, shortcode, Paybill, and Till should remain owned by the
merchant organization—not a contractor's personal account—so access can be
revoked without disrupting settlement.

Before production work, obtain from the merchant or their authorized Safaricom
administrator:

1. Access to the business-owned Daraja application or a business-owned replacement.
2. Written confirmation of the parent BusinessShortCode and each tenant's Till
   or Paybill routing value.
3. Confirmation of whether each route is `CustomerBuyGoodsOnline` or
   `CustomerPayBillOnline`.
4. A rotated consumer key, consumer secret, and passkey delivered through an
   approved secret-sharing channel.
5. Permission to configure callback URLs and, only if direct customer-initiated
   payments are required, permission to register C2B Validation and Confirmation URLs.
6. A named person who can verify settlement in the Safaricom organization portal.

The shared parent credentials belong in Secret Manager under the names already
declared by the Functions module. Tenant-specific non-secret routing belongs in
`mpesa_configs/{tenantId}`. Never put consumer credentials or a passkey in a
browser environment variable, Firestore document, source file, log, or ticket.

## STK callback versus the Daraja "broadcast"

These are separate integrations:

- STK Push supplies `CallBackURL` on every initiated request. Safaricom posts the
  result of that particular prompt to `mpesaCallback`. The callback is treated
  only as a claim; the backend correlates every identifier and confirms the
  outcome with STK Query before creating a spendable payment intent.
- C2B Register URL configures persistent Validation and Confirmation URLs for
  direct payments that a customer starts from their own M-Pesa menu. This is
  commonly what teams mean by the Daraja "broadcast." It is not required just
  to receive STK Push callbacks.

Safaricom's integration material notes an important caveat: although Lipa na
M-PESA Online has no Validation/Confirmation phase of its own, an existing C2B
integration on the same shortcode can still affect it. Before sandbox UAT, ask
the merchant administrator to confirm whether external validation is enabled
and where any existing C2B URLs point. Do not overwrite those URLs blindly.

The separate endpoints are `mpesaC2bValidation` and `mpesaC2bConfirmation`.
Validation rejects unless both the main lifecycle and `c2bLifecycle` are
explicitly `live`. Confirmation stores an immutable claim for manual review; it
does not create a `payment_intents` record or mark a POS sale paid. This is
intentional because an incoming Till/Paybill payment identifies an account but
does not prove which open cart it should settle.

`scripts/register-mpesa-c2b.mjs` is guarded because registration changes
external Safaricom state. It requires distinct HTTPS endpoints and an explicit
acknowledgement; production also requires a second production-only
acknowledgement. Do not run it during staging unless C2B is explicitly in scope.

## Legacy-to-current mapping

| Legacy handoff behavior | Current POS implementation |
| --- | --- |
| Caller supplied `site_id` | Authenticated `tenant_id` claim; the browser cannot choose another tenant |
| `find_site_data` selected a restaurant Till | Server-only `mpesa_configs/{tenantId}` chooses transaction type, PartyB, reference, and optional branches |
| Shared parent credentials | Secret Manager values shared by the backend only |
| `find_discount_membership(phone)` | Server-side phone/customer membership lookup, integer basis points, and the same whole-shilling floor |
| Direct production HTTP call | Lifecycle-gated Daraja client with approved Safaricom hosts and a timeout |
| `MPESA_REQUESTS` record after initiation | A deterministic `mpesa_payments` attempt is reserved before the network call, making retries idempotent |
| `ORDERS.status = sent` | No paid sale is created at initiation; only callback plus STK Query creates a verified intent |
| Placeholder callback | Strict `mpesaCallback`, checkout-ID alias, mismatch quarantine, receipt uniqueness, and reconciliation query |
| Logged credentials, password, token, phone, payload | Secrets and provider response bodies are not logged |

Membership authorization is tied to the exact tenant, branch, device, staff
member, customer, cart quantities, line discounts, tender split, and receipt.
A matching amount alone cannot fund another sale.

## Tenant routing document

Create routing with the guarded script; it always writes `staged` and never
activates payments:

```powershell
cd backend/functions
npm run mpesa:configure -- `
  --project <staging-project-id> `
  --tenant <tenant-id> `
  --environment sandbox `
  --transaction-type CustomerBuyGoodsOnline `
  --party-b <tenant-till-number> `
  --account-reference <short-label> `
  --branches <branch-id> `
  --ticket <change-ticket>
```

The resulting non-secret document has this shape. Its environment must match
the configured Safaricom base URL or the final wire helper refuses the call:

```ts
mpesa_configs/{tenantId} = {
  tenantId: string,
  lifecycle: "staged" | "live" | "suspended",
  c2bLifecycle: "staged" | "live" | "suspended",
  environment: "sandbox" | "production",
  transactionType: "CustomerBuyGoodsOnline" | "CustomerPayBillOnline",
  partyB: string,
  accountReference: string,
  allowedBranchIds: string[] | null
}
```

For Paybill, PartyB must equal the BusinessShortCode. For Buy Goods, PartyB is
the tenant Till while BusinessShortCode remains the approved parent shortcode.
The exact relationship must be confirmed in the merchant's portal before UAT.

## Safe delivery sequence

1. **Local emulator:** keep the `demo-tokgut-pos` alias and
   `NEXT_PUBLIC_USE_EMULATORS=1`. Exercise staged UI behavior and unit tests. No
   Daraja call can leave the lifecycle gate.
2. **Isolated sandbox project:** add sandbox-only secrets, deploy with
   `npm run deploy -- --project <staging-project-id>`, stage each tenant route,
   then use the guarded lifecycle script to enable that sandbox tenant. Sandbox
   activation permits simulated Daraja prompts, not real-money settlement.
3. **Sandbox UAT:** verify phone normalization, Buy Goods/Paybill routing,
   idempotent retry, cancellation, callback mismatch quarantine, missing
   callback reconciliation, membership discount, split tender, receipt
   uniqueness, and sale-intent consumption.
4. **Production preparation:** rotate credentials, validate business ownership,
   store production secrets, deploy the reviewed release, and write production
   tenant routes as `staged`. Confirm the hosted UI reports activation pending.
5. **Future cutover (not performed here):** after written approval and a
   low-value test plan, run `mpesa:lifecycle` with the deployed Git SHA, change
   ticket, and the exact typed approval value. Monitor the first payment in both
   Firestore and the Safaricom portal. Use `suspended` immediately on any mismatch.
6. **Optional future C2B:** only after the merchant confirms direct Till/Paybill
   payments are needed, deploy the two C2B endpoints, verify their public URLs,
   register them once, and keep direct payments in manual review until an
   authenticated sale-matching workflow is approved.

The production lifecycle command is deliberately not copied as a ready-to-run
command in this document. `npm run mpesa:lifecycle -- --help`/the script's
validation errors describe its required approval fields at execution time.

## Release evidence

Record these without secret values:

- Firebase project ID and deployed Git SHA.
- Tenant ID, route type, masked shortcode/Till suffix, and allowed branch IDs.
- Daraja app owner and merchant approver.
- Callback and optional C2B endpoint URLs.
- Secret version identifiers, not secret contents.
- Sandbox cases and results.
- Production change ticket, activation time, first receipt, portal settlement
  confirmation, and rollback owner.

Safaricom references: [M-Pesa API overview](https://www.safaricom.co.ke/main-mpesa/m-pesa-for-you/helpful-m-pesa-channels/sim-toolkit)
and [Safaricom integration requirements](https://www.safaricom.co.ke/images/Downloads/Tender_Documents/EOI_Safaricom_M-PESA_Integration_V1_002.pdf).
