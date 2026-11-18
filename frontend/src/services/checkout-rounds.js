import { isReceivable } from './takings.js';
import { toMinor } from './tender.js';

const adjustmentIds = new Set(['prod-staff-discount', 'prod-table-service']);

/** Empty charge/discount markers have no goods, debt or received money. */
export function isNonBillableAdjustment(sale, lines, payments = []) {
  return !sale?.synced_at && sale?.status === 'PENDING_PAYMENT' && Number(sale?.grand_total) === 0 && lines.length > 0
    && lines.every(line => adjustmentIds.has(line.product_id)
      && Number(line.unit_price) === 0 && Number(line.line_total) === 0)
    && payments.every(row => isReceivable(row.method) && toMinor(row.amount) === 0
      && !row.settled_at && !row.reference && !row.provider_txn_id);
}

export async function billableCheckoutRounds(rounds, ledger) {
  const result = [];
  for (const round of rounds) {
    if (round.sync_omitted === 'adjustment_only') continue;
    if (!round.synced_at && Number(round.grand_total) === 0) {
      const [lines, payments] = await Promise.all([
        ledger.sale_lines.where('sale_id').equals(round.id).toArray(),
        ledger.payments.where('sale_id').equals(round.id).toArray(),
      ]);
      if (isNonBillableAdjustment(round, lines, payments)) continue;
    }
    result.push(round);
  }
  return result;
}

/** Recover debt on an unpaid bill; never invent a received tender. */
export function missingReceivable(sale, payments) {
  if (sale.status !== 'PENDING_PAYMENT' || sale.synced_at || toMinor(sale.grand_total) <= 0
    || payments.some(row => isReceivable(row.method) && (row.settled_at || toMinor(row.amount) > 0))) return null;
  const received = payments.filter(row => !isReceivable(row.method)).reduce((sum,row) => sum + Math.max(0,toMinor(row.amount)),0);
  const due = toMinor(sale.grand_total) - received;
  if (due <= 0) return null;
  return { id: `recovered-credit-${sale.id}`, sale_id: sale.id, method: 'PROFORMA', amount: due / 100,
    reference: '', provider_txn_id: '', verified: 0, received_at: sale.sold_at || new Date().toISOString() };
}
