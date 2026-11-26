import { db } from '../db/schema';
import { logAuditEvent } from '../db/index';
import { state } from '../context';
import { roundTotals, closingUpdate, tabOwes, tabsWithTotals, OPEN } from './tabs';
import { saleAsOrder } from './customer-orders';
import { billableCheckoutRounds } from './checkout-rounds';
import { serverTableSessions, withServerSessions } from './table-sessions';

/**
 * Takes one item off an open tab.
 *
 * Somebody rings a round for the wrong table, or adds a drink nobody asked
 * for, and it has to come off before the bill is called for. A round on an
 * open tab has not gone to the server - that is what `awaitingTransmission`
 * holds back - so this is the only copy, and correcting it here is safe.
 *
 * The stock the line took is put back as its own reversing movement rather
 * than by deleting the original: the item really did leave the shelf for a
 * while, and the ledger should say so.
 *
 * The round's totals and its receivable row are rebuilt from the lines that
 * remain, so the sale, what is owed and the printed bill cannot drift apart.
 * A round with nothing left is voided outright rather than left as a sale of
 * nothing.
 */
export async function removeTabLine(lineId) {
  const line = await db.sale_lines.get(lineId);
  if (!line) throw new Error('That item is no longer on the tab.');

  const round = await db.sales.get(line.sale_id);
  if (!round) throw new Error('That round is no longer on the tab.');
  if (round.status !== 'PENDING_PAYMENT') {
    throw new Error('That round has already been paid for. Refund it rather than editing it.');
  }
  if (round.synced_at) return replaceServerRound(round, line);
  if (round.sharing_pending) {
    throw new Error('That round is uploading right now. Try again in a few seconds.');
  }

  const remaining = (await db.sale_lines.where('sale_id').equals(line.sale_id).toArray())
    .filter((row) => row.id !== line.id);
  const totals = roundTotals(remaining);
  const now = new Date().toISOString();
  // Read before the transaction opens. `products` is not one of its tables, and
  // Dexie refuses a table outside the scope, which rolled back every removal.
  const product = await db.products.get(line.product_id);

  await db.transaction(
    'rw',
    [db.sales, db.sale_lines, db.payments, db.stock_movements, db.audit_log],
    async () => {
      const current = await db.sales.get(round.id);
      if (current?.synced_at || current?.sharing_pending) throw new Error('This round has been shared and cannot be edited locally.');
      await db.sale_lines.delete(line.id);

      // Services never moved stock, so there is nothing to give back.
      if (!product?.is_service) {
        await db.stock_movements.add({
          id: crypto.randomUUID(),
          tenant_id: round.tenant_id,
          branch_id: round.branch_id,
          product_id: line.product_id,
          batch_id: null,
          type: 'SALE_VOID',
          location: 'HOUSE',
          qty: line.qty,
          unit_cost: line.unit_cost_at_sale,
          ref_type: 'SALE',
          ref_id: round.id,
          reason: 'Item removed from tab',
          created_by: state.currentUser?.id,
          created_at: now,
        });
      }

      if (remaining.length === 0) {
        // Nothing left to bill: the round goes rather than standing at zero.
        await db.sales.update(round.id, { status: 'VOIDED', voided_at: now });
        for (const row of await db.payments.where('sale_id').equals(round.id).toArray()) {
          await db.payments.delete(row.id);
        }
      } else {
        await db.sales.update(round.id, totals);
        // The receivable is what the round is now worth, not what it was.
        for (const row of await db.payments.where('sale_id').equals(round.id).toArray()) {
          if (row.settled_at) continue;
          await db.payments.update(row.id, { amount: Number(totals.grand_total.toFixed(2)) });
        }
      }

      await logAuditEvent(
        round.tenant_id,
        state.currentUser?.id,
        'TAB_ITEM_REMOVED',
        'SALE',
        round.id,
        null,
        JSON.stringify({ productId: line.product_id, qty: line.qty, lineTotal: line.line_total }),
      );
    },
  );

  // Emptying the last round voids it, and a tab with nothing left owing is
  // over. Closing it is what takes it off Tab Management and frees the table.
  const freedTable = await freeSettledTab(round.tab_id);

  return { roundId: round.id, voidedRound: remaining.length === 0, freedTable, ...totals };
}

/**
 * Removes an item from an unpaid round the server already holds.
 *
 * Every round now uploads as soon as it is rung, so the local-only edit above
 * almost never applied. The server sale is voided (which returns its stock on
 * the server) and the remaining lines go back up as a new round under a fresh
 * idempotency key, still attributed to the seller, shift and table that rang
 * it. The voided row stays locally under its old uuid so a history pull maps
 * onto it instead of duplicating it.
 */
