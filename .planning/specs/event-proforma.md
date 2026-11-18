# Spec: event-proforma

**Created**: 2026-11-16
**Status**: built
**Author**: Lloyd
**Epic**: pos-changes-batch (Feature 6)

A4 proforma for planned events, laid out after `Savahope Ltd - Proforma invoice (A4).docx`: header, meta, Billed to, Subject/LPO, item table, Terms + eTIMS note, Subtotal/Discount/VAT/Amount due, Bank transfer, M-Pesa, Authorised by.

- Lives in QR & Tools → Event Proforma. Items come from the menu (at catalogue price, editable) or as free service lines.
- **Not a sale**: nothing is booked and no stock moves. This is different from the till's existing PROFORMA tender, which books an unpaid sale.
- Menu prices include VAT, so the VAT line shows the 16% *included*, not added on top.
- Business, bank and M-Pesa details are prefilled from the tenant and remembered per device. The number is `PF-YYMMDD-NN`, counted per device per day and editable.
- Not stored centrally. Add storage if proformas need to be listed or converted into a sale later.
- Tests: `frontend/src/services/event-proforma.test.mjs`.
