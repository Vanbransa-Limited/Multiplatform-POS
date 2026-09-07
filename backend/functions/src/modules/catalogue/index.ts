/**
 * Bulk catalogue import.
 *
 * provisionTenant is the only other thing that writes products, and it rewrites
 * a whole tenant from a seed file. This upserts a batch instead, so a manager
 * can load a supplier list into an empty catalogue and correct it afterwards.
 *
 * A row priced at zero is imported and reported, not rejected: the client would
 * rather have the names in and price them later than block the whole file. Such
 * a product is created inactive so nobody can ring it up for nothing before
 * somebody has looked at it.
 */

import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { ADMIN_ROLES } from "../../shared/roles";
import { asRecord, documentId } from "../../shared/validation";
import { TAX_BASIS_POINTS } from "../sales/constants";

/**
 * Firestore caps a batch at 500 writes and each row is one, so this is the
 * limit per call rather than per file. The till splits a larger sheet into
 * chunks of this size and reports progress across them.
 */
export const MAX_ROWS = 500;
const MAX_TEXT = 200;

export interface ImportIssue {
  row: number;
  sku: string;
  message: string;
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, MAX_TEXT) || fallback;
}

/**
 * "1,250.00", "KES 400", "" -> minor units.
 *
 * Spreadsheets export money with thousands separators and currency prefixes,
 * and a blank cell means zero rather than an error.
 */
