'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { repairReceipt } = require('./lib/receipt-overallocation-repair.cjs');
const plan = { tenantId: 'tenant-01', branchId: 'branch-nai-01', reference: 'UKRBY46MR1',
  saleId: 'sale-7f5564378f44341c3b3e753db4e6ec4916d7769e6d54933c', invoiceNumber: 'INV-BH001-003530',
  sellerStaffId: 'staff-073f331f9793cae5c133b69f034d593420e102389e798ecd',
  paymentId: 'sale-settlement-aa4bb5fac88eacb9779dfb1436076f0374bcd098cb6b15da', paymentFromMinor: 942500,
  fromMinor: 1127500, totalMinor: 900000, reopenMinor: 227500, archiveId: 'judith-receipt-ukrby46mr1-20261127',
  reason: 'Owner supplied UKRBY46MR1 SMS for KES 9,000 and confirmed on 27 November 2026 that the excess KES 2,275 is still owed. Preserve the other five payment amounts and the separate KES 50 unpaid item.' };
async function main() {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  assert.equal(Number(process.versions.node.split('.')[0]), 22);
  assert.ok(args.includes('--project') && value('--project') === 'vanbransa-pos');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const { db } = require('../backend/functions/lib/lib/firebase');
    const apply = args.includes('--apply');
    const result = await repairReceipt(db, plan, { apply, expectedHash: args.includes('--expected-hash') ? value('--expected-hash') : undefined });
    if (apply) await require('../backend/functions/lib/modules/sales/tab-identity').refreshTableSessionForSale(plan.saleId);
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.delete(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
