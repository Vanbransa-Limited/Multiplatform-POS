// Keep discovery lightweight: domain modules own their triggers and this entry
// point only re-exports them for the Firebase Functions runtime.
export { health } from "./health";
export {
  getMpesaCapability,
  initiateMpesaStk,
  mpesaCallback,
  queryMpesaStatus,
} from "./modules/mpesa";
export {
  mpesaC2bConfirmation,
  mpesaC2bValidation,
} from "./modules/mpesa/c2b";
export { importProducts, upsertProduct, upsertCategory, retireProduct, retireMissingProducts, dedupeProducts, retireSeedProducts } from "./modules/catalogue";
export { createSale } from "./modules/sales";
export {
  createStaffUser,
  importStaff,
  resetStaffPassword,
  setStaffActive,
} from "./modules/staff-admin";
export { openShift } from "./modules/shifts";
export { getPublicMenu, printCustomerOrder, submitCustomerOrder, updateCustomerOrder } from './modules/customer-orders';
// Settlement is counter-side only: the customer's browser cannot start a
// payment, so no unauthenticated callable can move money for an order.
export {
  chargeCustomerOrder,
  checkCustomerOrderPayment,
  settleCustomerOrderByCode,
  settleCustomerOrderCard,
  settleCustomerOrderCash,
} from './modules/customer-orders/payments';
export { configureStock, changeStock, setProductTracking, importStock } from './modules/stock';

// TEMPORARY: exported so the first owner can be created after the cutover from
// PIN sign-in. It is guarded by POS_BOOTSTRAP_SECRET and refuses to run once
// the tenant has an active owner. Remove this export and redeploy as soon as
// scripts/bootstrap-owner.mjs has been run.
export { bootstrapOwner } from "./modules/staff-admin";
//
// provisionTenant is deliberately NOT exported. It can mint staff identities
// and rewrite the catalogue, so it stays out of the deployed surface. To run it
// again, re-add the export below, deploy, run scripts/provision-tenant.mjs, then
// remove the export and redeploy:
//   export { provisionTenant } from "./modules/provisioning";
