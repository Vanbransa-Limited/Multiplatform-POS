# Checkout blocked by an empty discount round

The reported KES 2,100 bill is ORD-78-849214. Read-only production inspection found three canonical unpaid sales for KES 1,100, KES 800 and KES 200. A fourth round was held on the original till and contained only a zero-value “Staff 20% Discount” marker. Its header and payment were zero. Checkout attempted to publish that round before card/code/STK processing and stopped with “its payments are all zero.” The KES 925 service-charge case was separately fixed and the user confirmed it worked.

## Changes

- Orders and Till exclude only unsynced pending zero-value charge/discount markers with explicit zero line values, no goods and no payment proof. They retain all positive bills, real goods, saved server sales and received payment references. Filtering survives the subsequent server refresh.
- The original adjustment record is preserved. The outbox stops retrying it and records an omission marker; it does not create a sale, receipt, stock movement or paid state. Held snapshots and the running board omit the empty marker. A paid table can close while preserving it.
- New carts consisting only of the special discount/service placeholders cannot create a separate round. Ordinary service products remain available.
- An unsynced pending positive bill with a missing or zero receivable can recover its debt under a deterministic local credit ID. Actual received money is subtracted; existing positive or settled credits and saved/completed/voided bills are not replaced. Recovery never creates a payment confirmation.
- Till STK now carries the reserved original sale UUIDs and checkout ID, sends no catalogue lines and applies no new service surcharge, matching the Orders saved-bill path.

## Verification

239 frontend tests, 176 backend tests and 33 browser checks pass; the frontend production build passes. Real IndexedDB browser reproductions exercise the three KES 2,100 rounds plus the empty marker through card, typed M-Pesa code and STK. Each claims exactly KES 2,100, makes three settlements, skips uploading the marker and preserves its unpaid zero record. STK carries the saved bill binding; new discount-only registration is refused. A separate table-close test preserves the marker while releasing a paid table. Concurrent upload classification reads each sale's own rows and does not use a mutable omission flag shared between uploads; a regression test prevents a real bill from being omitted by another round's state.

Claude review was attempted using explicitly anonymized source after user approval. The CLI returned its five-hour account limit (reset shown as 11:50 p.m. Africa/Nairobi); no Claude approval of this additional batch is claimed. No real STK prompt, card charge or payment settlement was sent during tests.

This release also brings the earlier completed proforma, stock, role access, receipt reconciliation and service-charge work into the requested Git branch/main workflow. Local credentials, personal editor/Claude settings, debug logs, imported PDFs and temporary live evidence are excluded from Git.
