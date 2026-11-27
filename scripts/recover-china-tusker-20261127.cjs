'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { recoverHeldSale } = require('./lib/recover-held-sale.cjs');
const plan = { archiveId: 'china-tusker-20261127', heldId: 'open-order-d2fe539df3de529b8dda0f476bdb4de1675458dde9a2bf99',
  openedAt: '2026-11-27T18:36:11.146Z', reason: 'Owner requested repair of the supplied Kester report: ORD-CHINA-571146 is one Tusker lager KES 350 with missing item rows. Restore the original sale UUID unpaid once, preserving the seller and table.',
  input: { tenantId: 'tenant-01', branchId: 'branch-nai-01', staffId: 'staff-8735cb9d772eecaadcc5744fcb933a0558e9d3ea3b2f1875',
    deviceId: 'device-till-01', shiftId: 'shift-41ab01032d945c03c1485c920093a35e44776e89bed60bdd', customerId: 'cust-walkin',
    idempotencyKey: '06362f62-d83e-4e46-bfcc-4666a1f9d534', tableNumber: 'China', tabId: 'f8182491-a3ae-42b3-80ae-389471f04c28',
    orderReference: 'ORD-CHINA-571146', lines: [{ productId: 'product-904287d310d3c88cfffdb831bbbc954e59f9511bed64c914', qty: 1 }],
    payments: [{ method: 'credit', amountMinor: 35000 }] } };
async function main() {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  assert.equal(Number(process.versions.node.split('.')[0]), 22);
  assert.ok(args.includes('--project') && value('--project') === 'vanbransa-pos'); assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try { console.log(JSON.stringify(await recoverHeldSale(require('../backend/functions/lib/lib/firebase').db, plan,
    { apply: args.includes('--apply'), expectedHash: args.includes('--expected-hash') ? value('--expected-hash') : undefined }), null, 2)); }
  finally { await app.delete(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
