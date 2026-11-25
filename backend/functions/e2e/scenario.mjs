/**
 * Whole-system check against the emulators.
 *
 * Two cashiers and an owner, real callables, real Firestore. It rings up
 * orders, settles them the ways the counter actually settles them - M-Pesa
 * code, bank reference, cash, a table-menu order, and one left on a till - and
 * then reads the result back as the owner, through the same snapshot the
 * Financials screen and the AI answer use.
 *
 * The point is not that each call succeeds. It is that the money the tills
 * moved and the money the books report are the same number.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { emulatorTestTarget } from '../../../scripts/lib/test-target.cjs';

const target = emulatorTestTarget();
const PROJECT = target.projectId;
const FN = target.functionsBase;

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

const TENANT = 'tenant-01';
const BRANCH = 'branch-e2e';
const OWNER = 'user-owner';
const A = { staff: 'staff-akashi', device: 'device-a', shift: 'shift-a', name: 'Akashi' };
const B = { staff: 'staff-clemente', device: 'device-b', shift: 'shift-b', name: 'Clemente' };

const problems = [];
const log = (...a) => console.log(...a);
const check = (label, actual, expected) => {
  const ok = Math.abs(Number(actual) - Number(expected)) < 0.005;
  log(`   ${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) problems.push(`${label}: got ${actual}, expected ${expected}`);
};
const checkText = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  log(`   ${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) problems.push(`${label}: got "${actual}", expected "${expected}"`);
};

async function tokenFor(uid, claims) {
  await auth.createUser({ uid }).catch(() => {});
  await auth.setCustomUserClaims(uid, claims);
  const res = await fetch(
    `${target.authBase}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: await auth.createCustomToken(uid, claims), returnSecureToken: true }) },
  );
  const body = await res.json();
  if (!body.idToken) throw new Error(`sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function call(name, data, token) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) throw new Error(`${name}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

async function seed() {
  await db.doc(`tenants/${TENANT}`).set({ id: TENANT, status: 'active', tradingName: 'Savahope', etimsMode: 'none' });
  await db.doc(`branches/${BRANCH}`).set({ id: BRANCH, tenantId: TENANT, status: 'active', code: 'BH001', name: 'Main' });
  await db.doc(`tenant_settings/${TENANT}`).set({
    tenantId: TENANT,
    acceptedPaymentMethods: ['cash', 'mpesa', 'card', 'bank_transfer'],
    cashEnabled: true, establishmentName: 'Savahope', receiptFooter: '',
    locale: 'en-KE', timezone: 'Africa/Nairobi', lowStockThresholdQty: 5,
    dayStartHour: 5, nightStartHour: 17,
  });
  await db.doc('customers/cust-walkin').set({ id: 'cust-walkin', tenantId: TENANT, name: 'Walk-In Guest', isActive: true });
  await db.doc(`staff/${OWNER}`).set({ id: OWNER, tenantId: TENANT, name: 'Owner', role: 'owner', status: 'active' });
  for (const person of [A, B]) {
    await db.doc(`staff/${person.staff}`).set({ id: person.staff, tenantId: TENANT, name: person.name, role: 'cashier', status: 'active' });
    await db.doc(`devices/${person.device}`).set({ id: person.device, tenantId: TENANT, branchId: BRANCH, status: 'active' });
    await db.doc(`shifts/${person.shift}`).set({
      id: person.shift, tenantId: TENANT, branchId: BRANCH, deviceId: person.device,
      staffId: person.staff, status: 'open', expectedCashMinor: 0, openingFloatMinor: 0,
    });
  }
  for (const [id, name, priceMinor] of [['prod-beer', 'Tusker 500ml', 40000], ['prod-water', 'Drinking Water', 10000]]) {
    await db.doc(`products/${id}`).set({
      id, tenantId: TENANT, name, sku: id.toUpperCase(), sellPriceMinor: priceMinor,
      taxCode: 'A', isActive: true, trackStock: true, isService: false, showOnMenu: true,
    });
    await db.doc(`stock_balances/${BRANCH}_${id}_HOUSE`).set({
      tenantId: TENANT, branchId: BRANCH, productId: id, location: 'HOUSE', qty: 500,
    });
  }
}

const sale = (person, uuid, payments, lines) => ({
  tenantId: TENANT, branchId: BRANCH, deviceId: person.device, shiftId: person.shift,
  staffId: person.staff, customerId: 'cust-walkin', idempotencyKey: uuid,
  tableNumber: '7', lines, payments,
});
const beer = (qty) => ({ productId: 'prod-beer', qty, unitPriceMinor: 40000 });
async function printBill(target, deviceId, token) {
  const job = await call('prepareCheckoutReceipt', { ...target, queue: true }, token);
  if (!job.printed) await call('confirmCheckoutReceiptPrinted', { jobId: job.jobId, deviceId, confirmed: true }, token);
}

const run = async () => {
  await seed();
  const owner = await tokenFor('uid-owner', { tenant_id: TENANT, staff_id: OWNER, staff_role: 'owner' });
  const akashi = await tokenFor('uid-a', { tenant_id: TENANT, staff_id: A.staff, staff_role: 'cashier' });
  const clemente = await tokenFor('uid-b', { tenant_id: TENANT, staff_id: B.staff, staff_role: 'cashier' });

  // Every shilling the tills actually move, tracked independently of the books.
  const moved = { cash: 0, mpesa: 0, bank: 0, card: 0 };

  log('\n== 1. Akashi rings up a cash sale ==');
  const cashSale = await call('createSale', sale(A, 'uuid-cash', [{ method: 'credit', amountMinor: 80000 }], [beer(2)]), akashi);
  // Never printed: print-first is off (PRINT_BEFORE_PAYMENT), so payment must still go through.
  await call('settleSale', { saleUuid: 'uuid-cash', requestId: 'req-cash', method: 'cash' }, akashi);
  moved.cash += 800;
  log(`   ${cashSale.sale.invoiceNumber} — KES 800 cash`);

  log('\n== 2. Akashi rings up a proforma and settles it by BANK ==');
  const proformaA = await call('createSale', sale(A, 'uuid-bank', [{ method: 'credit', amountMinor: 120000 }], [beer(3)]), akashi);
  await printBill({ saleUuids: ['uuid-bank'] }, A.device, akashi);
  const bank = await call('settleSale', { saleUuid: 'uuid-bank', requestId: 'req-bank', method: 'bank_transfer', reference: 'FT26091234' }, akashi);
  moved.bank += 1200;
  log(`   ${proformaA.sale.invoiceNumber} — settled by bank, ref ${bank.reference}`);

  log('\n== 3. Clemente rings up a proforma and settles it in CASH ==');
  await call('createSale', sale(B, 'uuid-cash2', [{ method: 'credit', amountMinor: 40000 }], [beer(1)]), clemente);
  await printBill({ saleUuids: ['uuid-cash2'] }, B.device, clemente);
  await call('settleSale', { saleUuid: 'uuid-cash2', requestId: 'req-cash2', method: 'cash' }, clemente);
  moved.cash += 400;
  log('   settled in cash');

  log('\n== 4. Clemente leaves a proforma UNSETTLED (a real receivable) ==');
  const owing = await call('createSale', sale(B, 'uuid-owing', [{ method: 'credit', amountMinor: 40000 }], [beer(1)]), clemente);
  log(`   ${owing.sale.invoiceNumber} — KES 400 still owed`);

  log('\n== 5. A table-menu order, settled by BANK at the counter ==');
  const menu = await call('submitCustomerOrder', {
    tenantId: TENANT, branchId: BRANCH, requestId: 'menu-req-1',
    customerName: 'Otieno', orderType: 'dine_in', tableNumber: '3',
    lines: [{ productId: 'prod-water', qty: 2, unitPriceMinor: 10000 }],
  }, clemente).catch((error) => { problems.push(`submitCustomerOrder: ${error.message}`); return null; });
  if (menu) {
    await printBill({ customerOrderId: menu.orderId }, B.device, clemente);
    await call('settleCustomerOrderBank', { orderId: menu.orderId, reference: 'FT26095555' }, clemente);
    moved.bank += menu.totalMinor / 100;
    log(`   ${menu.ref} — settled by bank`);
  }

  log('\n== 6. Clemente publishes an order still held on his till ==');
  await call('publishOpenOrders', {
    branchId: BRANCH, deviceId: B.device,
    orders: [{
      key: 'sale-held', kind: 'sale', ref: 'INV-BH001-190132', tableNumber: '11',
      totalMinor: 10000, dueMinor: 0, lines: [{ name: 'Drinking Water', qty: 1 }],
      saleUuids: ['mpesa_held-uuid'], staffId: B.staff,
      payments: [{ id: 'held-pay', method: 'BANK_TRANSFER', amountMinor: 10000, reference: '00100', staffId: B.staff, paidAt: new Date().toISOString() }],
    }],
  }, clemente);
  log('   published: KES 100 bank, held on the till');

  log('\n== 6b. The till path: a sale tendered straight to BANK, with a reference ==');
  // Till and Orders both save an unpaid bill, print it, then record the tender.
  const tillBank = await call('createSale', sale(B, 'uuid-till-bank',
    [{ method: 'credit', amountMinor: 40000 }], [beer(1)]), clemente);
  await printBill({ saleUuids: ['uuid-till-bank'] }, B.device, clemente);
  await call('settleSale', { saleUuid: 'uuid-till-bank', requestId: 'req-till-bank', method: 'bank_transfer', reference: '54756376' }, clemente);
  moved.bank += 400;
  log(`   ${tillBank.sale.invoiceNumber} — KES 400 taken by bank transfer at the till`);

  log('\n== 6c. And one on the CARD terminal, likewise ==');
  const tillCard = await call('createSale', sale(A, 'uuid-till-card',
    [{ method: 'credit', amountMinor: 40000 }], [beer(1)]), akashi);
  await printBill({ saleUuids: ['uuid-till-card'] }, A.device, akashi);
  await call('settleSale', { saleUuid: 'uuid-till-card', requestId: 'req-till-card', method: 'card', reference: 'TERM-42' }, akashi);
  moved.card += 400;
  log(`   ${tillCard.sale.invoiceNumber} — KES 400 taken on the card terminal`);

  log('\n== 7. Akashi settles another proforma on the CARD terminal ==');
  await call('createSale', sale(A, 'uuid-card', [{ method: 'credit', amountMinor: 40000 }], [beer(1)]), akashi);
  // Also unprinted, as above.
  await call('settleSale', { saleUuid: 'uuid-card', requestId: 'req-card', method: 'card', reference: 'TERM-88' }, akashi);
  moved.card += 400;
  log('   settled on the card terminal');

  log('\n== 8. Integrity: the same sale submitted twice must not bill twice ==');
  const replay = await call('createSale', sale(A, 'uuid-cash', [{ method: 'credit', amountMinor: 80000 }], [beer(2)]), akashi);
  checkText('a replayed sale returns the original invoice', replay.sale.invoiceNumber, 'INV-BH001-000001');

  log('\n== 9. Integrity: a settled sale cannot be settled again ==');
  let refused = false;
  try {
    await call('settleSale', { saleUuid: 'uuid-bank', requestId: 'req-bank-2', method: 'cash' }, akashi);
  } catch (error) {
    refused = /outstanding/i.test(error.message);
    log(`   refused: ${error.message}`);
  }
  if (!refused) problems.push('a sale that was already settled accepted a second settlement');
  else log('   OK   double settlement refused');

  log('\n== 9b. A direct paid checkout cannot bypass saving the bill unpaid ==');
  await db.doc(`tenant_settings/${TENANT}`).update({ acceptedPaymentMethods: ['cash', 'mpesa'] });
  let named = false;
  try {
    await call('createSale', sale(A, 'uuid-nobank', [{ method: 'bank_transfer', amountMinor: 40000 }], [beer(1)]), akashi);
  } catch (error) {
    named = /Save the bill unpaid/.test(error.message);
    log(`   refused: ${error.message}`);
  }
  if (!named) problems.push('a direct paid checkout bypassed saving the bill unpaid first');
  else log('   OK   refused, and the cashier is told to save the bill unpaid first');
  await db.doc(`tenant_settings/${TENANT}`).update({ acceptedPaymentMethods: ['cash', 'mpesa', 'card', 'bank_transfer'] });

  // ---- The owner reads it all back, exactly as Financials does ----
  log('\n== OWNER reads the books ==');
  const { financialSnapshot, financialAnswer } = await import('../../../frontend/src/services/financial-snapshot.js');
  const read = async (name) => (await db.collection(name).where('tenantId', '==', TENANT).get())
    .docs.map((d) => ({ ...d.data(), id: d.id }));
  const [sales, payments, orders, held] = await Promise.all([
    read('sales'), read('payments'), read('customer_orders'), read('open_orders'),
  ]);

  const report = financialSnapshot({
    tenantId: TENANT, from: Date.now() - 86400000, to: Date.now() + 86400000,
    serverSales: sales, serverPayments: payments, customerOrders: orders, heldOrders: held,
    staffScope: null, session: 'full',
  });

  const movedTotal = moved.cash + moved.mpesa + moved.bank + moved.card;
  log(`\n   tills moved: cash ${moved.cash}, bank ${moved.bank}, total ${movedTotal}`);
  log(`   books say  : cash ${report.cash}, bank ${report.bank}, collected ${report.collected}`);

  check('collected tallies with money actually moved', report.collected, movedTotal);
  check('cash tallies', report.cash, moved.cash);
  check('bank tallies', report.bank, moved.bank);
  check('buckets sum to collected', report.cash + report.mpesa + report.bank + report.other, report.collected);
  check('the unsettled proforma is reported as owed', report.unpaid, 400);
  check('held on a till is disclosed', report.heldTotal, 100);
  check('held money is NOT counted as taken', report.bank, moved.bank);
  check('every sale the tills rang is on the books', report.count, 7);
  check('card takings land in card/other', report.other, moved.card);
  check('a replayed sale did not double the takings', report.collected, movedTotal);

  log('\n   every payment married to an order:');
  for (const row of report.transactions) {
    const named = row.invoice_no || row.order_reference || row.customer_order_id;
    const ok = Boolean(named) && !String(named).startsWith('mpesa_');
    log(`   ${ok ? 'OK  ' : 'FAIL'} ${row.method} ${row.amount} -> ${named || '(nothing)'}`);
    if (!ok) problems.push(`payment ${row.id} (${row.method} ${row.amount}) names no order: ${named}`);
  }

  log('\n   staff rundown:');
  const rundown = new Map(report.staffRundown.map((r) => [r.staff_id, r]));
  for (const [id, row] of rundown) log(`     ${id}: received ${row.received}, sales ${row.sales}, unpaid ${row.unpaid}`);
  check('rundown totals equal collected',
    report.staffRundown.reduce((sum, r) => sum + r.received, 0), report.collected);
  check('Akashi received cash 800 + bank 1200 + card 400 + card 400', rundown.get(A.staff)?.received ?? 0, 2800);
  check('Clemente received cash 400 + menu 200 + till bank 400', rundown.get(B.staff)?.received ?? 0, 1000);

  log('\n   AI answer:');
  const answer = financialAnswer({ ...report, startStr: 'today', endStr: 'today' });
  log(answer.split('\n').map((line) => `     ${line}`).join('\n'));
  for (const [label, needle] of [
    ['AI states the collected total', `KES ${movedTotal.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`],
    ['AI states bank transfers', `bank transfer: KES ${moved.bank.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`],
    ['AI discloses money held on a till', 'still held on a till'],
  ]) {
    const ok = answer.includes(needle);
    log(`   ${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (!ok) problems.push(`${label}: "${needle}" missing from the AI answer`);
  }

  // ---- The Orders Viewer, over the same server rows ----
  log('\n== ORDERS VIEWER (owner) ==');
  const { saleAsOrder, visibleOrders, handledBy } = await import('../../../frontend/src/services/customer-orders.js');
  const { toLocalSale } = { toLocalSale: (s) => ({
    id: s.id, tenant_id: s.tenantId, branch_id: s.branchId, staff_id: s.staffId,
    invoice_no: s.invoiceNumber, sale_uuid: s.idempotencyKey, table_no: s.tableNumber,
    grand_total: (s.totalMinor || 0) / 100, status: String(s.status || '').toUpperCase(),
    sold_at: s.soldAt?.toDate?.().toISOString?.() ?? new Date().toISOString(),
  }) };
  const paymentsBySale = new Map();
  for (const p of payments) {
    if (!p.saleId) continue;
    paymentsBySale.set(p.saleId, [...(paymentsBySale.get(p.saleId) || []), {
      method: String(p.method || '').toUpperCase(), amount: (p.amountMinor || 0) / 100,
      settled_at: p.settledAt ? 'settled' : null,
    }]);
  }
  const names = new Map([[A.staff, A.name], [B.staff, B.name], [OWNER, 'Owner']]);
  const board = sales.map((s) => {
    const row = toLocalSale(s);
    const order = saleAsOrder(row, { payments: paymentsBySale.get(s.id) });
    return { ...order, cashierName: handledBy(order, names) };
  });
  const shown = visibleOrders(board, BRANCH, { tab: 'all', search: '', allBranches: true });
  check('the owner sees every till sale on the board', shown.length, 7);
  for (const order of shown) {
    const ok = Boolean(order.cashierName);
    log(`   ${ok ? 'OK  ' : 'FAIL'} ${order.ref} — ${order.paymentStatus} — billed by ${order.cashierName || '(nobody)'}`);
    if (!ok) problems.push(`${order.ref} is on the board with nobody answerable for it`);
  }
  check('exactly one board order still reads unpaid',
    shown.filter((o) => o.paymentStatus === 'unpaid').length, 1);

  // ---- The same books, read by a cashier ----
  log('\n== SCOPING: Clemente reads the same data ==');
  const asClemente = financialSnapshot({
    tenantId: TENANT, from: Date.now() - 86400000, to: Date.now() + 86400000,
    serverSales: sales, serverPayments: payments, customerOrders: orders, heldOrders: held,
    staffScope: B.staff, session: 'full',
  });
  check('a cashier sees only their own takings', asClemente.collected, 1000);
  check('and only their own sales', asClemente.count, 3);
  check('the two staff views sum to the whole business',
    asClemente.collected + (report.staffRundown.find((r) => r.staff_id === A.staff)?.received ?? 0), movedTotal);
  check('while the owner still sees everything', report.collected, movedTotal);
  const leaked = asClemente.transactions.filter((r) => r.staff_id && r.staff_id !== B.staff);
  if (leaked.length) problems.push(`a cashier's view leaked ${leaked.length} other staff payment(s)`);
  log(`   OK   no other staff rows leaked into the cashier's view`);

  // ---- Voiding the unpaid order, and the books after it ----
  log('\n== 10. Clemente voids the order nobody paid for ==');
  await call('voidSale', { saleUuid: 'uuid-owing', reason: 'Rung up in error' }, clemente);
  let voidedPaid = false;
  try {
    await call('voidSale', { saleUuid: 'uuid-bank', reason: 'should be refused' }, clemente);
    voidedPaid = true;
  } catch (error) {
    log(`   paid order refused: ${error.message}`);
  }
  if (voidedPaid) problems.push('an order that had been paid for was voided instead of refunded');

  const [sales2, payments2, orders2, held2] = await Promise.all([
    read('sales'), read('payments'), read('customer_orders'), read('open_orders'),
  ]);
  const after = financialSnapshot({
    tenantId: TENANT, from: Date.now() - 86400000, to: Date.now() + 86400000,
    serverSales: sales2, serverPayments: payments2, customerOrders: orders2, heldOrders: held2,
    staffScope: null, session: 'full',
  });
  check('the voided order stops being owed', after.unpaid, 0);
  check('voiding took nothing out of the takings', after.collected, movedTotal);
  check('and the voided sale leaves the completed count', after.count, 6);

  log(`\n${problems.length ? `=== ${problems.length} PROBLEM(S) ===\n- ${problems.join('\n- ')}` : '=== SYSTEM CORRECT: books tally with money moved ==='}`);
  if (problems.length) process.exitCode = 1;
};

run().catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; });
