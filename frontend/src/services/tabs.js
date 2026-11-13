/**
 * Tabs: the rounds one table runs up over a night.
 *
 * A customer orders a beer at nine, something else at eleven, and more again at
 * midnight. Each round is its own order - nothing already rung up is edited and
 * the kitchen never re-fires food it has sent - and the tab is what ties them
 * together so one payment can close the lot.
 *
 * A tab stays open until somebody closes it. Nothing expires it on a clock,
 * because a table that is still drinking at 2am has not stopped being a table.
 * The protection against that running forever is at the other end: a shift
 * cannot be closed while tabs are still open, so the night has to be resolved
 * by the person who worked it rather than discovered by whoever opens up.
 *
 * Kept free of Dexie and the DOM so the rules can be exercised in a node test.
 */

/** A tab nobody has closed. Only these can take another round. */
export const OPEN = 'OPEN';
/** Paid off in full. */
export const SETTLED = 'SETTLED';
/** Closed without being paid - a walk-out, or written off. */
export const CLOSED = 'CLOSED';

/** How a tab that was never paid came to be closed. */
export const CLOSE_REASONS = new Set(['walkout', 'written_off', 'moved_to_account']);

/**
 * The number the table is known by.
 *
 * One tab, one order number, for the whole night. Each round still gets its
 * own invoice number because each is its own fiscal document to KRA, but
 * nobody on the floor or at the table should have to know that: they ask for
 * table nine's bill, and this is what it is called.
 */
export function tabOrderNumber(tableNo, now = new Date()) {
  return `ORD-${String(tableNo).toUpperCase()}-${now.getTime().toString().slice(-6)}`;
}

export function newTab({ id, tenantId, branchId, tableNo, customerId, staffId, shiftId, now }) {
  const table = String(tableNo || '').trim();
  if (!table) throw new Error('A tab needs a table.');
  return {
    id,
    order_no: tabOrderNumber(table, now ? new Date(now) : new Date()),
    tenant_id: tenantId,
    branch_id: branchId,
    table_no: table,
    customer_id: customerId || null,
    // The shift that opened it, so closing that shift knows to ask about it.
    shift_id: shiftId || null,
    opened_by: staffId || null,
    opened_at: now,
    status: OPEN,
    closed_at: null,
    closed_by: null,
    close_reason: null,
  };
}

/**
 * The open tab at a table, if there is one.
 *
 * Deliberately by table and not by customer: the floor identifies a tab by
 * where it is sitting, and nobody types a customer in to add a round.
 */
export function openTabAt(tabs, branchId, tableNo) {
  const table = String(tableNo || '').trim();
  return (tabs || []).find((tab) => tab.status === OPEN
    && tab.table_no === table
    && (!branchId || tab.branch_id === branchId)) || null;
}

/**
 * What each open tab is worth, newest rounds included.
 *
 * `rounds` are the orders already mapped through `saleAsOrder`, so a round that
 * has been paid, or voided, contributes nothing - a tab is only ever what is
 * still owed on it.
 */
export function tabsWithTotals(tabs, rounds) {
  const byTab = new Map();
  for (const round of rounds || []) {
    if (!round.tabId) continue;
    byTab.set(round.tabId, [...(byTab.get(round.tabId) || []), round]);
  }

  return (tabs || [])
    .filter((tab) => tab.status === OPEN)
    .map((tab) => {
      // A voided round (an Edit items correction) is no longer on the table.
      const owned = (byTab.get(tab.id) || []).filter((round) => round.paymentStatus !== 'void');
      const unpaid = owned.filter((round) => round.paymentStatus === 'unpaid');
      return {
        ...tab,
        table: tab.table_no,
        rounds: owned,
        unpaidRounds: unpaid,
        dueMinor: unpaid.reduce((total, round) => total + (Number(round.dueMinor) || 0), 0),
        items: unpaid.reduce(
          (count, round) => count + (round.lines || []).reduce((n, line) => n + (Number(line.qty) || 0), 0),
          0,
        ),
      };
    })
    // Oldest first: the table that has been open longest needs dealing with.
    .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
}

/**
 * Whether a shift may close.
 *
 * An open tab is money standing on the floor. Letting a shift close over one
 * leaves it for a morning where nobody remembers who was sitting there, so the
 * close is refused and names the tables rather than warning and continuing.
 */
export function shiftCloseBlockers(tabs, branchId) {
  return (tabs || []).filter((tab) => tab.status === OPEN
    && (!branchId || tab.branch_id === branchId));
}

/**
 * A round's totals, rebuilt from the lines it has left.
 *
 * Removing an item has to leave the sale, the receivable and the bill all
 * saying the same number, so they are all derived from the lines rather than
 * adjusted by the amount that went.
 */
export function roundTotals(lines) {
  const sum = (get) => (lines || []).reduce((total, line) => total + (Number(get(line)) || 0), 0);
  const subtotal = sum((line) => (Number(line.unit_price) || 0) * (Number(line.qty) || 0));
  const discount = sum((line) => line.discount);
  return {
    subtotal,
    discount,
    tax_total: sum((line) => line.tax_amount),
    grand_total: subtotal - discount,
  };
}

/** A tab with nothing left owing is settled; anything else needs a reason. */
export function closingUpdate({ dueMinor, reason, staffId, now }) {
  if (dueMinor > 0 && !CLOSE_REASONS.has(reason)) {
    throw new Error('Say how this unpaid tab is being closed.');
  }
  return {
    status: dueMinor > 0 ? CLOSED : SETTLED,
    closed_at: now,
    closed_by: staffId || null,
    close_reason: dueMinor > 0 ? reason : null,
  };
}

/**
 * Whether anything on a table's tab is still owed.
 *
 * A voided round owes nothing - it was taken back - and a round with a
 * receivable nobody has settled keeps the table open. Pure, so the rule that
 * decides whether a table is free can be checked without a database.
 */
export function tabOwes(rounds, paymentsBySale, asOrder) {
  return (rounds || []).some((sale) => sale.status !== 'VOIDED'
    && asOrder(sale, { payments: paymentsBySale.get(sale.id) }).paymentStatus === 'unpaid');
}
