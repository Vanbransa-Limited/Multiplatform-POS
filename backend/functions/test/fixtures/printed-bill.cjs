const { receiptFingerprint } = require('../../lib/modules/sales/printed-receipt');

/** Existing payment regression fixtures represent bills already printed at the counter. */
function printedBill(data, lines = []) {
  if (!data) return data;
  return { ...data, printedReceipt: { fingerprint: receiptFingerprint(data, lines), confirmedAt: 'fixture-print', jobId: 'fixture-job' } };
}

function printedSnapshotData(docs, path) {
  const data = docs.get(path);
  if (path.startsWith('customer_orders/')) return printedBill(data, data?.lines || []);
  if (!path.startsWith('sales/')) return data;
  const id = path.split('/')[1];
  const lines = [...docs].filter(([key, row]) => key.startsWith('sale_lines/') && row.saleId === id)
    .sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  return printedBill(data, lines);
}
module.exports = { printedBill, printedSnapshotData };
