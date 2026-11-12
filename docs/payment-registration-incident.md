# Payment registration after an early browser commit

On 10 November 2026, the till reported `Transaction committed too early` after a
confirmed Artesano M-Pesa payment. Read-only inspection found the confirmed KES 5
attempt already linked to a completed server sale. No payment was replayed or
reclassified during investigation.

`logAuditEvent` awaited Web Crypto inside an IndexedDB transaction. A native
Promise does not keep IndexedDB active, so it could commit sale/payment records
before the audit write, then reject the function with a premature-commit error.
The till consequently offered registration retry even though the sale existed.

The audit digest now runs through `Dexie.waitFor`, keeping both the audit and any
enclosing sale/payment transaction alive. Sale, tender, stock and audit therefore
commit together, or roll back together. M-Pesa registration retry also checks
the stable attempt key under the sales write lock and reuses the original sale
and tender. Tenant, total and receipt must agree before reuse.

Browser regression tests use real IndexedDB and deliberately delay Web Crypto
by 80 milliseconds. They cover completed payment registration, concurrent retries
without duplicate sale/payment/stock entries, and full rollback after a failure
following the audit write. No Safaricom prompt or production sale is generated
by these tests.

Validation: production build, 178 frontend tests and 12 checkout/mobile/count
browser cases passed. Deployed to Firebase Hosting on 10 November 2026. The live
till HTML and both payment/audit JavaScript chunks match the tested export.
Read-only inspection also confirmed the KES 5 sale's completed M-Pesa payment
record matches the provider-confirmed receipt. No production records were changed
to investigate or verify this incident.
