/**
 * Sidebar modules and the roles allowed to reach them.
 *
 * main.js carried this table twice - once to hide nav buttons and once to
 * guard tab switching - and the two copies had to stay in step by hand. One
 * table now feeds the sidebar, the route guard and nothing else.
 *
 * Labels and icons are exactly those from the original index.html.
 */

/**
 * Sidebar groups, in the order they appear.
 *
 * Grouped by what someone is trying to do rather than by which screen came
 * first: a cashier lives entirely in Service, a store keeper in Stock, and an
 * owner drops into Money and Administration at the end of a shift.
 *
 * Users is not here - staff management now lives inside Settings, so there is
 * one place that answers "who can do what".
 */
export const NAV_GROUPS = [
  {
    id: 'service',
    label: 'Service',
    items: [
      { tab: 'till', icon: '🏪', label: 'Dashboard', short: 'Till' },
      { tab: 'orders', icon: '🧾', label: 'Orders Viewer', short: 'Orders' },
      { tab: 'shifts', icon: '💵', label: 'Shift Management', short: 'Shifts' },
      { tab: 'print-station', icon: '🖨️', label: 'Print Station', short: 'Print' }
    ]
  },
  {
    id: 'stock',
    label: 'Stock',
    items: [
      { tab: 'inventory', icon: '🍽️', label: 'Menu Admin', short: 'Menu' },
      { tab: 'store-stock', icon: '📦', label: 'Store Stock', short: 'Store' },
      { tab: 'house-stock', icon: '📊', label: 'House Stock', short: 'House' }
    ]
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { tab: 'mpesa', icon: '📱', label: 'Mpesa', short: 'M-Pesa' },
      { tab: 'finance', icon: '📈', label: 'Financials & AI', short: 'Money' }
    ]
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { tab: 'audit-logs', icon: '📜', label: 'Audit Logs', short: 'Audit' },
      { tab: 'qrtools', icon: '🔧', label: 'QR & Tools', short: 'Tools' },
      { tab: 'settings', icon: '⚙️', label: 'Settings', short: 'Settings' }
    ]
  }
];

/** Flat list, still the single source of truth for what a route is called. */
export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

/**
 * What earns a slot on a phone's bottom bar, most-reached first.
 *
 * A bar with everything on it is a list, not navigation. Only the first few a
 * role can actually open get a slot; the rest live behind More, so the bar is
 * the same shape and in the same place whoever is signed in.
 */
export const MOBILE_PRIORITY = [
  'till', 'orders', 'house-stock', 'shifts', 'inventory',
  'store-stock', 'mpesa', 'print-station', 'finance', 'qrtools', 'audit-logs', 'settings',
];

const byPriority = (a, b) => MOBILE_PRIORITY.indexOf(a.tab) - MOBILE_PRIORITY.indexOf(b.tab);

/** The tabs that get their own button, and everything left for the More sheet. */
export function mobileNav(role, slots = 4) {
  const visible = NAV_ITEMS.filter((item) => canViewTab(role, item.tab) && MOBILE_PRIORITY.includes(item.tab)).sort(byPriority);
  return { primary: visible.slice(0, slots), overflow: visible.slice(slots) };
}

/** The group holding a tab, so the sidebar can open it on a deep link. */
export function groupForTab(tab) {
  const group = NAV_GROUPS.find((entry) => entry.items.some((item) => item.tab === tab));
  return group ? group.id : NAV_GROUPS[0].id;
}

/** Modules absent from this map are reachable by every signed-in role. */
export const RESTRICTED_TABS = {
  // Settings now carries staff management, so it keeps the old users rule.
  'settings': ['Owner', 'Store Manager'],
  'inventory': ['Owner', 'Store Manager', 'Supervisor', 'Store Keeper'],
  'store-stock': ['Owner', 'Store Manager', 'Supervisor', 'Store Keeper'],
  'house-stock': ['Owner', 'Store Manager', 'Supervisor', 'Bar Staff', 'Store Keeper'],
  'orders': ['Owner', 'Store Manager', 'Supervisor', 'Bar Staff', 'Cashier'],
  // The station runs on the one machine holding the printer, but a cashier
  // needs to see the queue to know whether paper is actually coming - and to
  // force a receipt through by hand when it is not.
  'print-station': ['Owner', 'Store Manager', 'Supervisor', 'Cashier'],
  'finance': ['Owner', 'Store Manager'],
  'qrtools': ['Owner', 'Store Manager', 'Supervisor'],
  'audit-logs': ['Owner', 'Store Manager']
};

export function canViewTab(role, tab) {
  // The House always exists, so only the Store screen can be switched off.
  const storeEnabled = typeof localStorage === 'undefined' || localStorage.getItem('pos_store_enabled') !== 'false';
  if (tab === 'store-stock' && !storeEnabled) return false;
  const allowed = RESTRICTED_TABS[tab];
  return !allowed || allowed.includes(role);
}

export const DEFAULT_TAB = 'till';
