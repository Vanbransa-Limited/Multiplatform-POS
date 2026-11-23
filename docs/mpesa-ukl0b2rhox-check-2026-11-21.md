# UKL0B2RHOX — real receipt rejected by local lookup

The user supplied a Buy Goods receipt dated 21 November 2026 at 18:08 EAT for
SAVAHOPE LIMITED 1, till 4567515, and a rejected POS lookup against Kester's
KES 950 bill. The user requested investigation rather than an assumed-amount
manual settlement. The photographed payment does not expose its amount.

Read-only production checks found:

- Till 4567515 matches tenant-01's production Buy Goods route.
- The exact bill is ORD-6-023885, invoice INV-BH001-003086, with KES 950
  outstanding on its credit ledger. Its sale status alone says completed and
  does not establish that payment arrived.
- No matching receipt claim, provider intent, C2B confirmation, STK attempt,
  payment reference or provider transaction ID was found for UKL0B2RHOX.
- STK lifecycle is live; C2B lifecycle remains staged.
- Cloud Logging showed no C2B confirmation/validation POST requests from
  11:45 UTC through the inspection at approximately 15:45 UTC, covering the
  photographed payment time of 15:08 UTC.
- Secret Manager metadata confirms STK credentials exist. No Transaction Status
  initiator or security-credential secret is configured. No secret values were
  accessed. The source implements STK queries, not arbitrary receipt queries.

The deployed checker searches confirmations already held by the POS. It has not
queried Safaricom to establish whether this direct receipt exists or its amount.
Absence from this local feed cannot establish receipt invalidity. The previous
deadline fix prevents indefinite browser waiting; it does not fill this missing
provider integration. Direct C2B delivery and/or an authenticated Transaction
Status integration is needed for independent verification of these receipts.

No payment was recorded, bill cleared, provider URL registered, lifecycle changed
or application code deployed during this investigation. Diagnostic scripts:
`scripts/inspect-direct-payment-route.cjs` and
`scripts/inspect-direct-payment-access.cjs`.