export function priceToMinor(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  const minor = Math.round(parsed * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export const importProducts = onCall(
  { region: FUNCTION_REGION, timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const claims = request.auth.token;
    const tenantId = typeof claims.tenant_id === "string" ? claims.tenant_id : null;
    const staffId = typeof claims.staff_id === "string" ? claims.staff_id : null;
    const role = typeof claims.staff_role === "string" ? claims.staff_role : "";
    if (!tenantId || !staffId) {
      throw new HttpsError("permission-denied", "This session carries no staff claims.");
    }
    if (!ADMIN_ROLES.has(role)) {
      throw new HttpsError("permission-denied", "Only an owner or store manager can import products.");
    }

    const input = asRecord(request.data, "Request data");
    const rows = Array.isArray(input.rows) ? input.rows : null;
    if (!rows || rows.length === 0) {
      throw new HttpsError("invalid-argument", "The file contained no rows.");
    }
    if (rows.length > MAX_ROWS) {
      throw new HttpsError(
        "invalid-argument",
        `Send at most ${MAX_ROWS} rows per call; this one carried ${rows.length}.`,
      );
    }

    const rejected: ImportIssue[] = [];
    const unpriced: ImportIssue[] = [];
    const batch = db.batch();
    const seen = new Set<string>();
    let imported = 0;

    rows.forEach((raw, index) => {
      // Row 1 is the header in the file the person is looking at.
      const line = index + 2;
      const row = (raw ?? {}) as Record<string, unknown>;

      const name = text(row.name);
      const sku = text(row.sku, name);
      if (!name) {
        rejected.push({ row: line, sku, message: "No product name." });
        return;
      }
      if (!sku) {
        rejected.push({ row: line, sku: "", message: "No SKU and no name to fall back on." });
        return;
      }
      if (seen.has(sku)) {
        rejected.push({ row: line, sku, message: "Duplicate SKU in this file." });
        return;
      }

      const taxCode = text(row.taxCode, "A").toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(TAX_BASIS_POINTS, taxCode)) {
        rejected.push({ row: line, sku, message: `Unknown tax code "${taxCode}".` });
        return;
      }

      const sellPriceMinor = priceToMinor(row.sellPrice);
      const costPriceMinor = priceToMinor(row.costPrice);
      if (sellPriceMinor === null || costPriceMinor === null) {
        rejected.push({ row: line, sku, message: "Price is not a number." });
        return;
      }

      if (sellPriceMinor === 0) {
        unpriced.push({ row: line, sku, message: `${name} imported with no price.` });
      }

      seen.add(sku);
      const id = deterministicId("product", `${tenantId}:${sku}`);
      batch.set(
        db.collection("products").doc(id),
        {
          id,
          tenantId,
          sku,
          name,
          categoryId: text(row.categoryId) || null,
          uom: text(row.uom, "EACH"),
          sellPriceMinor,
          costPriceMinor,
          taxCode,
          isService: false,
          // Unpriced items exist but cannot be sold until someone prices them.
          isActive: sellPriceMinor > 0,
          updatedAt: Timestamp.now(),
        },
        { merge: true },
      );
      imported += 1;
    });

    // A chunk where every row is unusable is reported, not thrown: the caller
    // is walking a large sheet and one bad block must not lose the rest.
    if (imported > 0) await batch.commit();

    await db.collection("audit_logs").add({
      tenantId,
      branchId: null,
      actorStaffId: staffId,
      action: "catalogue.imported",
      entityType: "product",
      entityId: null,
      metadata: { imported, unpriced: unpriced.length, rejected: rejected.length },
      createdAt: Timestamp.now(),
    });

    return { imported, unpriced, rejected };
  },
);

/**
 * Creates or edits one product in the central catalogue.
 *
 * The Menu Admin editor used to write straight into the browser's own database,
 * so an item added there lived on that one device: it never reached another
 * till, another branch, or the customer menu. Products now go through here, and
 * the same rules the bulk import applies are applied to a single row.
 */
export const upsertProduct = onCall({ region: FUNCTION_REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const claims = request.auth.token;
  const tenantId = typeof claims.tenant_id === "string" ? claims.tenant_id : null;
  const staffId = typeof claims.staff_id === "string" ? claims.staff_id : null;
  const role = typeof claims.staff_role === "string" ? claims.staff_role : "";
  if (!tenantId || !staffId) throw new HttpsError("permission-denied", "This session carries no staff claims.");
  if (!ADMIN_ROLES.has(role)) throw new HttpsError("permission-denied", "Only an owner or store manager can change the catalogue.");

  const input = asRecord(request.data);
  const name = text(input.name);
  if (!name) throw new HttpsError("invalid-argument", "Give the product a name.");
  const sku = text(input.sku, name);
  const taxCode = text(input.taxCode, "A").toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(TAX_BASIS_POINTS, taxCode)) {
    throw new HttpsError("invalid-argument", `Unknown tax code "${taxCode}".`);
  }
  const sellPriceMinor = priceToMinor(input.sellPriceMinor ?? input.sellPrice);
  const costPriceMinor = priceToMinor(input.costPriceMinor ?? input.costPrice);
  if (sellPriceMinor === null || costPriceMinor === null) throw new HttpsError("invalid-argument", "Price is not a number.");

  const isService = input.isService === true;
  // A service has nothing to count and nothing to keep in a store room.
  const trackStock = !isService && input.trackStock === true;
  // Absent means shown: existing products were all on the menu before this flag
  // existed, and a missing field must not quietly hide someone's catalogue.
  const showOnMenu = input.showOnMenu !== false;

  // Editing keeps the id it already has; creating derives one from the SKU, so
  // the same SKU imported later updates this row instead of duplicating it.
  const id = typeof input.id === "string" && input.id
    ? documentId(input.id, "id")
    : deterministicId("product", `${tenantId}:${sku}`);
  const ref = db.collection("products").doc(id);

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists && existing.data()?.tenantId !== tenantId) {
      throw new HttpsError("permission-denied", "That product belongs to another business.");
    }
    const now = Timestamp.now();
    transaction.set(ref, {
      id,
      tenantId,
      sku,
      name,
      categoryId: text(input.categoryId) || null,
      uom: text(input.uom, "EACH"),
      sellPriceMinor,
      costPriceMinor,
      taxCode,
      isService,
      trackStock,
      showOnMenu,
      imagePath: typeof input.imagePath === "string" && /^(https:\/\/|\/(?!\/))/.test(input.imagePath) ? input.imagePath : null,
      // Unpriced items exist but cannot be sold until someone prices them.
      isActive: input.isActive === false ? false : sellPriceMinor > 0,
      updatedAt: now,
      updatedByStaffId: staffId,
    }, { merge: true });

    transaction.create(db.collection("audit_logs").doc(), {
      tenantId,
      actorStaffId: staffId,
      action: existing.exists ? "catalogue.product_updated" : "catalogue.product_created",
      entityType: "product",
      entityId: id,
      metadata: { sku, name, sellPriceMinor, showOnMenu, trackStock },
      createdAt: now,
    });

    return { id, sku, showOnMenu, trackStock, isActive: sellPriceMinor > 0 };
  });
});

