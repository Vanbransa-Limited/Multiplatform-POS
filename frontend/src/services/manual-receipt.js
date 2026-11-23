/** Read the receipt total, never infer it from the outstanding bill. */
export function manualReceipt(code, amount) {
  const reference = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(reference)) throw new Error('Enter the ten-character M-Pesa code.');
  const text = String(amount ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter the amount on the M-Pesa receipt.');
  const [whole, fraction = ''] = text.split('.');
  const receiptAmountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(receiptAmountMinor) || receiptAmountMinor <= 0) throw new Error('Enter a valid receipt amount greater than zero.');
  return { reference, receiptAmountMinor };
}
