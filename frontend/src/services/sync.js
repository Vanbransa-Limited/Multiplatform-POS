import { db } from '../db/schema';
import { callFunction, firebaseConfigured, hasTenantSession, TENANT_ID, DEVICE_ID, WALK_IN_CUSTOMER_ID } from './firebase';
import { state, showNotification } from '../context';
import { pullStock } from './stock';
import { isReceivable } from './takings';
import { mapPaymentMethod, staffDiscountAsLineDiscounts, toMinor } from './tender';
import { publishOpenOrders } from './open-orders';
import { readWithDeadline } from './read-deadline.js';
import { isNonBillableAdjustment, missingReceivable } from './checkout-rounds.js';

/**
 * A sale the server is still owed.
 *
 * An order awaiting payment transmits like any other: it is a real order that
 * moved real stock, and holding it on one device is what stopped an owner
 * seeing it and stopped anyone settling it from another till. It goes up as
 * the receivable it is, and `settleSale` clears it when the money arrives.
 *
 * A voided order is the exception. If it never reached the server there is
 * nothing to withdraw, so it simply never goes; one that did reach the server
 * is withdrawn by `voidSale` rather than by this queue.
 */
// A sale the server refused (bad payment reference, revoked staff) is retried hourly, not every 10 s tick
const REFUSED_SALE_RETRY_MS = 60 * 60 * 1000;

export function awaitingTransmission(sale, now = Date.now()) {
  if (sale.sync_omitted === 'adjustment_only') return false;
  if (sale.synced_at !== undefined && sale.synced_at !== null) return false;
  if (sale.status === 'VOIDED') return false;
  if (sale.server_pending) return true;
  // Table rounds are shared receivables. Payment on any device must address
  // the same server sale rather than recording a second local tender.
  if (sale.tab_id && sale.status === 'PENDING_PAYMENT') return true;
  // Legacy drafts retain their lease. Explicit Pay Now orders bypass it above
  // and settle through settleSale once the server acknowledges the order.
  return !(sale.held_until && new Date(sale.held_until).getTime() > now);
}


export class SyncManager {
  /** Publish a checkout order before asking the customer to pay for it. */
  async publishSale(saleId) {
    const sale = await db.sales.get(saleId);
    if (!sale) throw new Error('Pending order not found.');
    if (sale.synced_at) return sale;
    if (!firebaseConfigured || this.connectionStatus === 'OFFLINE' || !(await hasTenantSession())) {
      throw new Error('This order is saved on this till only. Reconnect to save it to Pending on the server before taking payment.');
    }
    if (!(await this.transmitSale(sale))) {
      const current = await db.sales.get(saleId);
      if (current?.sync_omitted === 'adjustment_only') return current;
      throw new Error(current?.sync_error_msg || 'The pending order has not reached the server. Retry before taking payment.');
    }
    return db.sales.get(saleId);
  }

  constructor() {
    this.isSyncing = false;
    this.connectionStatus = 'ONLINE'; // 'ONLINE' or 'OFFLINE'
    this.onStatusChange = null; // Callback for UI state binding
    this.schedulerId = null;
  }

  setConnectionStatus(status) {
    if (this.connectionStatus !== status) {
      this.connectionStatus = status;
      if (this.onStatusChange) {
        this.onStatusChange(this.connectionStatus, 0);
      }
    }
  }

