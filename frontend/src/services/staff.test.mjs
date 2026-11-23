import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStaffFile } from './csv.js';
import { roleCode } from './roles.js';
import { STAFF_TEMPLATE_CSV, toLocalUser } from './staff.js';
import { canViewTab } from '../navigation.js';

test('cashiers cannot open staff administration or management screens', () => {
  for (const tab of ['settings', 'finance', 'inventory', 'audit-logs', 'store-stock']) {
    assert.equal(canViewTab('Cashier', tab), false);
  }
  assert.equal(canViewTab('Cashier', 'till'), true);
  // The customer directory sets credit limits, so it stays with the owner and
  // the supervisor running the floor.
  assert.equal(canViewTab('Owner', 'customers'), true);
  assert.equal(canViewTab('Supervisor', 'customers'), true);
  for (const role of ['Cashier', 'Bar Staff', 'Store Keeper', 'Store Manager']) {
    assert.equal(canViewTab(role, 'customers'), false, `${role} cannot open the directory`);
  }
});

test('staff import preserves password whitespace and blank row positions', async () => {
  const parsed = await parseStaffFile(asFile('Name,Email,Password\n\nJane,jane@shop.pos, secret123 \n'));
  assert.equal(parsed.rows[0].name, '');
  assert.equal(parsed.rows[1].password, ' secret123 ');
});

test('staff import requires a password column', async () => {
  const parsed = await parseStaffFile(asFile('Name,Email\nJane,jane@shop.pos'));
  assert.match(parsed.error, /No password column/);
});

/** parseStaffFile only needs a name and text(), not a browser File. */
const asFile = (content, name = 'roster.csv') => ({ name, type: 'text/csv', text: async () => content });

test('the template we hand out is a file we can read back', async () => {
  // The one failure that makes the whole feature useless: an operator fills in
  // our own template and the importer cannot map its columns.
  const { rows, mapping, error } = await parseStaffFile(asFile(STAFF_TEMPLATE_CSV));

  assert.equal(error, null);
  assert.equal(mapping.role, 'Access Level');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    name: 'Wanjiku Kamau',
    email: 'wanjiku@yourbusiness.pos',
    role: 'Cashier',
    password: 'changeme123',
    phone: '0712345678'
  });
});

test('a roster with no email column is refused, because email is the sign-in', async () => {
  const { error, rows } = await parseStaffFile(asFile('Name,Access Level\nWanjiku,Cashier\n'));
  assert.match(error, /No email column/);
  assert.equal(rows.length, 0);
});

test('access levels are read loosely, but an unknown one is never demoted to cashier', () => {
  assert.equal(roleCode('Cashier'), 'cashier');
  assert.equal(roleCode('cashier / waiter (level 1)'), 'cashier');
  assert.equal(roleCode('Store-Manager'), 'store_manager');
  assert.equal(roleCode('Manager'), 'manager');
  assert.equal(roleCode('manager'), 'manager');
  assert.equal(roleCode('store_keeper'), 'store_keeper');
  // Blank is the common case in a roster of cashiers.
  assert.equal(roleCode(''), 'cashier');
  // Silently making this a cashier would hand out the wrong access.
  assert.equal(roleCode('Accountant'), null);
});

test('server staff map onto the row shape the user list filters on', () => {
  const row = toLocalUser({ id: 'staff-1', tenantId: 't1', name: 'Wanjiku', email: 'w@x.pos', role: 'cashier', status: 'active' });
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.role, 'Cashier');
});
