# Customer menu and Orders Viewer

The public `/menu.html` reads active, positively priced products from the tenant's central Firestore catalogue through `getPublicMenu`. It publishes only names, selling prices, categories, units and images. No sample catalogue or customer-browser database is used.

Menu links accept `tenant`, `branch` and optional `table` query parameters. Newly generated local QR links include the current tenant and branch. Existing unqualified links use the deployment tenant and let customers choose an active branch.

`submitCustomerOrder` checks tenant and branch status, quantities, product ownership and current server prices before writing `customer_orders`. Changed prices require the customer to reload and review. Request IDs make retries idempotent; submission is limited to 20 new orders per IP and tenant per minute. A lost response can be retried with the same order. The menu displays success only after a server acknowledgement.

## Serving choice

Each order is `dine_in` or `takeaway`, chosen in the cart. Dine-in requires a table number — the QR link's `table` fills it in — and takeaway requires a name, because there is no table to call. A takeaway carries no table number at all, so a runner is never sent to a table someone else is sitting at. `type=takeaway` in the link preselects takeaway.

## Payment is taken at the counter

The customer's phone cannot start a payment. After placing an order the menu shows the reference as a **tracking number** and tells the customer to screenshot it or write it down; that number is how the cashier finds the order. No unauthenticated callable can move money for an order.

Settlement callables all require a signed-in member of staff:

- `chargeCustomerOrder` sends one M-Pesa STK prompt to a number the cashier reads from the customer. One request id per attempt, so pressing Pay now twice resumes the same prompt rather than charging twice; attempts are capped at five per order.
- `checkCustomerOrderPayment` re-queries M-Pesa. A lost callback would otherwise leave a paid order marked unpaid, which — with the print gate below — silently strands the food.
- `settleCustomerOrderCash` records cash taken at the counter and is refused unless the tenant accepts cash. Without it a cash house could never release a ticket.

Only the M-Pesa callback or a recorded cash settlement marks an order paid; no browser does.

## Nothing reaches the kitchen unpaid

`printCustomerOrder` refuses an order whose `paymentStatus` is not `paid`. The card also disables the print button and offers **Pay now** instead, but that is a hint — the rule is enforced on the server, because a disabled button is not a gate.

## The counter and the kitchen

Orders Viewer is a single live **Orders** board for the current branch. Cashiers, bar staff, supervisors, managers and owners can view it. Staff can set preparation status.

The board carries both kinds of order the restaurant has. Live table-menu orders come from `customer_orders`. Completed till sales come from the local `sales` table and enter through `saleAsOrder` as **completed, paid** orders — a sale is already cooked, served and settled, so the Completed tab and its tile are the day's whole completed work rather than half of it. The two were previously separate lists on one screen, which made Completed read zero while settled sales sat in a table below it.

A card shows a photo of the first item, the reference and status, the table or takeaway, the time, the items, the total and whether it is paid. An unpaid menu order leads with Pay now and a disabled ticket button; once paid it carries the kitchen-ticket button. Both keep the status dropdown. A till sale carries neither — reprinting a ticket for a table that has already left would send food to the pass — and offers its tax invoice instead. Above the grid sit a count for every state, a search over reference, table, customer, item, cashier and receipt, and tabs that narrow the grid. `received` and `awaiting_print` both read as **Pending**: a server only needs to know the kitchen does not have it yet, and the card says separately whether it is paid. Cards page eight at a time; a tab or search change returns to page one. A product with no picture, or one whose picture fails to load, shows a plate glyph rather than an empty slot.

Menu orders are watched live. Sales are read once when the screen opens, because a settled sale is history and does not change under the operator.

Printing an order's kitchen ticket is what puts it on the pass: the ticket is the cook order. The button queues the ticket through the existing counter print station and calls `printCustomerOrder`, which counts the print on the order and moves it to `preparing` (a ticket reprinted after the kitchen called it `ready` does not drag it back). The count shows in the viewer and on the paper, so a second ticket is marked a reprint rather than cooked twice. The ticket carries items, serving instruction, note and paid state — never prices or a fiscal block.

Orders that are unpaid stay unpaid: this intake does not create a fiscal sale, deduct stock, or print a tax receipt. Staff settle those through the existing till checkout.

The prior menu saved orders only in the customer's browser and sometimes displayed success without writing anything. Those historical orders are not in the central feed and cannot be recovered from the POS server.

Cash policy is saved in `tenant_settings`, refreshed at sign-in and when opening Settings or Shifts, and enforced by the shift callable. A new shift has zero opening float when cash is disabled or absent from accepted payment methods. Existing shift drawer balances are preserved. Another accepted payment method must exist before cash can be disabled.

Validation: `npm test`, production `npm run build` with `NEXT_PUBLIC_USE_EMULATORS=0`, and `node frontend/visual/customer-orders-check.cjs`. The callable tests use an in-memory Firestore substitute; the browser check uses intercepted HTTP responses without creating live customer orders.
