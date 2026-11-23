import { db } from '../db/schema';
import { state } from '../context';
import { isReceivable } from './takings';

/** Mirror one server payment atomically; replaying its ID never reduces debt twice. */
export async function recordReceiptSettlement(round, result, { reduceCustomerBalance = false } = {}) {
  const now = new Date().toISOString();
  await db.transaction('rw', [db.sales, db.payments, db.customers], async () => {
    if (await db.payments.get(result.paymentId)) return;
    let toApply = result.settledMinor;
    for (const row of await db.payments.where('sale_id').equals(round.id).toArray()) {
      if (row.settled_at || !isReceivable(row.method) || toApply <= 0) continue;
      const minor = Math.round(Number(row.amount) * 100), applied = Math.min(toApply, minor);
      toApply -= applied;
      await db.payments.update(row.id, applied < minor ? { amount: (minor - applied) / 100 }
        : { settled_at: now, settled_reference: result.reference || '' });
    }
    await db.payments.put({ id: result.paymentId, sale_id: round.id, method: String(result.method).toUpperCase(),
      amount: result.settledMinor / 100, reference: result.reference || '', provider_txn_id: result.reference || '',
      verified: result.verified ? 1 : 0, received_at: now, staff_id: state.currentUser?.id || '',
      receipt_allocation_id: result.receiptAllocationId || null, receipt_limit_minor: result.receiptLimitMinor || null });
    if (!result.outstandingMinor) await db.sales.update(round.id, { status: 'COMPLETED', held_until: null });
    if (reduceCustomerBalance && round.customer_id) {
      const customer = await db.customers.get(round.customer_id);
      if (customer) await db.customers.update(customer.id, {
        credit_balance: Math.max(0, (customer.credit_balance || 0) - result.settledMinor / 100),
      });
    }
  });
}
