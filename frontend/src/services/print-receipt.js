/**
 * Receipt markup for the counter print station.
 *
 * Deliberately free of Firebase and DOM imports so the escaping rules are
 * executable in Node tests. The station renders jobs written by other devices,
 * so every value here is treated as untrusted text rather than markup: a
 * product or customer name must never become an element on the counter machine.
 */

const MONEY = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
};

/** Escapes the five characters that can end a text context in HTML. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Missing or malformed jobs render as nothing rather than as partial paper. */
export function isPrintableReceipt(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && typeof payload.invoiceNo === 'string'
    && payload.invoiceNo.length > 0
    && Array.isArray(payload.lines)
  );
}

export function renderReceiptHtml(payload) {
  if (!isPrintableReceipt(payload)) return '';

  const line = (item) => `
    <div class="receipt-item-details">
      <div class="receipt-item-row">
        <span>${escapeHtml(item?.name || 'Unknown Item')}</span>
        <span>${MONEY(item?.lineTotal)}</span>
      </div>
      <div style="font-size:9px; color:#555;">
        ${escapeHtml(item?.qty ?? 0)} x ${MONEY(item?.unitPrice)}${item?.taxCode ? ` (Tax: ${escapeHtml(item.taxCode)})` : ''}
      </div>
    </div>`;

  const fiscal = payload.fiscal
    ? `
      <p>CU Serial: ${escapeHtml(payload.fiscal.cuSerial)}</p>
      <p style="word-break: break-all;">Signature: ${escapeHtml(payload.fiscal.signature)}</p>
      <p>Invoice No: ${escapeHtml(payload.fiscal.invoiceNo)}</p>`
    : `
      <p style="font-weight:bold;">AWAITING FISCAL SIGNATURE</p>
      <p>Invoice queued offline and will transmit on link reconnection.</p>`;

  return `
    <div class="receipt-header">
      <h2>${escapeHtml(payload.tenantName)}</h2>
      ${payload.branchName ? `<p>${escapeHtml(payload.branchName)}</p>` : ''}
      ${payload.kraPin ? `<p>PIN: ${escapeHtml(payload.kraPin)}</p>` : ''}
      ${payload.branchCode ? `<p>Branch ID: ${escapeHtml(payload.branchCode)}</p>` : ''}
      ${payload.phone ? `<p>Tel: ${escapeHtml(payload.phone)}</p>` : ''}
    </div>
    <div class="receipt-divider"></div>
    <div style="font-size:10px; margin-bottom: 8px;">
      <div><b>Invoice:</b> ${escapeHtml(payload.invoiceNo)}</div>
      <div><b>Date:</b> ${escapeHtml(payload.soldAt)}</div>
      <div><b>Cashier:</b> ${escapeHtml(payload.cashierName)}</div>
      <div><b>Customer:</b> ${escapeHtml(payload.customerName)}</div>
      ${payload.buyerPin ? `<div><b>Buyer PIN:</b> ${escapeHtml(payload.buyerPin)}</div>` : ''}
    </div>
    <div class="receipt-divider"></div>
    <div class="receipt-items">${payload.lines.map(line).join('')}</div>
    <div class="receipt-divider"></div>
    <div class="receipt-totals-row"><span>Subtotal</span><span>${MONEY(payload.subtotal)}</span></div>
    <div class="receipt-totals-row"><span>VAT Tax</span><span>${MONEY(payload.taxTotal)}</span></div>
    <div class="receipt-totals-row" style="font-size:13px;">
      <span>TOTAL DUE</span><span>KES ${MONEY(payload.grandTotal)}</span>
    </div>
    <div class="receipt-divider"></div>
    <div style="font-size:10px; margin-bottom: 8px;">
      <div><b>Settlement:</b> ${escapeHtml(payload.paymentMethod)}</div>
      ${payload.paymentReference ? `<div><b>Ref:</b> ${escapeHtml(payload.paymentReference)}</div>` : ''}
    </div>
    <div class="receipt-divider"></div>
    <div class="receipt-header" style="font-size:9px;">
      <p><b>*** KRA eTIMS FISCAL RECORD ***</b></p>
      ${fiscal}
    </div>
    <div class="receipt-divider"></div>
    <div class="receipt-header" style="font-size:9px; margin-top:8px;">
      <p>Thank you for shopping with us!</p>
    </div>`;
}
