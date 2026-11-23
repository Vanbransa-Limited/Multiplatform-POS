/**
 * Role code <-> till label.
 *
 * Custom claims carry the backend's role codes; every role check in the till is
 * written against the display labels. Translating once at the sign-in boundary
 * keeps both sides speaking their own vocabulary - and a mismatch here silently
 * hides modules rather than failing loudly, so it lives in one place.
 */

export const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  store_manager: 'Store Manager',
  supervisor: 'Supervisor',
  cashier: 'Cashier',
  bar_staff: 'Bar Staff',
  store_keeper: 'Store Keeper'
};

export const ROLE_CODES = Object.fromEntries(
  Object.entries(ROLE_LABELS).map(([code, label]) => [label, code])
);

/** Backend role code -> the label the till's permission checks expect. */
export function roleLabel(code) {
  return ROLE_LABELS[String(code || '')] || '';
}

/**
 * Whatever an operator typed in a spreadsheet -> a backend role code.
 *
 * Accepts the label, the code, and the loose spellings a roster actually
 * carries ("cashier / waiter", "Store-Manager"). Blank means cashier, which is
 * the role a bulk roster is almost always made of. Anything else returns null
 * so the row is rejected by name rather than quietly demoted to cashier.
 */
export function roleCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'cashier';

  // "Cashier / Waiter (Level 1)" -> "cashier"
  const key = raw.split('/')[0].replace(/\(.*\)/g, '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  for (const [code, label] of Object.entries(ROLE_LABELS)) {
    if (key === label.toLowerCase() || key === code.replace(/_/g, ' ')) return code;
  }
  return null;
}
