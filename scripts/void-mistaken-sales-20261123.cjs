'use strict';
// Voids bills the owner confirmed were rung by mistake on Mon 23 Nov 2026.
// Default is a read-only check. --apply voids each through the deployed
// voidSale logic itself, so stock comes back and the audit log is written
// exactly as a Void pressed in the Orders screen would.
const path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');

const tenantId = 'tenant-01';
const OWNER = { tenant_id: tenantId, staff_id: 'user-owner', staff_role: 'owner' };
const MISTAKES = [
  ['sale-10fa3d81b55d5f6173c6ca3b18dff2fa014de8d5aeef9861', 'INV-BH001-003314', 10000, 'Rung by mistake (Wycliffe, Water 500ml); confirmed by the owner 24 Nov.'],
  ['sale-f722acf454af4116b6d184623c3ab0abacd6e602aa03c87a', 'INV-BH001-003298', 72000, 'Rung by mistake under Tamia, who was not on shift; confirmed by the owner 24 Nov.'],
  ['sale-1f8e5c7adb235b851f8ca65d4d81bddb568918e5459a5416', 'INV-BH001-003302', 72000, 'Duplicate rung under Tamia, who was not on shift; confirmed by the owner 24 Nov.'],
];

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--project') || args[args.indexOf('--project') + 1] !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  // The backend modules reuse this app, so they act on production only when told to.
  initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  const { voidSale, isVoidable } = require('../backend/functions/lib/modules/sales/settle');

  for (const [saleId, invoice, totalMinor, reason] of MISTAKES) {
    const sale = (await db.doc(`sales/${saleId}`).get()).data();
    const payments = (await db.collection('payments').where('saleId', '==', saleId).get()).docs.map((doc) => doc.data());
    const problems = [];
    if (!sale || sale.tenantId !== tenantId) problems.push('not found');
    else {
      if (sale.invoiceNumber !== invoice) problems.push(`invoice is ${sale.invoiceNumber}`);
      if (sale.totalMinor !== totalMinor) problems.push(`total is ${sale.totalMinor}`);
      if (deterministicId('sale', `${tenantId}:${sale.idempotencyKey}`) !== saleId) problems.push('key does not map to this sale');
      if (Number(sale.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) problems.push('payment in progress');
    }
    if (sale?.status === 'VOIDED') { console.log(`${invoice}: already voided`); continue; }
    if (!isVoidable(payments)) problems.push('has a payment, refund instead');
    if (problems.length) { console.log(`${invoice}: NOT voided - ${problems.join('; ')}`); process.exitCode = 1; continue; }
    if (!apply) { console.log(`${invoice}: can be voided (KES ${totalMinor / 100}) - ${reason}`); continue; }
    const result = await voidSale.run({ auth: { uid: 'owner-reconciliation', token: OWNER }, data: { saleUuid: sale.idempotencyKey, reason } });
    console.log(`${invoice}: ${result.alreadyVoided ? 'already voided' : 'voided'}`);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
