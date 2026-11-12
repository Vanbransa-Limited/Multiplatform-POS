import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const till = await readFile(new URL('../src/ui/till.js', import.meta.url), 'utf8');
const viewSource = till.slice(till.indexOf('export class TillView')).replace('export class', 'class');
const draftSource = (await readFile(new URL('../src/services/till-draft.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:38889/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto('http://127.0.0.1:38889/');
  const initialize = async () => page.evaluate(({ viewSource, draftSource }) => {
    const helpers = new Function(`${draftSource};return {tillDraftKey,readTillDraft,writeTillDraft};`)();
    const state = { currentTenant: { id: 'tenant' }, currentUser: { id: 'staff' }, currentBranch: { id: 'branch' } };
    window.messages = [];
    const db = { sales: { filter: predicate => ({ first: async () => window.savedSale && predicate(window.savedSale) ? window.savedSale : null }) } };
    const View = new Function('state', 'db', 'tillDraftKey', 'readTillDraft', 'writeTillDraft', 'MpesaService', 'unavailableMpesaCapability', 'showNotification',
      `${viewSource};return TillView;`)(state, db, helpers.tillDraftKey, helpers.readTillDraft, helpers.writeTillDraft,
      class {}, () => ({}), message => window.messages.push(message));
    window.till = new View(document.querySelector('main'));
    window.till.selectedCustomer = { id: 'cust-walkin', price_tier: 'RETAIL' };
  }, { viewSource, draftSource });
  await initialize();
  await page.evaluate(async () => {
    await window.till.restoreDraft();
    window.till.cart = [{ product: { id: 'tea', name: 'Tea', sell_price: 100 }, qty: 2 }];
    window.till.parkedCarts = [{ id: 'parked', cart: [{ product: { id: 'water' }, qty: 1 }] }];
    window.till.activeTable = '16';
    window.till.persistDraft();
  });
  await page.reload();
  await initialize();
  const restored = await page.evaluate(async () => {
    await window.till.restoreDraft();
    return { qty: window.till.cart[0]?.qty, parked: window.till.parkedCarts.length, table: window.till.activeTable };
  });
  assert.deepEqual(restored, { qty: 2, parked: 1, table: '16' });
  const duplicate = await page.evaluate(async () => {
    window.savedSale = { id: 'already-saved', draft_id: window.till.cartDraftId };
    await window.till.restoreDraft();
    return window.till.cart.length;
  });
  assert.equal(duplicate, 0);
  await page.evaluate(() => {
    window.savedSale = null;
    window.till.cart = [{ product: { id: 'tea', sell_price: 100 }, qty: 2 }];
    window.till.mpesaAttempt = { idempotencyKey: 'existing-payment-attempt' };
    window.till.persistDraft();
  });
  await page.reload();
  await initialize();
  const guarded = await page.evaluate(async () => {
    await window.till.restoreDraft();
    window.till.openCheckoutModal();
    return { attempt: window.till.recoveredPaymentAttempt, message: window.messages.at(-1) };
  });
  assert.equal(guarded.attempt, 'existing-payment-attempt');
  assert.match(guarded.message, /before taking payment again/);
  console.log('Till draft browser check passed: real reload preserves cart, parked work and table; committed work is not restored twice; unresolved payment cannot be charged again.');
} finally { await browser.close(); }
