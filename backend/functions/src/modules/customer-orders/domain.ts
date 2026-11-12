import { HttpsError } from 'firebase-functions/v2/https';
import { SELLING_ROLES } from '../sales/constants';
import { asRecord, documentId, minorUnits, optionalText } from '../../shared/validation';

/** Staff who may see and act on a table's order. */
export function serviceStaff(token: Record<string, unknown> | undefined) {
  if (!token?.tenant_id || !token.staff_id || !SELLING_ROLES.has(String(token.staff_role))) {
    throw new HttpsError('permission-denied', 'Sign in as service staff.');
  }
  return { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
}

export function parseCustomerOrder(value: unknown) {
  const input = asRecord(value);
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 50) {
    throw new HttpsError('invalid-argument', 'Choose between 1 and 50 items.');
  }
  const seen = new Set<string>();
  const lines = input.lines.map((value) => {
    const line = asRecord(value, 'item');
    const productId = documentId(line.productId, 'productId');
    if (seen.has(productId)) throw new HttpsError('invalid-argument', 'Combine repeated items.');
    seen.add(productId);
    if (!Number.isInteger(line.qty) || Number(line.qty) < 1 || Number(line.qty) > 99) {
      throw new HttpsError('invalid-argument', 'Quantity must be between 1 and 99.');
    }
    return { productId, qty: Number(line.qty), unitPriceMinor: minorUnits(line.unitPriceMinor, 'unitPriceMinor') };
  });
  // A takeaway has no table to serve, so its table number is dropped rather than
  // carried onto the kitchen ticket where it would send a runner to a full table.
  const orderType = input.orderType === 'takeaway' ? 'takeaway' : 'dine_in';
  const tableNumber = orderType === 'takeaway' ? null : optionalText(input.tableNumber, 'table', 30);
  if (orderType === 'dine_in' && !tableNumber) throw new HttpsError('invalid-argument', 'Enter the table number, or choose takeaway.');
  return {
    tenantId: documentId(input.tenantId, 'tenantId'),
    branchId: documentId(input.branchId, 'branchId'),
    requestId: documentId(input.requestId, 'requestId'),
    customerName: optionalText(input.customerName, 'name', 100) || 'Guest',
    orderType,
    tableNumber,
    note: optionalText(input.note, 'instructions', 500),
    lines,
  };
}

export function publicProduct(id: string, data: Record<string, unknown>) {
  if (data.isActive !== true || !Number.isSafeInteger(data.sellPriceMinor) || Number(data.sellPriceMinor) <= 0) return null;
  // Store-only stock is sold at the till but never advertised. Absent means
  // shown: every product predates this flag and must keep its place.
  if (data.showOnMenu === false) return null;
  return {
    id, name: String(data.name || data.sku || id),
    categoryId: String(data.categoryId || ''), uom: String(data.uom || 'EACH'),
    sellPriceMinor: Number(data.sellPriceMinor),
    // Only a product the business marked as counted is held to its balance. A
    // cocktail or a made-to-order plate has no meaningful count, and hiding one
    // because nobody keyed a number in would empty the menu.
    trackStock: data.trackStock === true,
    imagePath: typeof data.imagePath === 'string' && /^(https:\/\/|\/(?!\/))/.test(data.imagePath) ? data.imagePath : null,
  };
}

/** House stock is what service can actually reach, so it is what availability means. */
export const houseBalanceId = (branchId: string, productId: string) => `${branchId}_${productId}_HOUSE`;

export function priceCustomerOrder(input: ReturnType<typeof parseCustomerOrder>, products: Map<string, Record<string, unknown>>) {
  return input.lines.map((line) => {
    const data = products.get(line.productId);
    const product = data && data.tenantId === input.tenantId ? publicProduct(line.productId, data) : null;
    if (!product) throw new HttpsError('failed-precondition', 'An item is no longer available. Refresh the menu.');
    if (line.unitPriceMinor !== product.sellPriceMinor) {
      throw new HttpsError('failed-precondition', `${product.name} has a new price. Refresh the menu and review your order.`);
    }
    return { productId: product.id, name: product.name, qty: line.qty, unitPriceMinor: product.sellPriceMinor, totalMinor: product.sellPriceMinor * line.qty };
  });
}
