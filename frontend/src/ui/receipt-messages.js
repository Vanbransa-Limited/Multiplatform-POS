/** Cashier-facing text; payment provenance stays in the financial records. */
export function receiptSummary(receipt) {
  if (receipt.availableMinor <= 0) return 'This code has already been fully used.';
  const kes = value => `KES ${(value / 100).toFixed(2)}`;
  return `Amount: ${kes(receipt.receivedMinor)}. Available: ${kes(receipt.availableMinor)}.`;
}

export function receiptCheckError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code.endsWith('/not-found') || /No (saved|confirmed) M-Pesa|No confirmed payment/i.test(message)) {
    return 'Payment not found. Check the code and try again.';
  }
  if (/unauthenticated|permission-denied/.test(code) || /sign.in|business changed/i.test(message)) {
    return 'Sign in again to check this payment.';
  }
  if (/timeout|deadline-exceeded|unavailable|internal$/.test(code) || /too long|connection|could not respond/i.test(message)) {
    return 'Could not check payment. Try again.';
  }
  return 'This payment needs checking. Ask your manager for help.';
}