  /**
   * Builds the createSale payload for a locally recorded sale.
   * Returns null when the sale is missing something the backend requires, so
   * the row stays queued rather than being rejected in a loop.
   */
  async buildSalePayload(sale) {
    // Why a payload could not be built, so the till can say more than "incomplete".
    const incomplete = (reason) => { this.incompleteReason = reason; return null; };
    const lines = await db.sale_lines.where('sale_id').equals(sale.id).toArray();
    let payments = await db.payments.where('sale_id').equals(sale.id).toArray();
    if (lines.length === 0) return incomplete('it has no items');
    if (isNonBillableAdjustment(sale, lines, payments)) {
      return null;
    }
    const receivable = missingReceivable(sale, payments);
    if (receivable) {
      await db.payments.put(receivable);
      payments = [...payments, receivable];
    }
    if (payments.length === 0) return incomplete('it has no payment or amount owed');

    // A receivable cleared before the sale ever reached the server transmits
    // as the tender that actually paid. Sending the receivable as well would
    // hand createSale two rows for one cart and double the sale's total.
    const tendered = payments.filter((p) => !(isReceivable(p.method) && p.settled_at));
    if (tendered.length === 0) return incomplete('its only payment row was already settled');

    const mappedPayments = [];
    for (const p of tendered) {
      const method = mapPaymentMethod(p.method);
      if (!method) return incomplete(`unknown payment method ${p.method}`); // needs a human, not a retry
      const amountMinor = toMinor(p.amount);
      // A zero is not money. One of these on an invoice made the server refuse
      // the whole sale - "amountMinor must be a positive safe integer" - which
      // stranded every real tender beside it on the till that took them.
      if (amountMinor <= 0) continue;
      mappedPayments.push({
        method,
        amountMinor,
        reference: p.reference || undefined,
        ...(p.metadata?.typedCode ? { unverified: true } : {})
      });
    }
    if (mappedPayments.length === 0) return incomplete('its payments are all zero');

    // Every anonymous sale is booked to the walk-in, so a blank one is the walk-in.
    const customerId = sale.customer_id || WALK_IN_CUSTOMER_ID;
    if (!customerId) return incomplete('it has no customer');
    if (!sale.shift_id) return incomplete('it has no shift');
    if (!sale.device_id) return incomplete('it has no device');

    // Sales registered at Pay Now were written without a staff id, so every one
    // of them was refused by createSale and queued forever. New ones carry it;
    // these recover it from the shift that rang them, which is the same person
    // by definition - otherwise they would need re-keying by hand.
    const staffId = sale.created_by || sale.staff_id
      || (await db.shifts.get(sale.shift_id))?.user_id
      || null;
    if (!staffId) return incomplete('nobody is recorded as selling it');

    const sellable = staffDiscountAsLineDiscounts(lines, sale);
    if (sellable.length === 0) return incomplete('it only holds a discount line');
    const tab = sale.tab_id ? await db.tabs.get(sale.tab_id) : null;

    return {
      tenantId: sale.tenant_id || TENANT_ID,
      branchId: sale.branch_id,
      deviceId: sale.device_id,
      shiftId: sale.shift_id,
      staffId,
      customerId,
      idempotencyKey: sale.sale_uuid,
      tableNumber: sale.table_no || undefined,
      ...(sale.tab_id ? { tabId: sale.tab_id, orderReference: tab?.order_no || sale.order_reference || sale.invoice_no } : {}),
      buyerKraPin: sale.buyer_pin || undefined,
      ...(sale.discount_approval_id ? { discountApprovalId: sale.discount_approval_id } : {}),
      ...(sale.join_sale_uuid && !sale.tab_id ? { joinSaleUuid: sale.join_sale_uuid } : {}),
      lines: sellable,
      payments: mappedPayments
    };
  }

  /**
   * Drains locally queued sales to the trusted backend.
   *
   * A sale is only marked synced when the server confirms it. Anything else
   * leaves the row queued and visible in the sidebar counter - the till never
   * claims a sale reached KRA when it did not.
   */
  async syncOutbox() {
    if (this.isSyncing) return;
    if (this.connectionStatus === 'OFFLINE') return;

    this.isSyncing = true;

    try {
      const unsyncedSales = await db.sales.where('sync_pending').equals(1).filter(awaitingTransmission).toArray();

      if (this.onStatusChange) {
        this.onStatusChange(this.connectionStatus, unsyncedSales.length);
      }
      // No backend reachable: hold the queue. This is the normal state on a
      // till that has not been enrolled yet, so it is not an error.
      const canTransmit = firebaseConfigured && await hasTenantSession();
      if (!canTransmit) return;

      // Paid orders must reach the server before advisory floor/history reads.
      // A stalled snapshot used to hold the entire sales queue behind it.
      let transmitted = false;
      for (const sale of unsyncedSales) {
        if (this.connectionStatus === 'OFFLINE') break;
        // A refused sale still counts as unsynced, but resending it every tick only buys the same refusal
        // The staff-claim refusal was fixed server-side (any colleague may relay), so those retry now.
        if (sale.sync_retry_after && Date.parse(sale.sync_retry_after) > Date.now()
          && !/staff claim does not match/.test(sale.sync_error_msg || '')) continue;
        if (await this.transmitSale(sale)) transmitted = true;
      }

      // The House is decremented by createSale, not by the till, and the till
      // only ever reads a local copy of those balances. Refreshing it here -
      // after the sale actually landed - is the only moment the copy can be
      // right: the old refresh ran beside this drain and always read the
      // balances back before the server had moved them, so a sold item sat at
      // its pre-sale figure until some other screen happened to pull again.
      if (transmitted) await readWithDeadline(pullStock, 8000).catch(() => {});
      // Reconcile before publishing, but a slow read must not hold the next
      // queue drain indefinitely. This never times out a payment/sale write.
      if (firebaseConfigured) await readWithDeadline(() => this.refreshSharedOrders(), 8000).catch(() => {});
      // Again after the drain: settling a tab is exactly what has to stop it
      // showing as open on every other screen.
      await this.publishOpenTabs();
    } catch (err) {
      console.error('Error during synchronization outbox:', err);
    } finally {
      this.isSyncing = false;
      const remaining = await db.sales.where('sync_pending').equals(1).filter(awaitingTransmission).count();
      if (this.onStatusChange) {
        this.onStatusChange(this.connectionStatus, remaining);
      }
    }
  }

