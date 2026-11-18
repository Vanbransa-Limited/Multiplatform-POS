# Proforma invoices

All event proforma invoices belong in a standalone **Proforma invoices** register.
They do not appear in Running orders. The register is available in Orders Viewer,
Financials & AI, and the event proforma screen in QR & Tools.

Prepare the invoice in QR & Tools, preview the draft, then select **Save & lock
invoice**. The server saves the printable document, calculates its totals and
reserves its invoice number across the business. Issued documents cannot be
edited or deleted. Printing the saved original remains available after payment.
Issuing does not create a sale, move stock or add money to daily totals.

In Financials & AI, unpaid proformas fit under **Unpaid Orders / Proformas** and
the unpaid reconciliation list. Proforma balances include all invoice dates;
they remain visible until paid. The standalone register also covers all dates.
The AI's **Proformas** chip explains the outstanding balance and payments in the
selected period. Existing period filters still apply to received payments.

Record full payment in the register when it arrives. The server atomically marks
the invoice paid and writes one canonical payment. Its server receipt time
determines the trading day and session in **Total Received**, the relevant tender
and the transaction list. Retries cannot create a second payment. Invoice issue
date does not determine the payment day. Invoice value is not added again to
sales booked; supply remains a separate till workflow.

Bank and card payments require a staff-recorded reference and remain unverified.
Cash must be enabled. An M-Pesa code must match an unused confirmation for the
full invoice amount. Partial payments, overpayment allocation and backdating are
not supported in this workflow.

Previously prepared invoices retain their original number, date, client, lines
and terms. Three user-supplied Titanium invoices were imported as unpaid on
18 November 2026, attributed to Judith Nandacha. See
[the import record](titanium-proforma-import-2026-11-18.md). A document that
references an existing bill represents that same debt once; settlement clears
the original receivable atomically. Invoices printed before this change were
not saved by the QR tool and require an original document for recovery.

Deployment requires frontend hosting, the `issueProforma` and `payProforma`
Functions, the updated sales/customer-order settlement Functions (receipt reuse
checks), and Firestore rules. Clients have read-only access to proformas and no
access to the invoice-number reservation collection.

Validation: 223 frontend checks, 166 backend checks and 29 browser checks pass.
Production builds and deployment passed. Live artifact and authentication checks,
authenticated register reads, exact invoice reconciliation and import replay
checks passed. Actual payment settlement was tested with isolated fixtures; no
customer payment was taken as a production test. Claude's initial and final
read-only reviews found no deployment/import blocker after the listed fixes.
