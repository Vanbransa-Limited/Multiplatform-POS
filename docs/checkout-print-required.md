# Saving and printing before checkout

Checkout has two separate rules. Only the first is enforced today.

## 1. Save the bill unpaid first (always enforced)

Payment always settles a bill that is already saved on the server as unpaid.
New direct paid-sale creation (`createSale` with any tender other than credit)
and STK prompts for an unsaved cart (`initiateMpesaStk` without
`settlementSaleUuids`) are refused with **"Save the bill unpaid before taking
payment."** Exact replays of existing sales and payments remain idempotent. Old
client versions that attempt new direct paid sales need to reload; previously
unsynced paid records require reconciliation rather than re-entry as new
payments.

## 2. Print the unpaid receipt first (currently disabled)

`PRINT_BEFORE_PAYMENT` is `false` in both
`backend/functions/src/modules/sales/printed-receipt.ts` and
`frontend/src/ui/checkout-print.js`, by the owner's request (2026-11-22).
Printing is **not** required before payment: the checkout gate saves the bill
and continues straight to payment, and no payment route checks print proof.
Keep the two flags in step; deploy functions before hosting when switching it
back on, because the frontend flag alone enforces nothing.

When the flag is on:

- On Till, **Print Receipt & Pay**, and saved orders, table tabs and menu orders
  when payment is opened, queue a server-built unpaid receipt. **Pay Now** stays
  disabled until the Print Station confirms it.
- At the Print Station, staff confirm **Did the receipt print successfully?**
  Browser print dialogs cannot report whether paper emerged, so this is a staff
  confirmation recorded with staff, device, time and print job — not proof of
  paper. Cancelling it leaves payment locked and the job reprintable. A kitchen
  ticket or an ordinary reprint does not authorize checkout.
- Clients cannot create authorization-bearing print jobs or write print proof
  through Firestore rules. Payment claims, saved-bill STK prompts, settlements
  and menu-order tenders check the recorded proof, which is invalidated by any
  change to items, quantities, prices, totals, tax codes, customer, invoice or
  table. New rounds must also be printed. Receipt balances and provider
  verification remain separate from printing.
- If the printer or connection is unavailable, the order stays in Pending.

Printing never settles money, and a printed or completed order is not a paid
one.

## Verification

Node 22. `npm test` covers tooling and unit regressions, including the
save-first refusals. `npm run test:receipts` runs print-job queuing and
confirmation, Firestore rule enforcement and receipt-balance concurrency against
the guarded demo emulator; its payment refusals are asserted only while
`PRINT_BEFORE_PAYMENT` is on. There are no browser tests for the print gate, and
a physical printer is not exercised by automated tests.