async function replaceServerRound(round, line) {
  const payments = await db.payments.where('sale_id').equals(round.id).toArray();
  if (payments.some((row) => row.settled_at)) {
    throw new Error('Part of that round has been paid. Refund it rather than editing it.');
  }
  const remaining = (await db.sale_lines.where('sale_id').equals(round.id).toArray())
    .filter((row) => row.id !== line.id);
  const product = await db.products.get(line.product_id);
  const tab = round.tab_id ? await db.tabs.get(round.tab_id) : null;

  const { voidSale } = await import('./customer-orders');
  await voidSale({
    saleUuid: round.sale_uuid,
    reason: `Item removed: ${line.qty} × ${product?.name || line.product_id}`,
  });

  const now = new Date().toISOString();
  const totals = roundTotals(remaining);
  const replacementId = crypto.randomUUID();

  await db.transaction('rw', [db.sales, db.sale_lines, db.payments, db.audit_log], async () => {
    await db.sales.update(round.id, { status: 'VOIDED', voided_at: now });
    for (const row of payments) await db.payments.update(row.id, { status: 'VOIDED' });
    if (remaining.length === 0) return;

    await db.sales.add({
      ...round,
      ...totals,
      id: replacementId,
      sale_uuid: crypto.randomUUID(),
      // A new fiscal document: the server mints its invoice number. Copying the
      // voided one gave two rows the same number, and the upload then named the
      // tab after it, so the tab's reference drifted with every edit.
      invoice_no: null,
      server_sale_id: null,
      server_invoice_no: null,
      order_reference: round.order_reference || tab?.order_no || round.invoice_no || null,
      // Same seller as the voided round, so the board and finance still name them.
      created_by: round.created_by || round.staff_id,
      staff_id: round.staff_id || round.created_by,
      status: 'PENDING_PAYMENT',
      replaces_sale_uuid: round.sale_uuid,
      synced_at: null,
      sharing_pending: 0,
      held_until: null,
      fiscal_status: 'QUEUED',
      sync_error_msg: null,
      sync_retry_after: null,
      sold_at: now,
    });
    // Copied, not moved: pulled lines keep server ids, and a later history
    // pull would bulkPut them back onto the voided sale.
    for (const row of remaining) await db.sale_lines.add({ ...row, id: crypto.randomUUID(), sale_id: replacementId });
    await db.payments.add({
      id: crypto.randomUUID(),
      sale_id: replacementId,
      method: 'PROFORMA',
      amount: Number(totals.grand_total.toFixed(2)),
      reference: '',
      provider_txn_id: '',
      verified: 0,
      received_at: now,
    });
    await logAuditEvent(
      round.tenant_id,
      state.currentUser?.id,
      'TAB_ITEM_REMOVED',
      'SALE',
      round.id,
      null,
      JSON.stringify({ productId: line.product_id, qty: line.qty, lineTotal: line.line_total, replacementId }),
    );
  });

  state.syncManager?.syncOutbox().catch(() => {});
  const freedTable = remaining.length === 0 ? await freeSettledTab(round.tab_id) : null;
  return { roundId: replacementId, voidedRound: remaining.length === 0, freedTable, ...totals };
}

/**
 * Every open tab, with what each still owes.
 *
 * One reading shared by the till and Tab Management, so the two screens never
 * disagree about what a table owes.
 */
export async function readOpenTabs(branchId) {
  const local = await readLocalOpenTabs(branchId);
  // Never inside the Dexie transaction: a network wait there would commit it.
  const sessions = await serverTableSessions().catch(() => null);
  return withServerSessions(local, sessions && sessions.filter(s => !branchId || s.branchId === branchId));
}

