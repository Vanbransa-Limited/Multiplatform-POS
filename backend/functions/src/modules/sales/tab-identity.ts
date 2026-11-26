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

const owesCredit = (row: DocumentData, tenantId: string) => row.tenantId === tenantId && row.method === "credit"
  && !row.settledAt && String(row.status).toLowerCase() !== "voided" && Number(row.amountMinor) > 0;

/** Every sale ever rung at this table in this branch, under any spelling of its name. */
async function tableSales(transaction: Transaction, tenantId: string, branchId: string, tableNumber: string, lock?: DocumentData) {
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
  if (Number(bill.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
    throw new HttpsError("failed-precondition", "That bill is being paid. Finish checkout before adding items.");
  }
  const ledger = await transaction.get(db.collection("payments").where("saleId", "==", doc.id));
  if (!ledger.docs.some(payment => owesCredit(payment.data(), input.tenantId))) {
    throw new HttpsError("failed-precondition", "That bill is already paid. Ring the items as a new bill.");
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
  if (!input.tableNumber || !input.tabId
    || !input.payments.some(payment => payment.method === "credit" && payment.amountMinor > 0)) return null;
  const ref = tableSessionRef(input.tenantId, input.branchId, input.tableNumber);
  const lock = await transaction.get(ref);
  const all = await tableSales(transaction, input.tenantId, input.branchId, input.tableNumber, lock.data());
  const sales = all.filter(doc => doc.data().tabId && String(doc.data().status).toUpperCase() !== "VOIDED");
  const active = new Map<string, DocumentData>();
  for (const doc of sales) {
    const ledger = await transaction.get(db.collection("payments").where("saleId", "==", doc.id));
    if (ledger.docs.some(payment => owesCredit(payment.data(), input.tenantId))) {
      if (Number(doc.data().checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
        throw new HttpsError("failed-precondition", "This table is being paid. Finish checkout before adding another round.");
      }
      active.set(doc.data().tabId, doc.data());
    }
  }
  if (active.size > 1) throw new HttpsError("failed-precondition", "This table has multiple unpaid bills. Consolidate them before adding another round.");
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
      .filter(doc => doc.data().tabId && String(doc.data().status).toUpperCase() !== "VOIDED");
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
