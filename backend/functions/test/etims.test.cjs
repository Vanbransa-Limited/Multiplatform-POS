const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSalesBody, itemCode, kraTaxType, kraTime, paymentType, verifyUrl } = require('../lib/modules/etims/oscu');

test('POS tax codes map onto KRA tax types', () => {
  assert.equal(kraTaxType('A'), 'B'); // 16%
  assert.equal(kraTaxType('B'), 'E'); // 8%
  assert.equal(kraTaxType('C'), 'A'); // exempt
  assert.equal(kraTaxType('E'), 'C'); // zero-rated
  assert.throws(() => kraTaxType('Z'));
});

test('KRA timestamps are Nairobi wall-clock time', () => {
  assert.equal(kraTime(new Date('2026-11-13T21:30:05Z')), '20261114003005');
});

test('item codes follow spec 4.19', () => {
  assert.equal(itemCode(false, 12), 'KE2NTXU0000012');
  assert.equal(itemCode(true, 1), 'KE3NTXU0000001');
});

test('the payment type is the tender that paid most; a settled receivable is not credit', () => {
  assert.equal(paymentType([{ method: 'cash', amountMinor: 100 }, { method: 'mpesa', amountMinor: 900 }]), '06');
  assert.equal(paymentType([{ method: 'credit', amountMinor: 900, settledAt: 'x' }, { method: 'card', amountMinor: 900 }]), '05');
  assert.equal(paymentType([{ method: 'credit', amountMinor: 900 }]), '02');
  assert.equal(paymentType([]), '07');
});

test('the sales body is VAT-inclusive and its buckets tie to the lines', () => {
  const body = buildSalesBody({
    tin: 'P051234567A', bhfId: '00', invcNo: 7, trdInvcNo: 'INV-BH001-000042', buyerPin: 'A123456789Z',
    soldAt: new Date('2026-11-13T09:00:00Z'), confirmedAt: new Date('2026-11-13T09:05:00Z'), staffId: 'staff-1',
    payments: [{ method: 'cash', amountMinor: 735000 }],
    lines: [
      { productName: 'Tusker', qty: 2, unitPriceMinor: 350000, discountMinor: 0, taxCode: 'A', taxMinor: 96552, lineTotalMinor: 700000, itemCd: 'KE2NTXU0000001', itemClsCd: '5059690800' },
      { productName: 'Water', qty: 1, unitPriceMinor: 40000, discountMinor: 5000, taxCode: 'C', taxMinor: 0, lineTotalMinor: 35000, itemCd: 'KE2NTXU0000002', itemClsCd: '5059690800' },
    ],
  });
  assert.equal(body.invcNo, 7);
  assert.equal(body.custTin, 'A123456789Z');
  assert.equal(body.salesDt, '20261113');
  assert.equal(body.cfmDt, '20261113120500');
  assert.equal(body.taxblAmtB, 7000);
  assert.equal(body.taxAmtB, 965.52);
  assert.equal(body.taxblAmtA, 350);
  assert.equal(body.totAmt, 7350);
  assert.equal(body.totTaxAmt, 965.52);
  assert.equal(body.totItemCnt, 2);
  const [, water] = body.itemList;
  assert.deepEqual(
    [water.taxTyCd, water.splyAmt, water.dcAmt, water.dcRt, water.taxblAmt, water.totAmt],
    ['A', 400, 50, 12.5, 350, 350],
  );
});

test('the verification link carries PIN, branch and signature', () => {
  assert.equal(
    verifyUrl('production', 'P051234567A', '00', 'QUII27MATATSHFRB'),
    'https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567A00QUII27MATATSHFRB',
  );
});
