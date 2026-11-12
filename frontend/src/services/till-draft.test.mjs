import test from 'node:test';
import assert from 'node:assert/strict';
import { tillDraftKey, readTillDraft, writeTillDraft } from './till-draft.js';
import { readFile } from 'node:fs/promises';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
};
const scope = { tenantId: 'tenant', staffId: 'staff', branchId: 'branch' };
const draft = { cartId: 'draft1', cart: [{ product: { id: 'tea', name: 'Tea', image_data: 'data:large-photo' }, qty: 2 }],
  parkedCarts: [{ id: 'park1', cart: [{ product: { id: 'water' }, qty: 1 }] }], activeTable: '4' };

test('drafts retain cart and parked work across same-tab navigation, scoped to staff and venue', () => {
  const cache = storage();
  const key = tillDraftKey(scope);
  writeTillDraft(cache, key, draft);
  const restored = readTillDraft(cache, key);
  assert.equal(restored.cart[0].qty, 2);
  assert.equal(restored.cart[0].product.image_data, null);
  assert.equal(restored.parkedCarts[0].cart[0].product.id, 'water');
  assert.equal(restored.activeTable, '4');
  assert.equal(readTillDraft(cache, tillDraftKey({ ...scope, staffId: 'other' })), null);
  assert.equal(readTillDraft(cache, tillDraftKey({ ...scope, branchId: 'other' })), null);
});

test('a committed order is not restored as an unsubmitted cart after a crash', async () => {
  const source = (await readFile(new URL('../ui/till.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf('  async restoreDraft()');
  const body = source.slice(start, source.indexOf('\n  persistDraft()', start)).replace('async restoreDraft()', 'async function restoreDraft()');
  const cache = storage();
  writeTillDraft(cache, tillDraftKey(scope), draft);
  const restore = new Function('state', 'tillDraftKey', 'readTillDraft', 'sessionStorage', 'db', 'showNotification', `return ${body};`)(
    { currentTenant: { id: 'tenant' }, currentUser: { id: 'staff' }, currentBranch: { id: 'branch' } },
    tillDraftKey, readTillDraft, cache,
    { sales: { filter: predicate => ({ first: async () => predicate({ draft_id: 'draft1' }) ? { id: 'saved' } : null }) } }, () => {});
  const view = {};
  await restore.call(view);
  assert.deepEqual(view.cart, []);
  assert.equal(view.parkedCarts.length, 1);
  assert.equal(view.draftReady, true);
});

test('a restored unresolved payment draft cannot start a second checkout', async () => {
  const source = (await readFile(new URL('../ui/till.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf('  openCheckoutModal()');
  const body = source.slice(start, source.indexOf('\n  selectPaymentMethod(', start)).replace('openCheckoutModal()', 'function openCheckoutModal()');
  const messages = [];
  const checkout = new Function('showNotification', `return ${body};`)(message => messages.push(message));
  checkout.call({ recoveredPaymentAttempt: 'previous-provider-attempt' });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /before taking payment again/);
});
