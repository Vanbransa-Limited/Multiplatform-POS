'use strict';
// Explicit, replay-safe import of the three user-supplied Titanium documents.
// Default is read-only. Credentials remain outside this repository.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  if (!args.includes('--manifest') || !args.includes('--project')) throw new Error('Pass --manifest <local JSON> and --project vanbransa-pos. --apply writes; default is dry run.');
  const projectId = option('--project');
  const manifest = JSON.parse(fs.readFileSync(option('--manifest'), 'utf8'));
  if (projectId !== 'vanbransa-pos' || manifest.projectId !== projectId || manifest.tenantId !== 'tenant-01'
    || manifest.tenantName !== 'Titanium' || manifest.preparedByName !== 'Judith Nandacha') throw new Error('This import is restricted to the approved Titanium/Judith batch.');
  const expected = { 'PF-261118-01': 1036000, 'PF-261116-01': 2498400, 'PF-261116-02': 750000 };
  if (manifest.records.length !== 3 || new Set(manifest.records.map(row => row.invoice.number)).size !== 3) throw new Error('Expected exactly three distinct approved invoices.');
  const app = initializeApp({ projectId, credential: applicationDefault() });
  const db = getFirestore(app);
  const { parseProforma } = require('../backend/functions/lib/modules/proformas');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  const { outstandingMinor } = require('../backend/functions/lib/modules/sales/settle');
  const records = manifest.records.map(row => {
    const invoice = parseProforma(row.invoice);
    const requiredLink = invoice.number === 'PF-261116-02' ? 'sale-310193f0b67ffa360ed757133b8ea713ba441d84f2de0c7c' : null;
    if ((row.linkedSaleId || null) !== requiredLink) throw new Error('The October proforma must link the verified original bill; the other two must remain unlinked.');
    if (invoice.dueMinor !== expected[invoice.number] || invoice.dueMinor !== row.expectedDueMinor || invoice.signedBy !== manifest.preparedByName) throw new Error('Invoice number, amount or author differs from the approved PDF.');
    if (sha(fs.readFileSync(row.source.path)) !== row.source.sha256) throw new Error('An original PDF changed after extraction.');
    const id = deterministicId('proforma', `${manifest.tenantId}:${manifest.importReference}:${invoice.number}`);
    return { ...row, invoice, id,
      fingerprint: deterministicId('content', JSON.stringify({ invoice, branchId: manifest.branchId })),
      ref: db.collection('proformas').doc(id),
      numberRef: db.collection('proforma_numbers').doc(deterministicId('number', `${manifest.tenantId}:${invoice.number.toUpperCase()}`)),
    };
  });
  try {
    const result = await db.runTransaction(async tx => {
      const [tenant, branch, staff] = await tx.getAll(db.collection('tenants').doc(manifest.tenantId),
        db.collection('branches').doc(manifest.branchId), db.collection('staff').doc(manifest.preparedByStaffId));
      if (tenant.data()?.tradingName !== manifest.tenantName || tenant.data()?.status !== 'active'
        || branch.data()?.tenantId !== manifest.tenantId || branch.data()?.status !== 'active'
        || staff.data()?.tenantId !== manifest.tenantId || staff.data()?.name !== manifest.preparedByName || staff.data()?.status !== 'active') throw new Error('Business, branch or preparer no longer matches the verified account.');
      const pending = [];
      const result = [];
      for (const row of records) {
        const [existing, number] = await tx.getAll(row.ref, row.numberRef);
        if (existing.exists || number.exists) {
          if (existing.data()?.fingerprint !== row.fingerprint || existing.data()?.source?.sha256 !== row.source.sha256
            || existing.data()?.createdByStaffId !== manifest.preparedByStaffId || (existing.data()?.linkedSaleId || null) !== (row.linkedSaleId || null)
            || number.data()?.proformaId !== row.id) throw new Error(`Conflicting saved invoice ${row.invoice.number}; nothing imported.`);
          result.push({ number: row.invoice.number, id: row.id, result: 'already imported', dueMinor: row.invoice.dueMinor });
          continue;
        }
        let linked = null;
        if (row.linkedSaleId) {
          if (row.invoice.number !== 'PF-261116-02') throw new Error('Unexpected bill linkage.');
          linked = await tx.get(db.collection('sales').doc(row.linkedSaleId));
          const sale = linked.data();
          if (!linked.exists || sale?.tenantId !== manifest.tenantId || sale.branchId !== manifest.branchId
            || sale.invoiceNumber !== row.invoice.quoteRef || sale.totalMinor !== row.invoice.dueMinor
            || String(sale.status).toUpperCase() === 'VOIDED' || sale.proformaId
            || Number(sale.checkoutExpiresAt?.toMillis?.() || 0) > Date.now() || sale.checkoutStkKey) throw new Error('The original bill changed or payment is in progress; reconcile before importing.');
          const ledger = await tx.get(db.collection('payments').where('saleId', '==', row.linkedSaleId));
          if (outstandingMinor(ledger.docs.map(doc => doc.data())) !== row.invoice.dueMinor) throw new Error('Original bill is no longer wholly unpaid.');
        }
        pending.push({ row, linked });
        result.push({ number: row.invoice.number, id: row.id, result: args.includes('--apply') ? 'imported unpaid' : 'ready (dry run)', dueMinor: row.invoice.dueMinor, linkedSaleId: row.linkedSaleId || null });
      }
      if (args.includes('--apply')) {
        const now = Timestamp.now();
        for (const { row, linked } of pending) {
          tx.create(row.ref, { tenantId: manifest.tenantId, branchId: manifest.branchId, invoice: row.invoice,
            fingerprint: row.fingerprint, createdAt: now, importedAt: now, createdByStaffId: manifest.preparedByStaffId,
            preparedByStaffId: manifest.preparedByStaffId, paymentStatus: 'unpaid', importReference: manifest.importReference,
            source: { filename: row.source.filename, sha256: row.source.sha256 },
            ...(row.linkedSaleId ? { linkedSaleId: row.linkedSaleId } : {}) });
          tx.create(row.numberRef, { tenantId: manifest.tenantId, proformaId: row.id });
          if (linked) tx.update(linked.ref, { proformaId: row.id });
          tx.create(db.collection('audit_logs').doc(deterministicId('proforma-import', `${manifest.tenantId}:${row.id}`)), {
            tenantId: manifest.tenantId, actorType: 'admin_import', action: 'proforma.imported', entityId: row.id,
            preparedByStaffId: manifest.preparedByStaffId, createdAt: now,
            metadata: { importReference: manifest.importReference, number: row.invoice.number, dueMinor: row.invoice.dueMinor, sourceSha256: row.source.sha256, linkedSaleId: row.linkedSaleId || null } });
        }
      }
      return result;
    });
    console.log(JSON.stringify({ projectId, tenant: manifest.tenantName, preparedBy: manifest.preparedByName,
      mode: args.includes('--apply') ? 'apply' : 'dry-run', invoices: result, totalDueMinor: result.reduce((sum, row) => sum + row.dueMinor, 0) }, null, 2));
  } finally { await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