  /**
   * Gets held orders to the server before the cloud session ends. Signing out
   * cut the session first, so an order rung just before an idle sign-out sat
   * on the tablet, invisible everywhere else, until someone signed in again.
   * Bounded: a dead network must not hold the session open for ever.
   */
  async drainBeforeSignOut(limitMs = 20_000) {
    const until = Date.now() + limitMs;
    while (this.isSyncing && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
    if (Date.now() < until) await readWithDeadline(() => this.syncOutbox(), until - Date.now()).catch(() => {});
  }

  /**
   * Shares this device's open tabs so the rest of the business can see the
   * floor while it is running.
   *
   * Watching is never worth failing a sync over, so this swallows its own
   * errors: the outbox drain above is the part that must not be disturbed.
   */
  async publishOpenTabs() {
    try {
      const device = state.currentBranch?.id ? null : (await db.devices.toArray())[0];
      // Firebase-mode boot does not seed devices. The enrolled build ID is
      // already what createSale/openShift use; a missing cache row must not
      // silently disable the only shared copy of unpaid tables.
      const branchId = state.currentBranch?.id || device?.branch_id;
      if (!branchId) throw new Error('No branch available for open-order publishing.');
      await publishOpenOrders({ branchId, deviceId: DEVICE_ID || device?.id });
      this.openOrderPublishError = null;
    } catch (error) {
      const message = error?.message || String(error);
      if (this.openOrderPublishError !== message) {
        console.error('Open-order publishing failed', error);
        showNotification('Open tables have not reached the server. Keep this browser open and its data intact.', 'warning');
      }
      this.openOrderPublishError = message;
    }
  }

  /** Pull only the acknowledged rounds belonging to this device's open tabs. */
  async refreshSharedOrders() {
    const tabs = await db.tabs.where('status').equals('OPEN').toArray();
    if (!tabs.length) return;
    const rounds = await db.sales.where('tab_id').anyOf(tabs.map(tab => tab.id)).toArray();
    const uuids = rounds.filter(row => row.synced_at && row.sale_uuid).map(row => row.sale_uuid);
    if (!uuids.length) return;
    const { pullSales } = await import('./catalogue');
    const { freeSettledTab } = await import('./tab-edit');
    await pullSales(undefined, uuids);
    for (const tab of tabs) await freeSettledTab(tab.id);
  }

  /** Returns true when the sale reached the backend, which is what moved stock. */
  async transmitSale(sale) {
    if (firebaseConfigured && sale.tab_id && !sale.synced_at) {
      // Freeze this round before reading its payload. An item removal and an
      // upload must not commit different bills under the same sale UUID.
      await db.sales.update(sale.id, { sharing_pending: 1 });
      sale = await db.sales.get(sale.id);
    }
    const payload = await this.buildSalePayload(sale);
    if (!payload) {
      // Publishing a round and draining the queue can overlap. Classify this
      // sale's own rows instead of using mutable state shared by both calls.
      const [lines, payments] = await Promise.all([
        db.sale_lines.where('sale_id').equals(sale.id).toArray(),
        db.payments.where('sale_id').equals(sale.id).toArray(),
      ]);
      if (isNonBillableAdjustment(sale, lines, payments)) {
        await db.sales.update(sale.id, { sync_pending: 0, sync_omitted: 'adjustment_only',
          sharing_pending: 0, sync_error_msg: null, fiscal_status: 'NOT_APPLICABLE' });
        return false;
      }
      await db.sales.update(sale.id, {
        fiscal_status: 'NEEDS_REVIEW',
        sync_error_msg: `Sale is incomplete and cannot be submitted automatically: ${this.incompleteReason || 'unknown reason'}.`
      });
      return false;
    }

    try {
      const result = await callFunction('createSale', payload);
      await db.sales.update(sale.id, {
        synced_at: new Date().toISOString(),
        // KRA signs a bill only when an ETR is generated for it (services/etr.js).
        fiscal_status: (result && result.sale && result.sale.fiscalStatus) || 'PENDING',
        server_sale_id: result && result.sale ? result.sale.id : null,
        server_invoice_no: result && result.sale ? result.sale.invoiceNumber : null,
        sync_error_msg: null
      });
      return true;
    } catch (err) {
      const permanent = err && typeof err.code === 'string'
        && /invalid-argument|permission-denied|failed-precondition/.test(err.code);
      await db.sales.update(sale.id, {
        fiscal_status: permanent ? 'TERMINAL_ERROR' : 'QUEUED',
        sync_error_msg: (err && err.message) || String(err),
        sync_retry_after: permanent ? new Date(Date.now() + REFUSED_SALE_RETRY_MS).toISOString() : null
      });
      if (!permanent) throw err; // stop the run; retry on the next tick
      return false;
    }
  }

  startSyncScheduler() {
    if (this.schedulerId) return;
    let ticks = 0;
    this.schedulerId = setInterval(() => {
      this.syncOutbox().catch(() => {});
      // Prices were read only at page load, so a tablet left open all day kept
      // ringing yesterday's menu. Five minutes keeps it close at little cost.
      if (++ticks % 30 === 0) void this.refreshCatalogue();
    }, 10000);
  }

  async refreshCatalogue() {
    if (this.connectionStatus === 'OFFLINE') return;
    try {
      const { pullCatalogue } = await import('./catalogue.js');
      if (await pullCatalogue()) window.dispatchEvent(new Event('pos:catalogue-updated'));
    } catch { /* the last known menu stays in use */ }
  }

  stopSyncScheduler() {
    if (this.schedulerId) clearInterval(this.schedulerId);
    this.schedulerId = null;
  }
}