/**
 * Creates or renames a product type.
 *
 * Categories were seed data: five rows written into each till's own database
 * and nowhere else, so nothing could add a sixth and the list a manager picked
 * from was not the list the customer menu grouped by.
 */
export const upsertCategory = onCall({ region: FUNCTION_REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const claims = request.auth.token;
  const tenantId = typeof claims.tenant_id === "string" ? claims.tenant_id : null;
  const staffId = typeof claims.staff_id === "string" ? claims.staff_id : null;
  const role = typeof claims.staff_role === "string" ? claims.staff_role : "";
  if (!tenantId || !staffId) throw new HttpsError("permission-denied", "This session carries no staff claims.");
  if (!ADMIN_ROLES.has(role)) throw new HttpsError("permission-denied", "Only an owner or store manager can change product types.");

  const input = asRecord(request.data);
  const name = text(input.name);
  if (!name) throw new HttpsError("invalid-argument", "Give the product type a name.");
  if (name.length > 60) throw new HttpsError("invalid-argument", "That name is too long for a menu heading.");

  // Renaming keeps the id, so every product already filed under it follows the
  // new name instead of being orphaned.
  const id = typeof input.id === "string" && input.id
    ? documentId(input.id, "id")
    : deterministicId("category", `${tenantId}:${name.toLowerCase()}`);
  const ref = db.collection("categories").doc(id);

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists && existing.data()?.tenantId !== tenantId) {
      throw new HttpsError("permission-denied", "That product type belongs to another business.");
    }
    const now = Timestamp.now();
    transaction.set(ref, { id, tenantId, name, updatedAt: now, updatedByStaffId: staffId }, { merge: true });
    transaction.create(db.collection("audit_logs").doc(), {
      tenantId,
      actorStaffId: staffId,
      action: existing.exists ? "catalogue.category_renamed" : "catalogue.category_created",
      entityType: "category",
      entityId: id,
      metadata: { name },
      createdAt: now,
    });
    return { id, name, created: !existing.exists };
  });
});

/**
 * Retires a product.
 *
 * The row is kept and marked inactive rather than deleted: sale lines, stock
 * movements and fiscal records all point at it, and removing the document would
 * leave those reading a name that no longer exists. Inactive is what the till
 * and the customer menu both already filter on, so it disappears from both.
 */
export const retireProduct = onCall({ region: FUNCTION_REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const claims = request.auth.token;
  const tenantId = typeof claims.tenant_id === "string" ? claims.tenant_id : null;
  const staffId = typeof claims.staff_id === "string" ? claims.staff_id : null;
  const role = typeof claims.staff_role === "string" ? claims.staff_role : "";
  if (!tenantId || !staffId) throw new HttpsError("permission-denied", "This session carries no staff claims.");
  if (!ADMIN_ROLES.has(role)) throw new HttpsError("permission-denied", "Only an owner or store manager can remove products.");

  const input = asRecord(request.data);
  const productId = documentId(input.productId, "productId");
  const ref = db.collection("products").doc(productId);

  return db.runTransaction(async (transaction) => {
    const product = await transaction.get(ref);
    const data = product.data();
    if (!product.exists || data?.tenantId !== tenantId) throw new HttpsError("not-found", "Product not found.");

    const now = Timestamp.now();
    transaction.set(ref, {
      isActive: false,
      showOnMenu: false,
      retiredAt: now,
      retiredByStaffId: staffId,
      updatedAt: now,
    }, { merge: true });

    transaction.create(db.collection("audit_logs").doc(), {
      tenantId,
      actorStaffId: staffId,
      action: "catalogue.product_retired",
      entityType: "product",
      entityId: productId,
      metadata: { sku: data?.sku ?? null, name: data?.name ?? null },
      createdAt: now,
    });

    return { productId, name: data?.name ?? productId };
  });
});
