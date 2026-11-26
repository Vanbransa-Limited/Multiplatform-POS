import assert from 'node:assert/strict';
import test from 'node:test';

import { discountApprovalId, discountAwaitingCode, selfApproves } from './staff-discount.js';

const beer = { product: { id: 'p1' }, qty: 2 };
const discount = (approval) => ({ product: { id: 'prod-staff-discount' }, qty: 1, ...(approval ? { approval } : {}) });

test('a waiter\'s staff discount waits for a manager code; an owner or manager needs none', () => {
  assert.equal(discountAwaitingCode([beer], 'Cashier'), false);
  assert.equal(discountAwaitingCode([beer, discount()], 'Cashier'), true);
  assert.equal(discountAwaitingCode([beer, discount()], 'Bar Staff'), true);
  assert.equal(discountAwaitingCode([beer, discount({ id: 'appr-1', by: 'Grace' })], 'Cashier'), false);
  for (const role of ['Owner', 'Manager']) {
    assert.equal(selfApproves(role), true);
    assert.equal(discountAwaitingCode([beer, discount()], role), false);
  }
  assert.equal(selfApproves('Supervisor'), false);
});

test('the sale carries the approval id only when one was given', () => {
  assert.equal(discountApprovalId([beer]), null);
  assert.equal(discountApprovalId([beer, discount()]), null);
  assert.equal(discountApprovalId([beer, discount({ id: 'appr-1' })]), 'appr-1');
});

import { discountableRounds } from './staff-discount.js';

// Table 001: the milkshake round had the 20%; rice and mbuzi went out without it.
test('only unpaid rounds without a discount can take the 20% afterwards', () => {
  const rounds = [
    { id: 'shake', grand_total: 400, discount: 100 },
    { id: 'rice', grand_total: 100, discount: 0 },
    { id: 'mbuzi', grand_total: 500 },
    { id: 'part-paid', grand_total: 300 },
    { id: 'void', grand_total: 200, status: 'VOIDED' },
  ];
  const outstanding = new Map([['shake', 40000], ['rice', 10000], ['mbuzi', 50000], ['part-paid', 10000], ['void', 20000]]);
  assert.deepEqual(discountableRounds(rounds, outstanding).map(r => r.id), ['rice', 'mbuzi']);
});
