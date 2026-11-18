import { HttpsError } from "firebase-functions/v2/https";

/**
 * Canonical staff roles.
 *
 * The role codes the backend authorises against. The till shows friendlier
 * labels; ROLE_LABELS is the one place that translation lives, so a renamed
 * label can never silently create a role nothing grants access to.
 */

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  store_manager: "Store Manager",
  supervisor: "Supervisor",
  cashier: "Cashier",
  bar_staff: "Bar Staff",
  store_keeper: "Store Keeper",
};

export const STAFF_ROLES = new Set(Object.keys(ROLE_LABELS));

/** Roles that may create, re-password, or disable other staff. */
export const ADMIN_ROLES = new Set(["owner", "store_manager"]);

/**
 * Only an owner may mint another owner.
 *
 * Without this a store manager could create an owner account and then sign in
 * as it, which is a full privilege escalation out of their own role.
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (!ADMIN_ROLES.has(actorRole)) return false;
  if (targetRole === "owner") return actorRole === "owner";
  return STAFF_ROLES.has(targetRole);
}

/**
 * What the owner can switch on or off per role: every sidebar module, plus
 * `sell`, the right to ring up a sale. Mirrors NAV_ITEMS in the till.
 */
export const MODULE_KEYS = new Set([
  "sell", "till", "orders", "tabs", "customers", "shifts", "print-station",
  "inventory", "store-stock", "house-stock", "mpesa", "finance",
  "audit-logs", "qrtools", "settings",
]);

/**
 * Clean an owner's access map: known modules and roles only, no duplicates,
 * and never the owner, who always has everything and so cannot lock
 * themselves out.
 */
export function normaliseModuleAccess(input: unknown): Record<string, string[]> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpsError("invalid-argument", "Send module access as a map of modules to roles.");
  }
  const out: Record<string, string[]> = {};
  for (const [key, roles] of Object.entries(input)) {
    if (!MODULE_KEYS.has(key)) throw new HttpsError("invalid-argument", `Unknown module: ${key}.`);
    if (!Array.isArray(roles)) throw new HttpsError("invalid-argument", `Give ${key} a list of roles.`);
    for (const role of roles) {
      if (!STAFF_ROLES.has(String(role))) throw new HttpsError("invalid-argument", `Unknown role: ${role}.`);
    }
    out[key] = [...new Set(roles.map(String))].filter((role) => role !== "owner").sort();
  }
  return out;
}

/** Whether a role may create sales under this tenant's settings. */
export function canSell(settings: Record<string, unknown>, role: string): boolean {
  if (role === "owner") return true;
  const roles = (settings.moduleAccess as Record<string, unknown> | undefined)?.sell;
  return Array.isArray(roles) ? roles.includes(role) : STAFF_ROLES.has(role);
}
