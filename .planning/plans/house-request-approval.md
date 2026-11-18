# Plan: house-request-approval

**Spec**: .planning/specs/house-request-approval.md
**Epic**: pos-changes-batch (Feature 4)
**Created**: 2026-11-16
**Status**: built

| File | Change |
|------|--------|
| `backend/functions/src/modules/stock/index.ts` | `STOCK_ROLES.request` widened, `approve` added; `moveIntoHouse` helper; pending path in `changeStock`; `decideStockRequest` callable |
| `backend/functions/src/index.ts` | export `decideStockRequest` |
| `backend/functions/test/stock.test.cjs` | approval-flow tests; existing tests moved to the manager's direct-move path |
| `firestore.rules` | `stock_requests`: tenant read, no client write |
| `frontend/src/services/stock.js` | `pullStockRequests`, `decideStockRequest` |
| `frontend/src/ui/stock.js` | Pending requests card, approve/reject, request copy |
| `frontend/src/navigation.js` | Cashier (waiter) can open House Stock by default |
| `frontend/src/ui/settings.js` | Stock-locations help text |
