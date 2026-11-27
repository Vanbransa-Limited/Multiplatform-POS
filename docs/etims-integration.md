# eTIMS integration preparation

Prepared 27 November 2026. Status: local OSCU implementation with simulated KRA
responses; no KRA sandbox approval, registered device, live acceptance test or
certification has been supplied. This is not a production compliance sign-off.

## Integration choice

Start sandbox work with OSCU for the current Firebase-hosted POS. KRA describes
OSCU as suitable for always-online invoicing and VSCU for bulk invoicing and
systems that are not always online. This recommendation assumes an online
connection when issuing a fiscal invoice. Browser offline sales storage does not
make OSCU available offline.

KRA's [system-to-system integration page](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration)
describes development, testing, vetting and certification for self-integrators and
third-party integrators. Its linked
[OSCU specification v2.0](https://www.kra.go.ke/images/publications/OSCU_Specification_Document_v2.0.pdf)
is the current implementation reference. VSCU would require a separate adapter
and deployment of KRA's approved package; it is not implemented here.

## Existing workflow and preparation changes

An owner or manager uses **Settings → KRA eTIMS** to initialize a branch's approved
OSCU device. `setupEtims` submits the business PIN, KRA branch ID and device serial
to `/selectInitOsdcInfo`. Sandbox is the default. `cmcKey` stays in the server-only
`etims_devices` collection. Connections are audited without copying the key into
the audit log. Active tenant, branch ownership, active branch and current staff
status/role are checked on the server.

The **Generate ETR** action on a paid bill calls `generateEtr`. It registers missing
products with `/saveItem`, then sends `/saveTrnsSalesOsdc`. It uses stored sale-line
prices, discounts and tax amounts. Product classifications must be supplied from
valid KRA codes; a branch default is only appropriate when it fits all applicable
items. Do not use an arbitrary classification to bypass validation.

The implementation now claims overlapping sale groups in a Firestore transaction.
One sale cannot belong to two different fiscal requests. Invoice and item counters
are retained for each tenant/branch/environment/PIN/KRA-branch identity, including
when switching away and reconnecting. This preserves this application's own
sequence; it does not discover numbers used by another POS or earlier installation.
Use a device allocated to this integration and reconcile existing numbering before
connecting an already-used fiscal identity.

After allocating an invoice, its request body stays immutable on retries,
including invoice number, buyer PIN, timestamps and amounts. HTTP failures and
incomplete receipt replies leave it `uncertain`. A `994` duplicate reply without
receipt evidence becomes `needs_reconciliation`; another invoice is not allocated
to work around it. Late responses cannot overwrite a newer attempt. A complete
successful receipt is stored and audited atomically with the sales' fiscal status.

The ETR print block uses the stored signature, control-unit details and KRA
verification QR. Fiscal signing does not verify the payment: staff-entered M-Pesa
receipts retain their existing verification status.

## Obtain sandbox access

Follow KRA's [OSCU/VSCU registration guide](https://www.kra.go.ke/images/publications/OSCU_VSCU_Step-by-Step_Guide-on-how-to-sign-up.pdf):

1. Sign up at the [eTIMS sandbox portal](https://etims-sbx.kra.go.ke) using the
   appropriate company PIN and account details.
2. Submit the OSCU service request and required commitment documents. Obtain KRA
   approval and the registered branch ID/device serial details.
3. Configure an isolated test deployment with the approved sandbox identity.
   Connect using **Sandbox** in Settings. Keep real business checkout and test
   records separate. Do not turn a live tenant into a sandbox test business.
4. Confirm endpoint and schema details with the assigned KRA integration contact.
   The specification includes `/etims-api/` in the base URL; the signup guide's
   examples omit it. The adapter follows the specification. Do not automatically
   try alternative invoice endpoints after a timeout.
5. Test initialization, valid item classifications, tax treatment, invoice totals,
   buyer PINs, receipt fields and QR verification with actual sandbox replies.
   Test retries, rejected invoices, concurrent tills and ambiguous outcomes.
6. Complete the agreed KRA test matrix, vetting and certification before a separate
   production rollout for each participating business and approved branch/device.

Production credentials are independently provisioned per business. Neither
onboarding nor this preparation copies another tenant's PIN, keys, tax settings,
stock, prices or fiscal records. Future tenants use the same callables and checks.

## Remaining production work

- The present action is staff-requested and limited to paid bills. Implement the
  agreed invoice-issuance trigger and durable automatic submission/retry worker;
  confirm issuance timing for credit sales with KRA before relying on this flow.
- Implement a supported reconciliation process for unknown/duplicate outcomes and
  an operational fiscal outbox connected to server records. Never reset invoice
  counters or delete a claimed receipt to bypass an error.
- Retrieve and maintain KRA reference codes/classifications, validate the current
  tax configuration, and provide appropriate per-product classification controls.
- Complete applicable credit-note/refund, purchase, stock movement/master and
  branch synchronization workflows required by KRA's agreed certification scope.
- Mark sandbox output clearly before exposing test receipts to users, and verify
  physical receipt layouts against KRA's current requirements.
- Document and test production cutover, outage handling, monitoring, credential
  recovery and per-business rollout. Sandbox fiscal records must never be promoted
  into production invoices.

## Local verification

Use Node 22 and JDK 21 or newer:

```sh
npm --prefix backend/functions test
npm run test:etims
```

`test:etims` builds Functions and runs `backend/functions/e2e/etims.cjs` against the
local `demo-tokgut-pos` Firestore emulator. It intercepts every KRA HTTP call and
fails if a request uses an unexpected URL. It covers tenant/branch boundaries,
counter preservation, overlapping bills, immutable retries, missing signatures,
duplicate responses, late responses and audit records. It does not contact KRA,
prove API acceptance, or exercise browser-to-callable transport. The full emulator
suite also includes this scenario.

No production business, payment, fiscal invoice or deployment is created by
these checks.
