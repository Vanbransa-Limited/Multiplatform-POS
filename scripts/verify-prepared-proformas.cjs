'use strict';
// Read-only production reconciliation of an explicitly supplied import manifest.
const path = require('node:path');
const fs = require('node:fs');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore } = backend('firebase-admin/firestore');
async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('Pass the verified local import manifest.');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (manifest.projectId !== 'vanbransa-pos' || manifest.tenantId !== 'tenant-01') throw new Error('Unexpected verification target.');
  const app = initializeApp({ projectId: manifest.projectId, credential: applicationDefault() });
  const db = getFirestore(app);
  const { parseProforma } = require('../backend/functions/lib/modules/proformas');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  const { financialSnapshot } = await import('../frontend/src/services/financial-snapshot.js');
  try {
    const invoices = [], sales = [], payments = [];
    for (const row of manifest.records) {
      const id = deterministicId('proforma', `${manifest.tenantId}:${manifest.importReference}:${row.invoice.number}`);
      const doc = await db.collection('proformas').doc(id).get();
      const record = doc.data();
      if (!doc.exists || JSON.stringify(record.invoice) !== JSON.stringify(parseProforma(row.invoice))) {
        // Firestore maps do not guarantee key order.
        const assert = require('node:assert/strict');
        assert.deepEqual(record?.invoice, parseProforma(row.invoice), 'Imported invoice differs from approved document');
      }
      if (record.tenantId !== manifest.tenantId || record.createdByStaffId !== manifest.preparedByStaffId
        || record.paymentStatus !== 'unpaid' || record.source?.sha256 !== row.source.sha256
        || record.invoice.signedBy !== manifest.preparedByName) throw new Error('Wrong tenant, author, payment status or PDF provenance.');
      const receipts = await db.collection('payments').where('proformaId', '==', id).get();
      if (!receipts.empty) throw new Error('An imported unpaid invoice already has a received payment.');
      const number = await db.collection('proforma_numbers').doc(deterministicId('number', `${manifest.tenantId}:${row.invoice.number.toUpperCase()}`)).get();
      if (number.data()?.proformaId !== id) throw new Error('Invoice-number reservation is missing.');
      if (row.linkedSaleId) {
        const sale = await db.collection('sales').doc(row.linkedSaleId).get();
        if (sale.data()?.proformaId !== id || record.linkedSaleId !== sale.id) throw new Error('Original bill linkage is missing.');
        sales.push({ ...sale.data(), id: sale.id });
        const ledger = await db.collection('payments').where('saleId', '==', sale.id).get();
        payments.push(...ledger.docs.map(doc => ({ ...doc.data(), id: doc.id })));
      }
      invoices.push({ ...record, id });
    }
    const report = financialSnapshot({ tenantId: manifest.tenantId,
      from: Date.parse('2026-10-01T00:00:00+03:00'), to: Date.parse('2026-12-01T23:59:59+03:00'),
      serverSales: sales, serverPayments: payments, proformas: invoices });
    const total = manifest.records.reduce((sum, row) => sum + row.expectedDueMinor, 0);
    if (Math.round(report.unpaid * 100) !== total || report.unpaidOrders.length !== 3 || report.collected !== 0) throw new Error('Targeted invoice reconciliation is inconsistent or duplicated.');
    console.log(JSON.stringify({ verifiedProject: manifest.projectId, tenant: manifest.tenantName, preparedBy: manifest.preparedByName,
      invoices: invoices.map(row => ({ number: row.invoice.number, id: row.id, amountKES: row.invoice.dueMinor / 100,
        paymentStatus: row.paymentStatus, sourceHashVerified: true, linkedSaleId: row.linkedSaleId || null })),
      targetedUnpaidKES: report.unpaid, targetedReceivedKES: report.collected, originalBillCountedOnce: true }, null, 2));
  } finally { await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
