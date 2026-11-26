import assert from 'node:assert/strict';
import test from 'node:test';

import { unpaidTwin } from './rering-guard.js';

const cart = [{ product: { id: 'americano' }, qty: 1 }];
const bill = (over = {}, settled = false) => ({
  sale: { id: 's1', invoice_no: 'INV-BH001-003402', staff_id: 'esther', status: 'PENDING_PAYMENT', table_no: '', sold_at: '2026-11-25T07:54:00Z', ...over },
  lines: [{ product_id: 'americano', qty: 1 }],
  payments: [{ method: 'PROFORMA', settled_at: settled ? '2026-11-25T08:00:00Z' : null }],
});

// 25 Nov: Esther's Americano 003402 waited unpaid; she rang it again as 003404.
test('finds the waiter\'s unpaid walk-in bill with the same items', () => {
  assert.equal(unpaidTwin(cart, [bill()], 'esther')?.invoice_no, 'INV-BH001-003402');
});

test('ignores paid, voided, table, other waiters\' and different bills', () => {
  assert.equal(unpaidTwin(cart, [bill({}, true)], 'esther'), null);
  assert.equal(unpaidTwin(cart, [bill({ status: 'VOIDED' })], 'esther'), null);
  assert.equal(unpaidTwin(cart, [bill({ table_no: '6' })], 'esther'), null);
  assert.equal(unpaidTwin(cart, [bill()], 'gogo'), null);
  assert.equal(unpaidTwin([{ product: { id: 'americano' }, qty: 2 }], [bill()], 'esther'), null);
});

test('a staff discount on the cart does not hide the twin; newest twin wins', () => {
  const withDiscount = [...cart, { product: { id: 'prod-staff-discount' }, qty: 1 }];
  const later = bill({ id: 's2', invoice_no: 'INV-BH001-003404', sold_at: '2026-11-25T08:29:00Z' });
  assert.equal(unpaidTwin(withDiscount, [bill(), later], 'esther')?.invoice_no, 'INV-BH001-003404');
});
