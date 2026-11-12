# Stock flow and staff access

Updated 8 September 2026.

## Stock imports and Menu Admin

Stock import records a delivery or an owner's stock count. Menu Admin import manages product information and prices; it ignores quantity columns. Both use the same product identity so a sale and a stock movement refer to the same item, but they are separate operations.

With Store enabled:

1. Owner, Store Manager or Store Keeper imports a CSV/Excel delivery into **Store Stock**.
2. Stock is transferred from Store to House using **Request from the Store**. The transfer subtracts from Store and adds the same quantity to House.
3. POS sales of physical items deduct from House. Menu Admin displays available House stock, excluding quantities reserved for orders. Public-menu availability uses House stock for items marked **Counted**.

Example: import 100 bottles into Store; move 20 to House; sell 3. Store holds 80 and House holds 17, assuming no reservations or other movements.

With House only, delivery imports go directly into **House Stock**. There is no Store transfer. Importing 100 and selling 3 leaves 97 in House.

Use columns such as `SKU`, `Item Name`, and `Quantity`. Existing items match by SKU or name; ambiguous names require a unique SKU. A delivery adds quantities. An owner's count replaces the quantity in the selected room and requires a reason.

New items on a delivery sheet become stock-only records: unpriced, inactive for selling, counted, and hidden from the customer menu. An Owner or Store Manager can price and activate them in Menu Admin and enable menu visibility when appropriate. Stock imports do not change existing prices or menu settings. Invalid rows are reported. Replaying the same import reference does not add the quantities again.

Each room has action buttons that expand the relevant form. Forms start closed. With Store enabled, House offers transfers; delivery imports stay in Store. The Owner can separately import a House count.

## Access by role

All six roles can use POS checkout, orders, shifts, M-Pesa payment flows and receipt printing. Payment methods still depend on the business configuration; every role must have a valid active staff account and the necessary stock/payment prerequisites.

| Capability | Owner | Store Manager | Supervisor | Store Keeper | Bar Staff | Cashier |
|---|---|---|---|---|---|---|
| Sell through POS and serve orders | Yes | Yes | Yes | Yes | Yes | Yes |
| Apply discretionary discounts | Yes | Yes | No | No | No | No |
| View Menu Admin | Yes | Yes | Yes | Yes | No | No |
| Create/edit/import menu products and prices | Yes | Yes | No | No | No | No |
| Change counted status or menu visibility | Yes | Yes | No | Yes | No | No |
| View Store Stock, when enabled | Yes | Yes | Yes | Yes | No | No |
| View House Stock | Yes | Yes | Yes | Yes | Yes | No |
| Receive/import deliveries and create stock-only items | Yes | Yes | No | Yes | No | No |
| Transfer Store stock to House | Yes | Yes | No | Yes | Yes | No |
| Correct central stock quantities/import counts | Yes | Yes | No | No | No | No |
| Switch between Store + House and House only | Yes | No | No | No | No | No |
| Finance and audit screens | Yes | Yes | No | No | No | No |
| QR & Tools screen | Yes | Yes | Yes | No | No | No |
| Settings and staff administration | Yes | Yes, with owner restrictions | No | No | No | No |

Store Managers can create and manage non-owner staff, including resetting their passcodes. Only Owners can create an Owner or reset/disable another Owner. Staff cannot disable themselves, and the last active Owner cannot be disabled.

An automatically verified customer benefit is separate from permission to enter a discretionary discount.

The matrix describes application screens and central operations. Menu Admin still contains older local stock-take worksheets; completing those is not a correction of the central House/Store balances. Use the **Correct** action or stock-count import, either of which an Owner or Store Manager can run, for central corrections.

## Implementation references

- Navigation: `frontend/src/navigation.js`
- Stock forms: `frontend/src/ui/stock.js`
- Stock permissions and imports: `backend/functions/src/modules/stock/index.ts`
- Selling and discounts: `backend/functions/src/modules/sales/constants.ts`
- Staff administration: `backend/functions/src/modules/staff-admin/index.ts`
- Catalogue permissions: `backend/functions/src/modules/catalogue/index.ts`
