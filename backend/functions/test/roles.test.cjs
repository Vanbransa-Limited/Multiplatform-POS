const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ADMIN_ROLES,
  canAssignRole,
  ROLE_LABELS,
  STAFF_ROLES,
} = require("../lib/shared/roles.js");

test("every role code has a till label and vice versa", () => {
  assert.equal(STAFF_ROLES.size, Object.keys(ROLE_LABELS).length);
  for (const role of STAFF_ROLES) {
    assert.equal(typeof ROLE_LABELS[role], "string", `${role} has no label`);
  }
});

test("only owners and managers administer staff; the store manager runs stock", () => {
  assert.deepEqual([...ADMIN_ROLES].sort(), ["manager", "owner"]);
  assert.equal(ROLE_LABELS.manager, "Manager");
});

test("a manager cannot mint an owner", () => {
  // Otherwise a manager creates an owner account, signs into it, and has
  // escalated straight out of their own role.
  assert.equal(canAssignRole("manager", "owner"), false);
  assert.equal(canAssignRole("owner", "owner"), true);
});

test("a manager can create every non-owner role, including another manager", () => {
  for (const role of STAFF_ROLES) {
    if (role === "owner") continue;
    assert.equal(canAssignRole("manager", role), true, `manager should assign ${role}`);
  }
});

test("non-administrators can assign nothing at all", () => {
  for (const actor of ["cashier", "bar_staff", "supervisor", "store_keeper", "store_manager", "", "admin"]) {
    for (const target of ["cashier", "owner"]) {
      assert.equal(canAssignRole(actor, target), false, `${actor} must not assign ${target}`);
    }
  }
});

test("an unknown target role is never assignable", () => {
  for (const target of ["superuser", "OWNER", "", "root"]) {
    assert.equal(canAssignRole("owner", target), false, `${target} must not be assignable`);
  }
});

// ---- Module access per role (owner switches) ----
const { canSell, normaliseModuleAccess, MODULE_KEYS } = require("../lib/shared/roles.js");
const { setModuleAccess } = require("../lib/modules/staff-admin");
const { db } = require("../lib/lib/firebase");

test("selling is open to every role but the manager until the owner switches it", () => {
  for (const role of STAFF_ROLES) assert.equal(canSell({}, role), role !== "manager", role);
  // Oversight by default, but the owner can still hand a manager the till.
  assert.equal(canSell({ moduleAccess: { sell: ["manager"] } }, "manager"), true);
  const settings = { moduleAccess: { sell: ["cashier"] } };
  assert.equal(canSell(settings, "cashier"), true);
  assert.equal(canSell(settings, "store_keeper"), false);
  // The owner can never be locked out of their own till.
  assert.equal(canSell({ moduleAccess: { sell: [] } }, "owner"), true);
});

test("a module access map is normalised and anything unknown is refused", () => {
  assert.ok(MODULE_KEYS.has("sell") && MODULE_KEYS.has("tabs"));
  assert.deepEqual(
    normaliseModuleAccess({ tabs: ["owner", "bar_staff", "cashier", "bar_staff"], sell: [] }),
    { tabs: ["bar_staff", "cashier"], sell: [] },
  );
  assert.throws(() => normaliseModuleAccess({ hack: ["cashier"] }), /Unknown module/);
  assert.throws(() => normaliseModuleAccess({ tabs: ["root"] }), /Unknown role/);
  assert.throws(() => normaliseModuleAccess({ tabs: "cashier" }), /list of roles/);
});

test("only the owner may change who can reach each module, and it is audited", async () => {
  const manager = { token: { tenant_id: "t1", staff_id: "s7", staff_role: "store_manager" } };
  await assert.rejects(setModuleAccess.run({ auth: manager, data: { moduleAccess: {} } }), /Only the owner/);

  const writes = [];
  const original = db.collection;
  db.collection = (name) => ({
    doc: (id) => ({ update: async (data) => writes.push([name, id, data]) }),
    add: async (data) => writes.push([name, null, data]),
  });
  try {
    const owner = { token: { tenant_id: "t1", staff_id: "s1", staff_role: "owner" } };
    const result = await setModuleAccess.run({ auth: owner, data: { moduleAccess: { sell: ["cashier", "owner"] } } });
    assert.deepEqual(result, { moduleAccess: { sell: ["cashier"] } });
    const [settings, audit] = writes;
    assert.deepEqual([settings[0], settings[1], settings[2].moduleAccess, settings[2].updatedByStaffId], ["tenant_settings", "t1", { sell: ["cashier"] }, "s1"]);
    assert.equal(audit[2].action, "settings.module_access");
  } finally { db.collection = original; }
});
