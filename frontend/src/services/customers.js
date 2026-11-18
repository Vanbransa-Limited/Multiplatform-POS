import { getFirebase, currentClaims, callFunction } from './firebase';
import { db } from '../db/schema';

/**
 * The customer directory.
 *
 * A customer used to be written to this device's Dexie and nowhere else, so
 * createSale - which refuses any sale whose customer is not an active document
 * on the server - rejected every sale booked against one. The invoice printed,
 * the sale never synced, and no till but this one had ever heard of them.
 *
 * The server is now the register. Dexie is a read cache of it, plus the two
 * counters only this till keeps.
 */

/**
 * Firestore's customer document -> the row shape the till and CRM read.
 *
 * A field the server did not send keeps what is already here: saveCustomer
 * answers with the fields it was given, so a quick add at the till would
 * otherwise blank a KRA PIN the office had entered.
 */
function toLocalRow(id, data, existing = null) {
  const kept = (value, fallback) => (value === undefined ? fallback : value);
  return {
    id,
    tenant_id: data.tenantId,
    name: data.name || existing?.name || 'Guest',
    phone: kept(data.phone, existing?.phone ?? ''),
    kra_pin: kept(data.kraPin, existing?.kra_pin ?? ''),
    price_tier: kept(data.priceTier, existing?.price_tier ?? 'RETAIL'),
    credit_limit: data.creditLimitMinor === undefined
      ? (existing?.credit_limit ?? 0)
      : Number(data.creditLimitMinor) / 100,
    // Loyalty and the running tab are tallied by the till as it sells and the
    // server holds no opinion on them, so a refresh must not zero them.
    credit_balance: existing?.credit_balance || 0,
    loyalty_points: existing?.loyalty_points || 0,
  };
}

export async function pullCustomers() {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) return 0;

  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'customers'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
  ));

  const active = snapshot.docs.filter(doc => doc.data().isActive !== false);
  // One IndexedDB request, rather than one transaction per customer.
  const existing = await db.customers.bulkGet(active.map(doc => doc.id));
  const rows = active.map((doc, index) => toLocalRow(doc.id, doc.data(), existing[index]));

  if (rows.length) await db.customers.bulkPut(rows);
  return rows.length;
}

/**
 * Registers or updates a customer, server first.
 *
 * Only the fields you pass are written, so adding somebody at the till by name
 * and phone leaves whatever the office set on them alone.
 */
/**
 * Retires a customer, owner only.
 *
 * The server keeps the document - sales point at it - and refuses while they
 * still owe. Here it just leaves the directory.
 */
export async function deleteCustomer(customerId) {
  const result = await callFunction('deleteCustomer', { customerId });
  await db.customers.delete(customerId);
  return result;
}

export async function saveCustomer(input) {
  const saved = await callFunction('saveCustomer', input);
  const row = toLocalRow(saved.id, saved, await db.customers.get(saved.id));
  await db.customers.put(row);
  return row;
}
