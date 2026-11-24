/**
 * Receipt markup for the counter print station.
 *
 * Deliberately free of Firebase and DOM imports so the escaping rules are
 * executable in Node tests. The station renders jobs written by other devices,
 * so every value here is treated as untrusted text rather than markup: a
 * product or customer name must never become an element on the counter machine.
 */

import QRCode from 'qrcode';

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

/** KRA's verification link as an inline SVG QR code; nothing for anything that is not KRA's. */
function verifyQrSvg(url) {
  if (typeof url !== 'string' || !/^https:\/\/etims(-sbx)?\.kra\.go\.ke\//.test(url)) return '';
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const size = modules.size + quiet * 2;
  let cells = '';
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (modules.get(y, x)) cells += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="140" height="140" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${cells}" fill="#000"/></svg>`;
}

/**
 * The ETR section, printed only once KRA has signed the bill. Every value is
 * KRA's answer from generateEtr; a receipt without one carries no fiscal claim.
 */
export function renderEtrBlock(etr) {
  if (!etr || typeof etr !== 'object' || !etr.rcptSign) return '';
  const row = (label, value) => (value ? `<p>${label}: ${escapeHtml(value)}</p>` : '');
  return `
    <div class="receipt-divider"></div>
    <div class="receipt-header">
      <p><b>*** ETR RECEIPT ***</b></p>
      ${etr.buyerPin ? `<p><b>Buyer PIN:</b> ${escapeHtml(etr.buyerPin)}</p>` : ''}
      ${row('SCU ID', etr.sdcId)}
      ${row('CU Invoice No', etr.sdcId && etr.curRcptNo ? `${etr.sdcId}/${etr.curRcptNo}` : '')}
      ${row('Receipt No', etr.curRcptNo && etr.totRcptNo ? `${etr.curRcptNo}/${etr.totRcptNo}` : '')}
      ${row('Invoice No', etr.invcNo)}
      ${row('SCU Date', etr.sdcDateTime)}
      ${row('MRC No', etr.mrcNo)}
      <p style="word-break: break-all;">Internal Data: ${escapeHtml(etr.intrlData)}</p>
      <p style="word-break: break-all;">Receipt Signature: ${escapeHtml(etr.rcptSign)}</p>
      <div class="receipt-qr-container">${verifyQrSvg(etr.verifyUrl)}<p>Scan to verify with KRA</p></div>
    </div>`;
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

/**
 * The kitchen ticket for a customer menu order.
 *
 * This paper is the cook order: what is printed here is what gets made. It
 * carries no prices or fiscal block, because nothing about it settles money -
 * a reprint says so on its face so the kitchen does not cook the order twice.
 */
export function renderKitchenTicketHtml(payload) {
  if (!payload || !Array.isArray(payload.lines) || !payload.lines.length || !payload.ref) return '';
  const serving = payload.orderType === 'takeaway'
    ? 'TAKEAWAY'
    : `TABLE ${escapeHtml(payload.tableNumber) || '-'}`;

  return `
    <div class="receipt-header">
      <h2>KITCHEN ORDER</h2>
      <p><b>${escapeHtml(payload.ref)}</b></p>
      <p style="font-size:13px;font-weight:bold;">${serving}</p>
    </div>
    <div class="receipt-divider"></div>
    <div style="font-size:13px; margin-bottom:8px;">
      <div><b>Customer:</b> ${escapeHtml(payload.customerName)}</div>
      <div><b>Placed:</b> ${escapeHtml(payload.placedAt)}</div>
      <div><b>Payment:</b> ${payload.paid ? `PAID ${escapeHtml(payload.paymentMethod || '')}` : payload.onTab ? 'ON TAB' : 'UNPAID - COLLECT AT COUNTER'}</div>
      ${payload.copy > 1 ? `<div style="font-weight:bold;">*** REPRINT - COPY ${escapeHtml(payload.copy)} ***</div>` : ''}
    </div>
    <div class="receipt-divider"></div>
    <div class="receipt-items">${payload.lines.map((item) => `
      <div class="receipt-item-row" style="font-size:13px;font-weight:bold;">
        <span>${escapeHtml(item?.qty ?? 0)} x ${escapeHtml(item?.name || 'Unknown Item')}</span>
      </div>`).join('')}</div>
    ${payload.note ? `<div class="receipt-divider"></div><div style="font-size:15px;"><b>Instructions:</b> ${escapeHtml(payload.note)}</div>` : ''}
    <div class="receipt-divider"></div>
    <div class="receipt-header" style="font-size:12px;">
      <p>Not a tax receipt.</p>
    </div>`;
}

export function renderReceiptHtml(payload) {
  if (payload?.kind === 'kitchen') return renderKitchenTicketHtml(payload);
  if (!isPrintableReceipt(payload)) return '';

  const line = (item) => `
    <div class="receipt-item-details">
      <div class="receipt-item-row">
        <span>${escapeHtml(item?.name || 'Unknown Item')}</span>
        <span>${MONEY(item?.lineTotal)}</span>
      </div>
      <div style="font-size:12px; color:#555;">
        ${escapeHtml(item?.qty ?? 0)} x ${MONEY(item?.unitPrice)}${item?.taxCode ? ` (Tax: ${escapeHtml(item.taxCode)})` : ''}
      </div>
    </div>`;

  return `
    <div class="receipt-header">
      ${payload.unpaid ? '<p style="font-weight:bold;">*** PROFORMA INVOICE ***</p><p style="font-weight:bold;">NOT A PAYMENT RECEIPT</p>' : ''}
      <h2>${escapeHtml(payload.tenantName)}</h2>
      ${payload.branchName ? `<p>${escapeHtml(payload.branchName)}</p>` : ''}
      ${payload.kraPin ? `<p>PIN: ${escapeHtml(payload.kraPin)}</p>` : ''}
      ${payload.branchCode ? `<p>Branch ID: ${escapeHtml(payload.branchCode)}</p>` : ''}
      ${payload.phone ? `<p>Tel: ${escapeHtml(payload.phone)}</p>` : ''}
    </div>
    <div class="receipt-divider"></div>
    <div style="font-size:13px; margin-bottom: 8px;">
      <div><b>Invoice:</b> ${escapeHtml(payload.invoiceNo)}</div>
      ${payload.fiscalInvoiceNo ? `<div style="font-size:11px;color:#555;">Fiscal ref: ${escapeHtml(payload.fiscalInvoiceNo)}</div>` : ''}
      <div><b>Date:</b> ${escapeHtml(payload.soldAt)}</div>
      <div><b>Waiter/Waitress:</b> ${escapeHtml(payload.cashierName)}</div>
      <div><b>Customer:</b> ${escapeHtml(payload.customerName)}</div>
      ${payload.tableNo ? `<div><b>Table:</b> ${escapeHtml(payload.tableNo)}</div>` : ''}
      ${payload.buyerPin ? `<div><b>Buyer PIN:</b> ${escapeHtml(payload.buyerPin)}</div>` : ''}
    </div>
    <div class="receipt-divider"></div>
    <div class="receipt-items">${payload.lines
      // The staff preset is a zero-priced marker line; its money is the Discount row.
      .filter((item) => !(item?.productId === 'prod-staff-discount' && !Number(item?.lineTotal)))
      .map(line).join('')}</div>
    <div class="receipt-divider"></div>
    <div class="receipt-totals-row"><span>Subtotal</span><span>${MONEY(payload.subtotal)}</span></div>
    ${Number(payload.discountTotal) > 0 ? `<div class="receipt-totals-row"><span>Discount</span><span>-${MONEY(payload.discountTotal)}</span></div>` : ''}
    <div class="receipt-totals-row"><span>VAT Tax</span><span>${MONEY(payload.taxTotal)}</span></div>
    <div class="receipt-totals-row">
      <span>TOTAL DUE</span><span>KES ${MONEY(payload.grandTotal)}</span>
    </div>
    <div class="receipt-divider"></div>
    <div style="font-size:13px; margin-bottom: 8px;">
      <div><b>Settlement:</b> ${payload.unpaid ? 'UNPAID - ' : ''}${escapeHtml(payload.paymentMethod)}</div>
      ${payload.paymentReference ? `<div><b>Ref:</b> ${escapeHtml(payload.paymentReference)}</div>` : ''}
      ${payload.unpaid ? `<div style="font-weight:bold;">BALANCE DUE: KES ${MONEY(payload.grandTotal)}</div>` : ''}
    </div>
    ${renderEtrBlock(payload.etr)}
    <div class="receipt-divider"></div>
    <div class="receipt-header" style="margin-top:8px;">
      <p>Thank you for shopping with us!</p>
      <p>Powered by KPOS Pro Systems</p>
    </div>`;
}
