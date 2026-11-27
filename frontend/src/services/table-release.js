import { saleAsOrder } from './customer-orders.js';

/**
 * Releasing a table: the physical table goes to the next customer while the
 * bill stays owed and payable from Orders (agreed 27 Nov 2026). The server does
 * the release (releaseTable); this decides what may be asked and lists what
 * managers need to follow up. Pure, so it is tested without a screen.
 */

/** The reason as sent, or an error saying what is wrong with it. */
export function releaseReason(text) {
  const reason = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (reason.length < 3 || reason.length > 200) {
    return { error: 'Give a reason of 3 to 200 characters for releasing the table.' };
  }
  return { reason };
}

/**
 * What to release for one Tab Management card, or why it cannot be released
 * from here. Only a tab the server holds (it carries `serverTabId` once the
 * server's tables are known) can be released, and never while rounds are
 * still on their way up: the server cannot release what it has not got.
 */
export function releaseTarget(tab, { online = true } = {}) {
  if (!online) return { blocked: 'Releasing a table needs a connection to the server.' };
  if (Number(tab?.pendingUploadMinor) > 0) return { blocked: 'Some rounds are still uploading from this till. Release once they reach the server.' };
  const tabId = tab?.serverTabId;
  if (!tabId || String(tabId).startsWith('recovered-')) {
    return { blocked: 'This tab is not on the server yet, or is still on another till. Release it once it uploads.' };
  }
  if (!(Number(tab.dueMinor) > 0)) return { blocked: 'Nothing is owed; the table frees itself once paid.' };
  return { tableNumber: String(tab.table ?? tab.table_no ?? ''), tabId, dueMinor: Number(tab.dueMinor) };
}

/**
 * Released bills still owed, one entry per released tab, newest release first.
 * `sales` and `payments` are this till's local rows (pulled from the server).
 */
export function releasedUnpaid(sales, payments, branchId) {
  const ledger = new Map();
  for (const row of payments || []) ledger.set(row.sale_id, [...(ledger.get(row.sale_id) || []), row]);
  const bills = new Map();
  for (const sale of sales || []) {
    if (!sale.table_release || sale.status === 'VOIDED' || (branchId && sale.branch_id !== branchId)) continue;
    const order = saleAsOrder(sale, { payments: ledger.get(sale.id) || [] });
    const key = sale.tab_id || sale.id;
    const bill = bills.get(key) || { tabId: key, table: sale.table_no || '', ref: sale.order_reference || sale.invoice_no || sale.id,
      dueMinor: 0, rounds: 0, releasedBy: sale.table_release.by, releasedAt: sale.table_release.at, reason: sale.table_release.reason };
    bill.dueMinor += order.dueMinor;
    bill.rounds += 1;
    bills.set(key, bill);
  }
  return [...bills.values()].filter(bill => bill.dueMinor > 0)
    .sort((a, b) => String(b.releasedAt || '').localeCompare(String(a.releasedAt || '')));
}

/** Rounds refused for naming a released tab, kept on this till for review. */
export function heldRounds(sales, branchId) {
  return (sales || []).filter(sale => sale.sync_hold && sale.status !== 'VOIDED' && (!branchId || sale.branch_id === branchId))
    .map(sale => ({ id: sale.id, ref: sale.invoice_no || sale.id, table: sale.table_no || sale.sync_hold_detail?.table_no || '',
      totalMinor: Math.round((Number(sale.grand_total) || 0) * 100), releasedTabRef: sale.sync_hold_detail?.order_reference || '',
      heldAt: sale.sync_hold_detail?.held_at || null, message: sale.sync_error_msg || '' }));
}
