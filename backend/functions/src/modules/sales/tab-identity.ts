import { Timestamp, type DocumentData, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import type { ParsedSaleInput } from "./types";

export const tableKey = (tableNumber: string) =>
  tableNumber.trim().toLowerCase().replace(/\s+/g, " ").replace(/^table\s*/, "");

export const tableSessionRef = (tenantId: string, branchId: string, tableNumber: string) =>
  db.collection("table_sessions").doc(deterministicId("table", `${tenantId}:${branchId}:${tableKey(tableNumber)}`));

export const owesCredit = (row: DocumentData, tenantId: string) => row.tenantId === tenantId && row.method === "credit"
  && !row.settledAt && String(row.status).toLowerCase() !== "voided" && Number(row.amountMinor) > 0;

/**
 * A released bill is still owed and payable, but no longer holds its table:
 * the next customer there gets a tab of their own (releaseTable, 27 Nov 2026).
 */
export const isReleased = (sale: DocumentData | undefined) => Boolean(sale?.tableRelease);

/**
 * A round that names a released tab. It is refused rather than joined to the
 * next customer's bill or added to the released one: the device that rang it
 * holds it for staff to review (sync.js), with these details.
 */
function releasedTabRefused(sale: DocumentData, input: ParsedSaleInput) {
  const release = sale.tableRelease as { releasedAt?: Timestamp; releaseId?: string } | undefined;
  const releasedAt = release?.releasedAt?.toDate?.().toISOString() ?? null;
  logger.warn("round for a released tab held for review", { tenantId: input.tenantId, branchId: input.branchId,
    idempotencyKey: input.idempotencyKey, tabId: input.tabId, releaseId: release?.releaseId ?? null });
  return new HttpsError("failed-precondition",
    `Table ${sale.tableNumber} was released${releasedAt ? ` at ${releasedAt}` : ""}. This round was not added to any bill; it is held on this till for review.`,
    { reason: "table-released", tabId: input.tabId, tableNumber: sale.tableNumber ?? null,
      orderReference: sale.orderReference || sale.invoiceNumber || null, releaseId: release?.releaseId ?? null, releasedAt });
}

/** Every sale ever rung at this table in this branch, under any spelling of its name. */
export async function tableSales(transaction: Transaction, tenantId: string, branchId: string, tableNumber: string, lock?: DocumentData) {
  const key = tableKey(tableNumber);
  const names = [...new Set([tableNumber, key, key.toUpperCase(), `Table ${key}`, `TABLE ${key.toUpperCase()}`,
    lock?.tableNumber].filter(Boolean))];
  const snapshots = await Promise.all(names.map(name => transaction.get(db.collection("sales")
    .where("tenantId", "==", tenantId).where("tableNumber", "==", name))));
  return [...new Map(snapshots.flatMap(snapshot => snapshot.docs).map(doc => [doc.id, doc])).values()]
    .filter(doc => doc.data().branchId === branchId && !doc.data().proformaId);
}

type SharedTab = {
  ref: FirebaseFirestore.DocumentReference | null;
  data: { tabId: string; orderReference: string | null; tableNumber: string | null } & Record<string, unknown>;
  join?: { ref: FirebaseFirestore.DocumentReference; update: Record<string, unknown> };
};

/**
 * Add items to an unpaid bill: the round joins that bill's tab, so one payment
 * settles both. Staff rang a second bill instead (003457 + 003463, 25 Nov 2026).
 */
async function joinUnpaidBill(transaction: Transaction, input: ParsedSaleInput): Promise<SharedTab> {
  if (!input.payments.some(payment => payment.method === "credit" && payment.amountMinor > 0)) {
    throw new HttpsError("failed-precondition", "Save the added items unpaid; pay the bill once from Orders.");
  }
  const ref = db.collection("sales").doc(deterministicId("sale", `${input.tenantId}:${input.joinSaleUuid}`));
  const doc = await transaction.get(ref);
  const bill = doc.data();
  if (!doc.exists || bill?.tenantId !== input.tenantId || bill.branchId !== input.branchId) {
    throw new HttpsError("not-found", "That bill is not in this branch.");
  }
  if (String(bill.status).toUpperCase() === "VOIDED" || bill.proformaId) {
    throw new HttpsError("failed-precondition", "That bill was voided or belongs to a proforma; ring a new one.");
  }
  if (bill.customerId && input.customerId !== bill.customerId) {
    throw new HttpsError("failed-precondition", "This bill belongs to another customer. Select that customer before adding items.");
  }
  if (Number(bill.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
    throw new HttpsError("failed-precondition", "That bill is being paid. Finish checkout before adding items.");
  }
  const ledger = await transaction.get(db.collection("payments").where("saleId", "==", doc.id));
  if (!ledger.docs.some(payment => owesCredit(payment.data(), input.tenantId))) {
    throw new HttpsError("failed-precondition", "That bill is already paid. Ring the items as a new bill.");
  }
  if (isReleased(bill)) {
    // Its table went to the next customer: the items stay on this bill alone.
    return { ref: null, data: { tabId: String(bill.tabId), orderReference: bill.orderReference || bill.invoiceNumber || null,
      tableNumber: bill.tableNumber ? String(bill.tableNumber) : null, tableRelease: bill.tableRelease } };
  }
  if (bill.tableNumber) {
    const { joinSaleUuid: _join, ...rest } = input;
    const tab = await resolveSharedTab(transaction, { ...rest, tableNumber: String(bill.tableNumber),
      tabId: bill.tabId || deterministicId("tab", doc.id), orderReference: bill.orderReference || bill.invoiceNumber });
    return tab!;
  }
  const tabId = String(bill.tabId || deterministicId("tab", doc.id));
  const orderReference = bill.orderReference || bill.invoiceNumber || null;
  return { ref: null, data: { tabId, orderReference, tableNumber: null },
    ...(bill.tabId ? {} : { join: { ref, update: { tabId, orderReference, updatedAt: Timestamp.now() } } }) };
}

/** Serialize competing tills and reuse the table's unpaid bill, including legacy sales. */
export async function resolveSharedTab(transaction: Transaction, input: ParsedSaleInput): Promise<SharedTab | null> {
  if (input.joinSaleUuid) return joinUnpaidBill(transaction, input);
  const owing = input.payments.some(payment => payment.method === "credit" && payment.amountMinor > 0);
  // New rounds are always saved unpaid first (SAVE_FIRST), so every one naming a tab is checked here,
  // with or without a table: a released tab's round is held, never filed under it or the next customer's.
  if (input.tabId && owing) {
    const named = await transaction.get(db.collection("sales")
      .where("tenantId", "==", input.tenantId).where("tabId", "==", input.tabId));
    const released = named.docs.find(doc => doc.data().branchId === input.branchId && isReleased(doc.data()));
    if (released) throw releasedTabRefused(released.data(), input);
  }
  if (!input.tableNumber || !input.tabId || !owing) return null;
  const ref = tableSessionRef(input.tenantId, input.branchId, input.tableNumber);
  const lock = await transaction.get(ref);
  const all = await tableSales(transaction, input.tenantId, input.branchId, input.tableNumber, lock.data());
  const sales = all.filter(doc => doc.data().tabId && String(doc.data().status).toUpperCase() !== "VOIDED"
    && !isReleased(doc.data()));
  const active = new Map<string, DocumentData>();
  const customers = new Set<string>();
  for (const doc of sales) {
    const ledger = await transaction.get(db.collection("payments").where("saleId", "==", doc.id));
    if (ledger.docs.some(payment => owesCredit(payment.data(), input.tenantId))) {
      if (Number(doc.data().checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
        throw new HttpsError("failed-precondition", "This table is being paid. Finish checkout before adding another round.");
      }
      active.set(doc.data().tabId, doc.data());
      if (doc.data().customerId) customers.add(String(doc.data().customerId));
    }
  }
  if (active.size > 1) throw new HttpsError("failed-precondition", "This table has multiple unpaid bills. Consolidate them before adding another round.");
  if (customers.size && (customers.size !== 1 || !customers.has(input.customerId))) {
    throw new HttpsError("failed-precondition", "This table belongs to another customer account. Check the customer or choose a different table.");
  }
  const existing = [...active.values()][0];
  // A device that has not heard the table was paid still proposes the old tab.
  // That bill is closed: the next customer gets a tab of their own (26 Nov 2026).
  const stale = !existing && all.some(doc => doc.data().tabId === input.tabId);
  return { ref, data: {
    tenantId: input.tenantId, branchId: input.branchId, tableKey: tableKey(input.tableNumber),
    tableNumber: existing?.tableNumber || input.tableNumber,
    tabId: existing?.tabId || (stale ? deterministicId("tab", `${input.tenantId}:${input.idempotencyKey}`) : input.tabId),
    orderReference: existing?.orderReference || existing?.invoiceNumber || (stale ? null : input.orderReference) || null,
  } };
}

/**
 * The table's tab, recomputed from its bills: the one record every device reads
 * instead of deciding open/owed/paid from its own copy. Called after every write
 * that can change what a table owes; idempotent, so a missed call is repaired by
 * the next one. ponytail: recomputed per write, not a Firestore trigger; move to
 * an onDocumentWritten trigger on sales/payments if a writer is ever missed.
 */
export async function refreshTableSession(tenantId: string, branchId: string, tableNumber: string) {
  if (!tenantId || !branchId || !tableNumber || !tableKey(tableNumber)) return null;
  const ref = tableSessionRef(tenantId, branchId, tableNumber);
  return db.runTransaction(async (tx) => {
    const lock = await tx.get(ref);
    const sales = (await tableSales(tx, tenantId, branchId, tableNumber, lock.data()))
      .filter(doc => doc.data().tabId && String(doc.data().status).toUpperCase() !== "VOIDED" && !isReleased(doc.data()));
    const dueBySale = new Map<string, number>();
    for (let start = 0; start < sales.length; start += 30) {
      const ids = sales.slice(start, start + 30).map(doc => doc.id);
      const ledger = await tx.get(db.collection("payments").where("saleId", "in", ids));
      for (const payment of ledger.docs) {
        const row = payment.data();
        if (owesCredit(row, tenantId)) dueBySale.set(row.saleId, (dueBySale.get(row.saleId) || 0) + Number(row.amountMinor));
      }
    }
    const owing = sales.filter(doc => dueBySale.has(doc.id));
    const tabIds = [...new Set(owing.map(doc => String(doc.data().tabId)))];
    const head = owing.sort((a, b) => soldAt(a) - soldAt(b))[0]?.data();
    const session = {
      tenantId, branchId, tableKey: tableKey(tableNumber),
      tableNumber: head?.tableNumber || lock.data()?.tableNumber || tableNumber,
      status: owing.length ? "OPEN" : "SETTLED",
      tabId: head?.tabId || lock.data()?.tabId || null,
      orderReference: head?.orderReference || head?.invoiceNumber || lock.data()?.orderReference || null,
      dueMinor: owing.reduce((sum, doc) => sum + (dueBySale.get(doc.id) || 0), 0),
      roundSaleIds: sales.filter(doc => tabIds.includes(String(doc.data().tabId))).map(doc => doc.id),
      // More than one unpaid tab at a table needs consolidating; say so rather than hide one.
      splitTabIds: tabIds.length > 1 ? tabIds : [],
      openedAt: head?.soldAt || null,
      updatedAt: Timestamp.now(),
    };
    tx.set(ref, session, { merge: true });
    return session;
  });
}

const soldAt = (doc: DocumentSnapshot) => Number(doc.data()?.soldAt?.toMillis?.() || 0);

/** After a sale's money changed: refresh its table, never failing the committed write. */
export async function refreshTableSessionForSale(saleId: string) {
  try {
    const sale = (await db.collection("sales").doc(saleId).get()).data();
    if (sale?.tableNumber) await refreshTableSession(String(sale.tenantId), String(sale.branchId), String(sale.tableNumber));
  } catch (error) {
    logger.error("table session refresh failed", { saleId, error });
  }
}

/** Wraps a callable whose result names the sale it changed, then refreshes that sale's table. */
export function withTableRefresh<T>(handler: (request: CallableRequest) => Promise<T>) {
  return async (request: CallableRequest): Promise<T> => {
    const result = await handler(request);
    const saleId = (result as { saleId?: unknown }).saleId ?? (result as { sale?: { id?: unknown } }).sale?.id;
    if (typeof saleId === "string") await refreshTableSessionForSale(saleId);
    return result;
  };
}
