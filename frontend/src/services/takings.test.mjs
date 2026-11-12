import assert from 'node:assert/strict';
import test from 'node:test';

import { isReceivable, saleTimestamp, tenderTotals } from './takings.js';

test('tenderTotals splits every tender and keeps receivables out of collected', () => {
  const totals = tenderTotals([
    { method: 'CASH', amount: 100 },
    { method: 'MPESA', amount: 50 },
    { method: 'CARD', amount: 25 },
    { method: 'CREDIT', amount: 400 },
    { method: 'PROFORMA', amount: 600 }
  ]);

  assert.deepEqual(totals, {
    cash: 100, mpesa: 50, other: 25, receivable: 1000, collected: 175
  });
});

test('a settled proforma leaves the receivables and lands under what paid it', () => {
  const totals = tenderTotals([
    // The proforma row, cleared by the M-Pesa settlement beside it.
    { method: 'PROFORMA', amount: 600, settled_at: '2026-09-08T12:00:00.000Z' },
    { method: 'MPESA', amount: 600 },
  ]);

  assert.equal(totals.receivable, 0, 'no longer owed');
  assert.equal(totals.collected, 600, 'counted once, under M-Pesa');
  assert.equal(totals.mpesa, 600);
});

test('tenderTotals is unfazed by junk rows', () => {
  assert.equal(tenderTotals().collected, 0);
  assert.equal(tenderTotals([{ method: 'cash', amount: '19.99' }]).cash, 19.99);
  assert.equal(tenderTotals([{ amount: 10 }]).other, 10);
  assert.equal(tenderTotals([{ method: 'CASH', amount: 'abc' }]).cash, 0);
});

test('isReceivable covers both unpaid tenders, in any case', () => {
  assert.ok(isReceivable('PROFORMA'));
  assert.ok(isReceivable('credit'));
  assert.ok(!isReceivable('CASH'));
  assert.ok(!isReceivable(undefined));
});

test('saleTimestamp reads sold_at, falls back to created_at, never NaN', () => {
  assert.equal(saleTimestamp({ sold_at: '2026-01-02T00:00:00.000Z' }), Date.parse('2026-01-02T00:00:00.000Z'));
  assert.equal(saleTimestamp({ created_at: '2026-01-02T00:00:00.000Z' }), Date.parse('2026-01-02T00:00:00.000Z'));
  assert.equal(saleTimestamp({}), 0);
  assert.equal(saleTimestamp(null), 0);
});
