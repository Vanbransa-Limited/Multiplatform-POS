import { db } from '../db/schema';
import { state } from '../context';
import { callFunction } from './firebase';

export const BUYER_PIN = /^[AP]\d{9}[A-Z]$/;

/** The id the server knows a sale by. Sales pulled from the server keep the server id as their own. */
async function serverSaleId(saleId) {
  let sale = await db.sales.get(saleId);
  if (sale && !sale.server_sale_id && !sale.synced_at) sale = await state.syncManager.publishSale(saleId);
  return sale?.server_sale_id || (sale?.synced_at ? sale.id : null);
}

/** The ETR already issued for a sale on this till, or null. */
export async function etrFor(saleId) {
  return (await db.fiscal_records.get(`etr-${saleId}`))?.etr || null;
}

/**
 * Has KRA sign a paid bill and keeps the result for reprints.
 * A table's bill is every round it settled; they go to KRA as one invoice.
 */
export async function generateEtr(saleIds, buyerPin) {
  const pin = (buyerPin || '').trim().toUpperCase();
  if (pin && !BUYER_PIN.test(pin)) throw new Error('The buyer KRA PIN looks wrong. It is 11 characters, e.g. P051234567A.');
  const serverIds = [];
  for (const id of saleIds) {
    const serverId = await serverSaleId(id);
    if (!serverId) throw new Error('This bill has not reached the server yet. Reconnect, then try again.');
    serverIds.push(serverId);
  }
  const etr = await callFunction('generateEtr', { saleIds: serverIds, ...(pin ? { buyerPin: pin } : {}) });
  const now = new Date().toISOString();
  await db.fiscal_records.bulkPut(saleIds.map((id) => ({
    id: `etr-${id}`,
    sale_id: id,
    cu_invoice_no: `${etr.sdcId}/${etr.curRcptNo}`,
    receipt_signature: etr.rcptSign,
    result_code: 'ETR',
    etr,
    submitted_at: now,
    confirmed_at: now,
  })));
  return etr;
}
