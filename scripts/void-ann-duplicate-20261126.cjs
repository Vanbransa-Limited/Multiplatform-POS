'use strict';
// Ann Mithanga's report of 26 Nov 2026: INV-BH001-003480 (15:06 EAT, KES 3,180)
// was rung again as INV-BH001-003485 (16:53 EAT, same five lines, same total),
// and the customer's one payment, UKQQQ3EYRU KES 3,180 at 15:08, settled 003485.
// 003480 is the unpaid duplicate of one purchase. Default is a read-only check;
// --apply voids it through the deployed voidSale logic, so its stock comes back
// and the audit log is written exactly as Void bill in Orders would.
const path = require('node:path');
const assert = require('node:assert/strict');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');

const tenantId = 'tenant-01';
const OWNER = { tenant_id: tenantId, staff_id: 'user-owner', staff_role: 'owner' };
const DUPLICATE = ['sale-41a759bb3afb04b884f66e3f437c848621e8a79cb82dfc79', 'INV-BH001-003480'];
const PAID = ['sale-f813fe0c9f7ce2d650aacef12f762e1ba236888f3e57db1b', 'INV-BH001-003485'];
const CODE = 'UKQQQ3EYRU', TOTAL = 318000;
const REASON = 'Duplicate of INV-BH001-003485 (same items), which UKQQQ3EYRU KES 3,180 paid; one purchase. Ann Mithanga, 26 Nov.';

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--project') || args[args.indexOf('--project') + 1] !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { voidSale, isVoidable } = require('../backend/functions/lib/modules/sales/settle');

  const read = async ([id, invoice]) => {
    const sale = (await db.doc(`sales/${id}`).get()).data();
    assert.equal(sale?.tenantId, tenantId); assert.equal(sale.invoiceNumber, invoice); assert.equal(sale.totalMinor, TOTAL);
    const lines = (await db.collection('sale_lines').where('saleId', '==', id).get()).docs
      .map(d => `${d.data().productId}:${d.data().qty}:${d.data().unitPriceMinor}`).sort();
    const payments = (await db.collection('payments').where('saleId', '==', id).get()).docs.map(d => d.data());
    return { sale, lines, payments };
  };
  const dup = await read(DUPLICATE), paid = await read(PAID);
  if (dup.sale.status === 'VOIDED') { console.log(`${DUPLICATE[1]}: already voided`); return; }
  assert.deepEqual(dup.lines, paid.lines, 'the two bills are not the same items');
  assert.equal(dup.sale.staffId, paid.sale.staffId, 'different waiters');
  assert.ok(paid.payments.some(p => p.method === 'mpesa' && p.reference === CODE && p.amountMinor === TOTAL && p.status === 'completed'), `${PAID[1]} is not paid by ${CODE}`);
  assert.ok(isVoidable(dup.payments), `${DUPLICATE[1]} has a payment; refund instead`);
  assert.ok(!(Number(dup.sale.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()), 'payment in progress on the duplicate');
  if (!apply) { console.log(`${DUPLICATE[1]}: can be voided (KES ${TOTAL / 100}) - ${REASON}`); return; }
  const result = await voidSale.run({ auth: { uid: 'owner-reconciliation', token: OWNER }, data: { saleUuid: dup.sale.idempotencyKey, reason: REASON } });
  console.log(`${DUPLICATE[1]}: ${result.alreadyVoided ? 'already voided' : 'voided'}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
