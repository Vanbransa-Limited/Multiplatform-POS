/** Seeds tenant_settings variants and mints an owner token for the rules check. */
import { writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { assertSafeEmulatorTarget } from '../../../scripts/lib/emulator-safety.cjs';

const target = assertSafeEmulatorTarget();
initializeApp({ projectId: target.projectId });
const db = getFirestore();

const complete = (tenantId, methods) => ({
  tenantId, acceptedPaymentMethods: methods, cashEnabled: true,
  establishmentName: 'Savahope', receiptFooter: 'Thanks', locale: 'en-KE',
  timezone: 'Africa/Nairobi', lowStockThresholdQty: 5,
});

// 1. A complete document, as provisioning writes it.
await db.doc('tenant_settings/t-complete').set(complete('t-complete', ['cash', 'mpesa']));
// 2. The same, but the stored list already carries a method the rules do not
//    allow as a value. hasOnly() is checked against the WHOLE resulting list.
await db.doc('tenant_settings/t-credit').set(complete('t-credit', ['cash', 'credit']));
// 3. A document missing fields the rule asserts on. The rule validates the
//    whole resulting document, not only the keys being changed.
await db.doc('tenant_settings/t-sparse').set({
  tenantId: 't-sparse', acceptedPaymentMethods: ['cash'], cashEnabled: true,
});

const token = await getAuth().createCustomToken('uid-owner', {
  tenant_id: 't-complete', staff_id: 'user-owner', staff_role: 'owner',
});
const tokens = {};
for (const tenantId of ['t-complete', 't-credit', 't-sparse']) {
  tokens[tenantId] = await getAuth().createCustomToken(`uid-${tenantId}`, {
    tenant_id: tenantId, staff_id: 'user-owner', staff_role: 'owner',
  });
}
writeFileSync(process.argv[2], JSON.stringify({ token, tokens }));
console.log('seeded tenant_settings variants');