/** This device's own view: what it rang, plus rounds it has pulled from the server. */
async function readLocalOpenTabs(branchId) {
  return db.transaction('r', [db.tabs, db.sales, db.payments, db.sale_lines, db.products], async () => {
  const tabs = await (branchId
    ? db.tabs.where('[branch_id+status]').equals([branchId, OPEN])
    : db.tabs.where('status').equals(OPEN)).toArray();
  // Check the unpaid ledger as well as tab headers. An absent or incorrectly
  // settled header must not make a saved, unpaid round disappear from view.
  const pending = await db.sales.where('status').equals('PENDING_PAYMENT')
    .filter(sale => !sale.proforma_id && (!branchId || sale.branch_id === branchId) && Boolean(sale.table_no)).toArray();
  if (!tabs.length && !pending.length) return [];
  const onOpenTabs = tabs.length ? await db.sales.where('tab_id').anyOf(tabs.map(tab => tab.id)).toArray() : [];
  const sales = [...new Map([...onOpenTabs, ...pending].map(sale => [sale.id, sale])).values()];
  const ids = sales.map(sale => sale.id);
  const [payments, lines] = ids.length ? await Promise.all([
    db.payments.where('sale_id').anyOf(ids).toArray(),
    db.sale_lines.where('sale_id').anyOf(ids).toArray(),
  ]) : [[], []];
  const ledger = new Map();
  for (const row of payments) {
    ledger.set(row.sale_id, [...(ledger.get(row.sale_id) || []), row]);
  }
  const products = await db.products.bulkGet([...new Set(lines.map(line => line.product_id).filter(Boolean))]);
  const names = new Map(products.filter(Boolean).map(product => [product.id, product.name]));
  const linesBySale = new Map();
  for (const line of lines) {
    linesBySale.set(line.sale_id, [...(linesBySale.get(line.sale_id) || []), { ...line, name: line.product_name || line.name || names.get(line.product_id) || 'Item' }]);
  }

  const headers = await db.tabs.bulkGet([...new Set(pending.map(sale => sale.tab_id).filter(Boolean))]);
  const byId = new Map(headers.filter(Boolean).map(tab => [tab.id, tab]));
  const openIds = new Set(tabs.map(tab => tab.id));
  const rounds = sales
    .filter((sale) => !sale.proforma_id && (!branchId || sale.branch_id === branchId))
    .map((sale) => ({
      ...saleAsOrder(sale, { payments: ledger.get(sale.id), lines: linesBySale.get(sale.id) || [] }),
      tabId: sale.tab_id || `recovered-${sale.id}`,
    }));
  for (const sale of pending) {
    const round = rounds.find(row => row.id === sale.id);
    const header = byId.get(sale.tab_id);
    // CLOSED means an explicit walk-out/write-off, which must stay closed.
    if (!round || round.paymentStatus !== 'unpaid' || openIds.has(round.tabId)
      || (header && header.status !== 'SETTLED')) continue;
    tabs.push({
      id: round.tabId, status: OPEN, branch_id: sale.branch_id,
      table_no: sale.table_no, opened_at: header?.opened_at || sale.sold_at,
      order_no: sale.order_reference || header?.order_no || sale.invoice_no || sale.id, opened_by: sale.staff_id || sale.created_by,
      readOnly: true, recoveryRequired: true,
    });
    openIds.add(round.tabId);
  }
  // What only this device knows about: unpaid rounds the server has not got yet.
  const unsynced = new Set(sales.filter(sale => !sale.synced_at).map(sale => sale.id));
  return tabsWithTotals(tabs, rounds).map(tab => ({ ...tab,
    pendingUploadMinor: tab.unpaidRounds.filter(round => unsynced.has(round.id))
      .reduce((sum, round) => sum + (Number(round.dueMinor) || 0), 0) }));
  });
}

/**
 * Frees a table once nothing on its tab is owed.
 *
 * A tab is how a table is held: while one is OPEN the table reads as occupied
 * and the next round joins that bill. Paying the last round therefore has to
 * close it, or the table stays taken after the customers have left and the
 * shift cannot be closed either.
 *
 * Lives here rather than on a screen because two of them settle tabs - the
 * till and the Orders Viewer - and only the till was freeing the table.
 *
 * Returns the table it freed, or null when the tab is not ready to close.
 */
export async function freeSettledTab(tabId) {
  if (!tabId) return null;
  return db.transaction('rw', [db.tabs, db.sales, db.payments, db.sale_lines], async () => {
  const tab = await db.tabs.get(tabId);
  if (!tab || tab.status !== OPEN) return null;

  // Every round on the table, not only the ones just settled: a tab with one
  // round still owing stays open for whoever settles it.
  const rounds = await billableCheckoutRounds(await db.sales.where('tab_id').equals(tabId).toArray(), db);
  const ledger = await db.payments.where('sale_id').anyOf(rounds.map(sale => sale.id)).toArray();
  const bySale = new Map();
  for (const row of ledger) {
    bySale.set(row.sale_id, [...(bySale.get(row.sale_id) || []), row]);
  }
  if (tabOwes(rounds, bySale, saleAsOrder)) return null;

  await db.tabs.update(tabId, closingUpdate({
    dueMinor: 0,
    staffId: state.currentUser?.id,
    now: new Date().toISOString(),
  }));
  return tab.table_no || null;
  });
}
