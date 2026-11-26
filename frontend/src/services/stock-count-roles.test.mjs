import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Approving a count posts it through importStock(mode: 'count'), which the
// server allows for STOCK_ROLES.adjust. The Approve button must agree with it:
// a Store Manager running a House-only business was told no by the till alone.
const inventory = await readFile(new URL('../ui/inventory.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../../../backend/functions/src/modules/stock/index.ts', import.meta.url), 'utf8');
const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', store_manager: 'Store Manager', supervisor: 'Supervisor',
  cashier: 'Cashier', bar_staff: 'Bar Staff', store_keeper: 'Store Keeper' };

test('Approve on a stock count is offered to exactly the roles the server lets post it', () => {
  const adjust = server.match(/adjust:\s*\[([^\]]*)\]/)[1].match(/'(\w+)'/g).map((r) => ROLE_LABELS[r.slice(1, -1)]);
  const getter = inventory.match(/get canApproveCounts\(\)\s*\{([^}]*)\}/);
  assert.ok(getter, 'inventory.js has a canApproveCounts getter');
  const roles = (new Function('state', getter[1]));
  for (const role of Object.values(ROLE_LABELS)) {
    assert.equal(roles({ currentUser: { role } }), adjust.includes(role), role);
  }
  const handler = inventory.slice(inventory.indexOf("pane.querySelectorAll('.approve-take-btn')"));
  assert.match(handler.slice(0, 400), /if \(!this\.canApproveCounts\)/);
  assert.doesNotMatch(inventory, /Only an Owner or Store Manager can approve stock counts/);
});
