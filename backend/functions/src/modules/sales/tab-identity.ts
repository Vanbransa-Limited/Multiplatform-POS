import type { DocumentData, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import type { ParsedSaleInput } from "./types";

/** Serialize competing tills and reuse the table's unpaid bill, including legacy sales. */
export async function resolveSharedTab(transaction: Transaction, input: ParsedSaleInput) {
  if (!input.tableNumber || !input.tabId
    || !input.payments.some(payment => payment.method === "credit" && payment.amountMinor > 0)) return null;
  const tableKey = input.tableNumber.trim().toLowerCase().replace(/\s+/g, " ").replace(/^table\s*/, "");
  const ref = db.collection("table_sessions").doc(deterministicId("table", `${input.tenantId}:${input.branchId}:${tableKey}`));
  const lock = await transaction.get(ref);
  const names = [...new Set([input.tableNumber, tableKey, tableKey.toUpperCase(),
    `Table ${tableKey}`, `TABLE ${tableKey.toUpperCase()}`, lock.data()?.tableNumber].filter(Boolean))];
  const snapshots = await Promise.all(names.map(name => transaction.get(db.collection("sales")
    .where("tenantId", "==", input.tenantId).where("tableNumber", "==", name))));
  const sales = [...new Map(snapshots.flatMap(snapshot => snapshot.docs).map(doc => [doc.id, doc])).values()]
    .filter(doc => doc.data().branchId === input.branchId && doc.data().tabId
      && String(doc.data().status).toUpperCase() !== "VOIDED" && !doc.data().proformaId);
  const active = new Map<string, DocumentData>();
  for (const doc of sales) {
    const ledger = await transaction.get(db.collection("payments").where("saleId", "==", doc.id));
    if (ledger.docs.some(payment => {
      const row = payment.data();
      return row.tenantId === input.tenantId && row.method === "credit" && !row.settledAt
        && String(row.status).toLowerCase() !== "voided" && Number(row.amountMinor) > 0;
    })) {
      if (Number(doc.data().checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
        throw new HttpsError("failed-precondition", "This table is being paid. Finish checkout before adding another round.");
      }
      active.set(doc.data().tabId, doc.data());
    }
  }
  if (active.size > 1) throw new HttpsError("failed-precondition", "This table has multiple unpaid bills. Consolidate them before adding another round.");
  const existing = [...active.values()][0];
  return { ref, data: {
    tenantId: input.tenantId, branchId: input.branchId, tableKey,
    tableNumber: existing?.tableNumber || input.tableNumber,
    tabId: existing?.tabId || input.tabId,
    orderReference: existing?.orderReference || existing?.invoiceNumber || input.orderReference || null,
  } };
}
