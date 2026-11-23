# Print before checkout

Every business uses the same required print step. No tenant setting or data rollout is needed.

On Till, use **Print Receipt & Pay**. Saved orders, table tabs and menu orders use the same gate when payment is opened. The bill is saved unpaid before the cashier can send it to the counter. **Pay Now** stays disabled until the Print Station confirms that receipt.

At the Print Station, print the queued receipt and check the paper before accepting **Did the receipt print successfully?** Cancelling that confirmation leaves payment locked and the job available for **Print now**. Browser print dialogs cannot report whether physical paper emerged, so this is an explicit staff confirmation, recorded with staff, device, time and print job. A kitchen ticket or an ordinary receipt reprint does not authorize checkout.

The server constructs the unpaid receipt from tenant-scoped saved bills and lines. Clients cannot create authorization-bearing print jobs or write print proof through Firestore rules. Payment claims, saved-bill STK prompts, settlements and menu-order tenders check the recorded print proof. New direct paid-sale creation and unsaved-cart STK prompts are refused; clients must save an unpaid bill first. Existing exact paid-sale and payment replays remain idempotent.

Changing items, quantities, prices, totals, tax codes, customer, invoice or table invalidates that bill's print proof. New rounds must also be printed. Partial M-Pesa payments can use the same unchanged printed bill; receipt balances and provider verification remain separate from printing.

If the printer or connection is unavailable, leave the order in Pending and retry after reconnecting. Closing Till's print step leaves the saved bill in Orders, without taking payment. Old client versions that attempt new direct paid sales need to reload before checkout; previously unsynced paid records require reconciliation rather than being re-entered as new payments.

Release the frontend, Firestore rules and the affected callable functions together: `createSale`, `claimSalePayment`, `settleSale`, `initiateMpesaStk`, `prepareCheckoutReceipt`, `confirmCheckoutReceiptPrinted`, `chargeCustomerOrder`, `settleCustomerOrderByCode`, `settleCustomerOrderBank`, `settleCustomerOrderCard`, and `settleCustomerOrderCash`. No production data or provider payment is needed for release verification.

Validation uses Node 22. `npm test` covers tooling and unit regressions. `npm run test:receipts` runs print gating, rule enforcement and receipt-balance concurrency against the guarded demo Firestore emulator. The Playwright `checkout-print`, `payment-commit` and `checkout-recovery` specs cover desktop/mobile gating, cancelled print confirmation, retries and partial payments. A physical printer was not exercised by automated tests.
