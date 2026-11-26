'use strict';
// Judith Nandacha's request of 26 Nov 2026 19:09 ("Kindly clear this for me, my
// unpaid") with two M-Pesa messages to SAVAHOPE LIMITED 1 (till 4567515):
//   UK3130EM1G KES 2,000 on 3 Nov 11:33 -> INV-BH001-001862 (KES 2,000, 31 Oct 22:03)
//   UKQ133CHUZ KES 400 on 26 Nov 15:08 -> INV-BH001-001861 (KES 420, rung the same
//     second as 001862); leaves KES 20 due on it.
// They are the pair of her unpaid walk-in bills these payments fit; she rang
// nothing on 26 Nov. Neither code reached the C2B feed, so both are recorded as
// typed codes (unverified), exactly as Record payment in Orders would.
// Default is a read-only check; --apply settles each through settleSale.
const path = require('node:path');
const assert = require('node:assert/strict');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');

const tenantId = 'tenant-01';
const OWNER = { tenant_id: tenantId, staff_id: 'user-owner', staff_role: 'owner' };
const JUDITH = 'staff-073f331f9793cae5c133b69f034d593420e102389e798ecd';
const PLAN = [
  { code: 'UK3130EM1G', receiptMinor: 200000, saleId: 'sale-69b4f3af95aff5650b39bc059150e734a7a9963d344d4039', invoice: 'INV-BH001-001862', totalMinor: 200000 },
  { code: 'UKQ133CHUZ', receiptMinor: 40000, saleId: 'sale-db9bfe952e91e80f0260c5867ff163673c3b39dffcbb6d69', invoice: 'INV-BH001-001861', totalMinor: 42000 },
];

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--project') || args[args.indexOf('--project') + 1] !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { settleSale, outstandingMinor } = require('../backend/functions/lib/modules/sales/settle');

  for (const step of PLAN) {
    const sale = (await db.doc(`sales/${step.saleId}`).get()).data();
    assert.equal(sale?.tenantId, tenantId); assert.equal(sale.invoiceNumber, step.invoice);
    assert.equal(sale.totalMinor, step.totalMinor); assert.equal(sale.staffId, JUDITH); assert.equal(sale.status, 'completed');
    const payments = (await db.collection('payments').where('saleId', '==', step.saleId).get()).docs.map(d => d.data());
    const used = (await db.collection('payments').where('reference', '==', step.code).get()).docs.map(d => d.data());
    if (used.some(p => p.saleId === step.saleId && p.status === 'completed')) { console.log(`${step.invoice}: ${step.code} already recorded`); continue; }
    assert.equal(used.length, 0, `${step.code} is already used elsewhere`);
    const due = outstandingMinor(payments);
    assert.equal(due, step.totalMinor, `${step.invoice} is not wholly unpaid`);
    const applied = Math.min(due, step.receiptMinor);
    const note = `${step.code} KES ${step.receiptMinor / 100} -> ${step.invoice} (due KES ${due / 100}), leaves KES ${(due - applied) / 100}`;
    if (!apply) { console.log(`can settle: ${note}`); continue; }
    const result = await settleSale.run({ auth: { uid: 'owner-reconciliation', token: OWNER }, data: {
      saleUuid: sale.idempotencyKey, requestId: `judith-unpaid-20261126-${step.code}`, method: 'mpesa',
      reference: step.code, receiptAmountMinor: step.receiptMinor } });
    console.log(`settled: ${note} ->`, JSON.stringify({ settledMinor: result.settledMinor, dueMinor: result.dueMinor ?? result.remainingMinor, verified: result.verified }));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
