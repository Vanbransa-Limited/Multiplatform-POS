const assert = require('node:assert/strict');
const test = require('node:test');

const authModule = require('firebase-admin/auth');
const { db } = require('../lib/lib/firebase');
const { setStaffRole } = require('../lib/modules/staff-admin');

const owner = { token: { tenant_id: 't1', staff_id: 's-owner', staff_role: 'owner' } };
const manager = { token: { tenant_id: 't1', staff_id: 's-manager', staff_role: 'manager' } };

/** Staff documents and Auth users in memory. */
function harness(staff) {
  const docs = new Map(Object.entries(staff).map(([id, row]) => [id, { ...row }]));
  const claims = new Map([...docs.values()].map(row => [row.authUid, { tenant_id: row.tenantId, staff_id: 'x', staff_role: row.role, extra: 'kept' }]));
  const calls = { claims: [], revoked: [], audit: [] };
  const realGetAuth = authModule.getAuth;
  const realCollection = db.collection;
  authModule.getAuth = () => ({
    getUser: async uid => ({ uid, customClaims: claims.get(uid) }),
    setCustomUserClaims: async (uid, value) => { claims.set(uid, value); calls.claims.push({ uid, ...value }); },
    revokeRefreshTokens: async uid => { calls.revoked.push(uid); },
  });
  db.collection = name => {
    if (name === 'audit_logs') return { add: async row => calls.audit.push(row) };
    const filters = [];
    const query = {
      where: (field, _op, value) => { filters.push([field, value]); return query; },
      get: async () => {
        const rows = [...docs.values()].filter(row => filters.every(([f, v]) => row[f] === v));
        return { size: rows.length, docs: rows.map(row => ({ data: () => row })) };
      },
      doc: id => ({
        get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
        update: async change => { docs.set(id, { ...docs.get(id), ...change }); },
      }),
    };
    return query;
  };
  return { docs, claims, calls, restore: () => { authModule.getAuth = realGetAuth; db.collection = realCollection; } };
}

const staff = () => ({
  's-owner': { tenantId: 't1', authUid: 'u-owner', role: 'owner', status: 'active' },
  's-manager': { tenantId: 't1', authUid: 'u-manager', role: 'manager', status: 'active' },
  's-sherryl': { tenantId: 't1', authUid: 'u-sherryl', role: 'store_manager', status: 'active' },
  's-other': { tenantId: 't2', authUid: 'u-other', role: 'cashier', status: 'active' },
});

test('an owner promotes staff to manager: profile, sign-in role and old sessions all change', async () => {
  const h = harness(staff());
  try {
    assert.deepEqual(await setStaffRole.run({ auth: owner, data: { staffId: 's-sherryl', role: 'manager' } }), { staffId: 's-sherryl', role: 'manager' });
    assert.equal(h.docs.get('s-sherryl').role, 'manager');
    // Other claims ride along untouched; only the role changes.
    assert.deepEqual(h.claims.get('u-sherryl'), { tenant_id: 't1', staff_id: 'x', staff_role: 'manager', extra: 'kept' });
    assert.deepEqual(h.calls.revoked, ['u-sherryl']);
    assert.equal(h.calls.audit[0].action, 'staff.role_changed');
    assert.deepEqual(h.calls.audit[0].metadata, { from: 'store_manager', to: 'manager' });
  } finally { h.restore(); }
});

test('a manager may move non-owners but can never mint an owner, touch an owner or change their own role', async () => {
  const h = harness(staff());
  try {
    assert.equal((await setStaffRole.run({ auth: manager, data: { staffId: 's-sherryl', role: 'supervisor' } })).role, 'supervisor');
    await assert.rejects(setStaffRole.run({ auth: manager, data: { staffId: 's-sherryl', role: 'owner' } }), /cannot assign/);
    await assert.rejects(setStaffRole.run({ auth: manager, data: { staffId: 's-owner', role: 'cashier' } }), /Only an owner/);
    await assert.rejects(setStaffRole.run({ auth: manager, data: { staffId: 's-manager', role: 'owner' } }), /your own role/);
    await assert.rejects(setStaffRole.run({ auth: manager, data: { staffId: 's-other', role: 'cashier' } }), /No such staff/);
    await assert.rejects(setStaffRole.run({ auth: { token: { ...manager.token, staff_role: 'store_manager' } }, data: { staffId: 's-sherryl', role: 'cashier' } }), /owner or manager/);
    await assert.rejects(setStaffRole.run({ auth: owner, data: { staffId: 's-sherryl', role: 'root' } }), /valid staff role/);
  } finally { h.restore(); }
});

test('the last active owner cannot be demoted', async () => {
  const h = harness({ ...staff(), 's-owner2': { tenantId: 't1', authUid: 'u-owner2', role: 'owner', status: 'active' } });
  try {
    await setStaffRole.run({ auth: owner, data: { staffId: 's-owner2', role: 'manager' } });
    h.docs.set('s-owner3', { tenantId: 't1', authUid: 'u-owner3', role: 'owner', status: 'disabled' });
    const second = { token: { ...owner.token, staff_id: 's-owner2' } };
    await assert.rejects(setStaffRole.run({ auth: second, data: { staffId: 's-owner', role: 'manager' } }), /last active owner/);
  } finally { h.restore(); }
});
