'use strict';
// Recompute table_sessions for every table that has ever had a tab, so devices
// reading the server's tabs start from the bills rather than from whichever
// tables happened to change after the 26 Nov 2026 release. Only derived
// records are written; bills and payments are read, never changed. Idempotent.
// Default is a dry run listing what is open; --apply writes.
const path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');

async function main() {
  const args = process.argv.slice(2);
  const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;
  if (!project) throw new Error('Explicit --project required.');
  initializeApp({ projectId: project, credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { refreshTableSession, tableKey } = require('../backend/functions/lib/modules/sales/tab-identity');
  const tables = new Map();
  for (const doc of (await db.collection('sales').select('tenantId', 'branchId', 'tableNumber', 'tabId').get()).docs) {
    const s = doc.data();
    if (!s.tabId || !s.tableNumber || !tableKey(String(s.tableNumber))) continue;
    tables.set(`${s.tenantId}:${s.branchId}:${tableKey(String(s.tableNumber))}`, [s.tenantId, s.branchId, String(s.tableNumber)]);
  }
  console.log(`${tables.size} tables have had a tab.`);
  if (!args.includes('--apply')) return;
  let open = 0;
  for (const [tenantId, branchId, table] of tables.values()) {
    const session = await refreshTableSession(tenantId, branchId, table);
    if (session.status === 'OPEN') {
      open += 1;
      console.log(`OPEN ${tenantId} ${session.tableNumber} KES ${session.dueMinor / 100}${session.splitTabIds.length ? ` (${session.splitTabIds.length} unpaid tabs: consolidate)` : ''}`);
    }
  }
  console.log(`Refreshed ${tables.size}; ${open} open.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
