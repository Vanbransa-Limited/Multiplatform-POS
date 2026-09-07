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
import { productKey, stripDates } from "./product-key";
import { SEED_PRODUCTS, isSeedProduct } from "./seed-products";
import { imageForName } from "./product-images";
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

/** A price the sheet actually moved, so the report can show the change. */
export interface PriceChange {
  sku: string;
  name: string;
  fromMinor: number;
  toMinor: number;
}

interface ExistingProduct {
  id: string;
  sellPriceMinor: number;
  costPriceMinor: number;
  taxCode: string;
  imagePath: string;
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

/**
 * A price cell, keeping "the sheet said nothing" apart from "the sheet said 0".
 *
 * An import re-run to change prices carries a column that is only filled in for
 * the items being changed. Reading a blank cell as zero would wipe the price of
 * every product the sheet did not mention and take it off sale.
 */
export function priceCell(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return priceToMinor(value);
}

/** Products are matched across sheets on this, so spacing and case cannot fork one item into two. */
export function matchKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
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
    // Stamped on every row this run writes, so a follow-up call can tell what
    // the sheet covered from what was already here and did not appear in it.
    const batchId = typeof input.batchId === "string" && input.batchId.length <= 64
      ? input.batchId
      : null;
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

    // What the tenant already sells, so a second sheet updates those products
    // instead of standing up a parallel set beside them. Matched on SKU first
    // and on name second, because plenty of menus carry no product codes.
    const existingSnap = await db
      .collection("products")
      .where("tenantId", "==", tenantId)
      .get();
    const bySku = new Map<string, ExistingProduct>();
    const byName = new Map<string, ExistingProduct>();
    existingSnap.docs.forEach((doc) => {
      const data = doc.data() ?? {};
      const found: ExistingProduct = {
        id: doc.id,
        sellPriceMinor: typeof data.sellPriceMinor === "number" ? data.sellPriceMinor : 0,
        costPriceMinor: typeof data.costPriceMinor === "number" ? data.costPriceMinor : 0,
        taxCode: typeof data.taxCode === "string" ? data.taxCode.toUpperCase() : "",
        imagePath: typeof data.imagePath === "string" ? data.imagePath : "",
      };
      const sku = typeof data.sku === "string" ? matchKey(data.sku) : "";
      const name = typeof data.name === "string" ? matchKey(data.name) : "";
      // First writer wins: a catalogue with two products under one name keeps
      // pointing at the same one rather than alternating between them.
      if (sku && !bySku.has(sku)) bySku.set(sku, found);
      if (name && !byName.has(name)) byName.set(name, found);
    });

    const rejected: ImportIssue[] = [];
    const unpriced: ImportIssue[] = [];
    const repriced: PriceChange[] = [];
    const batch = db.batch();
    const seen = new Set<string>();
    const claimed = new Set<string>();
    let imported = 0;
    let created = 0;
    let updated = 0;
    let illustrated = 0;

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

      const sellCell = priceCell(row.sellPrice);
      const costCell = priceCell(row.costPrice);
      if (sellCell === null || costCell === null) {
        rejected.push({ row: line, sku, message: "Price is not a number." });
        return;
      }

      const existing = bySku.get(matchKey(sku)) ?? byName.get(matchKey(name));

      // A sheet with no tax column must not move an 8% or exempt item onto the
      // standard rate. Only a new product falls back to A.
      const taxCode = text(row.taxCode).toUpperCase() || existing?.taxCode || "A";
      if (!Object.prototype.hasOwnProperty.call(TAX_BASIS_POINTS, taxCode)) {
        rejected.push({ row: line, sku, message: `Unknown tax code "${taxCode}".` });
        return;
      }

      // A blank price keeps whatever the product already sells for; on a new
      // product there is nothing to keep, so it comes in unpriced.
      const sellPriceMinor = sellCell ?? existing?.sellPriceMinor ?? 0;
      const costPriceMinor = costCell ?? existing?.costPriceMinor ?? 0;

      if (sellPriceMinor === 0) {
        unpriced.push({ row: line, sku, message: `${name} imported with no price.` });
      }
      if (existing && sellPriceMinor !== existing.sellPriceMinor) {
        repriced.push({
          sku,
          name,
          fromMinor: existing.sellPriceMinor,
          toMinor: sellPriceMinor,
        });
      }

      seen.add(sku);
      const id = existing?.id ?? deterministicId("product", `${tenantId}:${sku}`);
      if (claimed.has(id)) {
        rejected.push({
          row: line,
          sku,
          message: `Another row in this file already updates "${name}".`,
        });
        return;
      }
      claimed.add(id);

      const category = text(row.categoryId);
      const uom = text(row.uom);
      // A picture is only ever filled in, never replaced: a product someone
      // chose an image for keeps it, and a sheet that carries its own wins over
      // the name rules.
      const imagePath = text(row.imagePath) || text(row.image)
        || existing?.imagePath
        || imageForName(name)
        || "";
      if (imagePath && imagePath !== existing?.imagePath) illustrated += 1;
      batch.set(
        db.collection("products").doc(id),
        {
          id,
          tenantId,
          sku,
          name,
          sellPriceMinor,
          costPriceMinor,
          taxCode,
          isService: false,
          // Unpriced items exist but cannot be sold until someone prices them.
          isActive: sellPriceMinor > 0,
          updatedAt: Timestamp.now(),
          ...(batchId ? { lastImportBatch: batchId } : {}),
          // Columns the sheet left out are not written at all, so a file
          // carrying only names and new prices cannot strip a product of its
          // category or unit on the way past.
          ...(category || !existing ? { categoryId: category || null } : {}),
          ...(uom || !existing ? { uom: uom || "EACH" } : {}),
          ...(imagePath ? { imagePath } : {}),
        },
        { merge: true },
      );
      imported += 1;
      if (existing) updated += 1;
      else created += 1;
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
      metadata: {
        imported,
        created,
        updated,
        illustrated,
        repriced: repriced.length,
        unpriced: unpriced.length,
        rejected: rejected.length,
      },
      createdAt: Timestamp.now(),
    });

    return { imported, created, updated, illustrated, repriced, unpriced, rejected };
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

/**
 * Retires everything the last import did not mention.
 *
 * An import adds and updates; it has never removed. So a menu that was loaded
 * twice - once from a stock export full of "WHITE CAP CAN (22/05/26)" rows,
 * once cleaned up - keeps both, and the demo products a tenant was provisioned
 * with sit there beside them. All of it reaches the customer menu.
 *
 * Retiring rather than deleting, because sales, stock movements and audit rows
 * point at these products and must keep resolving. A retired product is off
 * the menu and off the till, and its history still reads.
 */
export const retireMissingProducts = onCall(
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
      throw new HttpsError("permission-denied", "Only an owner or store manager can retire products.");
    }

    const input = asRecord(request.data, "Request data");
    const batchId = typeof input.batchId === "string" ? input.batchId : "";
    if (!batchId) {
      throw new HttpsError("invalid-argument", "Which import? A batch id is required.");
    }
    const dryRun = input.dryRun === true;

    const snapshot = await db
      .collection("products")
      .where("tenantId", "==", tenantId)
      .get();

    // Anything the run did not stamp: products from an older import, and the
    // seed products the tenant was provisioned with, which carry no stamp at all.
    const stale = snapshot.docs.filter((doc) => {
      const data = doc.data() ?? {};
      if (data.lastImportBatch === batchId) return false;
      // Service charges are not menu items and never appear in a price sheet.
      // Sweeping them would take the VIP charge, corkage and the staff discount
      // off the till the first time somebody tidied the menu.
      if (data.isService === true) return false;
      // Already off the menu and off the till: nothing left to do.
      return data.isActive !== false || data.showOnMenu !== false;
    });

    const names = stale.map((doc) => String(doc.data()?.name ?? doc.id));
    if (dryRun) return { retired: 0, candidates: stale.length, names: names.slice(0, 50) };

    // Firestore caps a batch at 500 writes.
    for (let start = 0; start < stale.length; start += 500) {
      const batch = db.batch();
      for (const doc of stale.slice(start, start + 500)) {
        batch.set(
          doc.ref,
          { isActive: false, showOnMenu: false, retiredAt: Timestamp.now() },
          { merge: true },
        );
      }
      await batch.commit();
    }

    await db.collection("audit_logs").add({
      tenantId,
      branchId: null,
      actorStaffId: staffId,
      action: "catalogue.retired_missing",
      entityType: "product",
      entityId: null,
      metadata: { batchId, retired: stale.length },
      createdAt: Timestamp.now(),
    });

    return { retired: stale.length, candidates: stale.length, names: names.slice(0, 50) };
  },
);

interface DuplicateGroup {
  key: string;
  keep: { id: string; name: string; sellPriceMinor: number };
  retire: { id: string; name: string; sellPriceMinor: number }[];
}

/**
 * Finds the same product listed more than once and keeps the dearer copy.
 *
 * A catalogue loaded from a stock export, loaded again after a tidy-up, and
 * provisioned with demo products on top of that ends up offering one beer four
 * ways at two prices. The customer menu shows all of them.
 *
 * The survivor is the highest priced, because the cheap copy is almost always
 * the stale one: the demo product at its seeded price, or a row from before the
 * last increase. Where the price ties, the fuller name wins, since "WHITECAP
 * LAGER 500ML CAN" says more than "WHITE CAP".
 *
 * Different sizes and different containers are different products and are never
 * merged - a 500ml can at 400 and a 500ml bottle at 350 both survive.
 */
export const dedupeProducts = onCall(
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
      throw new HttpsError("permission-denied", "Only an owner or store manager can merge duplicates.");
    }

    const input = asRecord(request.data, "Request data");
    const dryRun = input.dryRun === true;

    const snapshot = await db
      .collection("products")
      .where("tenantId", "==", tenantId)
      .get();

    const groups = new Map<string, { id: string; name: string; sellPriceMinor: number }[]>();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      // Already retired, or a service charge the till toggles by id.
      if (data.isActive === false && data.showOnMenu === false) continue;
      if (data.isService === true) continue;

      const name = String(data.name ?? doc.id);
      const key = productKey(name);
      // A product with no usable name at all is left well alone.
      if (key === "||") continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        id: doc.id,
        name,
        sellPriceMinor: typeof data.sellPriceMinor === "number" ? data.sellPriceMinor : 0,
      });
    }

    // A row that never said its size or container is not a different product,
    // it is the same one written short: "White Cap Lager 500ml" beside
    // "WHITECAP LAGER 500ML CAN". Fold those into the fuller entry, most
    // specific first, so the vaguest joins what is left rather than being
    // stranded between several halves of itself.
    const byBrand = new Map<string, string[]>();
    for (const key of groups.keys()) {
      const brand = key.split("|")[0];
      if (!byBrand.has(brand)) byBrand.set(brand, []);
      byBrand.get(brand)!.push(key);
    }

    const detail = (key: string) => {
      const [, size, container] = key.split("|");
      return { size, container, rank: (size ? 1 : 0) + (container ? 1 : 0) };
    };

    for (const keys of byBrand.values()) {
      if (keys.length < 2) continue;
      const ordered = [...keys].sort((a, b) => detail(b).rank - detail(a).rank);
      for (const vagueKey of ordered) {
        const vague = groups.get(vagueKey);
        if (!vague) continue;
        const here = detail(vagueKey);

        const candidates = ordered.filter((other) => {
          if (other === vagueKey || !groups.has(other)) return false;
          const there = detail(other);
          if (there.rank <= here.rank) return false;
          // Compatible: what this row did say has to agree.
          return (!here.size || here.size === there.size)
            && (!here.container || here.container === there.container);
        });
        if (candidates.length === 0) continue;

        // Where it could belong to more than one, it joins the dearest, which
        // is the copy that survives anyway.
        const priceOf = (key: string) => Math.max(...groups.get(key)!.map((m) => m.sellPriceMinor));
        const winner = candidates.sort((a, b) => priceOf(b) - priceOf(a))[0];
        groups.get(winner)!.push(...vague);
        groups.delete(vagueKey);
      }
    }

    const duplicates: DuplicateGroup[] = [];
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      // Dearest first. Then the name a customer should read: one still carrying
      // "(STOCK OF 2/06/2026)" is longer than the clean one and would otherwise
      // win on length alone. Only then does a fuller name beat a shorter one.
      const clean = (name: string) => (stripDates(name) === name.trim() ? 0 : 1);
      const ranked = [...members].sort((a, b) =>
        b.sellPriceMinor - a.sellPriceMinor
        || clean(a.name) - clean(b.name)
        || b.name.length - a.name.length
        || a.id.localeCompare(b.id));
      duplicates.push({ key, keep: ranked[0], retire: ranked.slice(1) });
    }

    const toRetire = duplicates.flatMap((group) => group.retire);
    if (dryRun) {
      return {
        retired: 0,
        candidates: toRetire.length,
        groups: duplicates.slice(0, 100),
      };
    }

    const ids = toRetire.map((entry) => entry.id);
    for (let start = 0; start < ids.length; start += 500) {
      const batch = db.batch();
      for (const id of ids.slice(start, start + 500)) {
        batch.set(
          db.collection("products").doc(id),
          { isActive: false, showOnMenu: false, retiredAt: Timestamp.now() },
          { merge: true },
        );
      }
      await batch.commit();
    }

    await db.collection("audit_logs").add({
      tenantId,
      branchId: null,
      actorStaffId: staffId,
      action: "catalogue.duplicates_retired",
      entityType: "product",
      entityId: null,
      metadata: { groups: duplicates.length, retired: ids.length },
      createdAt: Timestamp.now(),
    });

    return { retired: ids.length, candidates: ids.length, groups: duplicates.slice(0, 100) };
  },
);

/**
 * Clears the demo products a tenant was provisioned with off a live catalogue.
 *
 * These reach the customer menu at their seeded prices - a White Cap at 250
 * beside nothing, because no import ever mentioned them and no duplicate ever
 * matched them. Nothing else removes them.
 *
 * Only records still carrying their seeded id and sku are touched, so a tenant
 * who repurposed one keeps it, and the service charges are never in scope.
 */
export const retireSeedProducts = onCall(
  { region: FUNCTION_REGION, timeoutSeconds: 120 },
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
      throw new HttpsError("permission-denied", "Only an owner or store manager can remove the demo products.");
    }

    const input = asRecord(request.data, "Request data");
    const dryRun = input.dryRun === true;

    const refs = [...SEED_PRODUCTS.keys()].map((id) => db.collection("products").doc(id));
    const docs = await db.getAll(...refs);

    const ghosts = docs.filter((doc) => {
      const data = doc.data();
      if (!doc.exists || !data || data.tenantId !== tenantId) return false;
      if (data.isActive === false && data.showOnMenu === false) return false;
      return isSeedProduct(doc.id, data);
    });

    const names = ghosts.map((doc) => String(doc.data()?.name ?? doc.id));
    if (dryRun) return { retired: 0, candidates: ghosts.length, names };

    if (ghosts.length) {
      const batch = db.batch();
      for (const doc of ghosts) {
        batch.set(
          doc.ref,
          { isActive: false, showOnMenu: false, retiredAt: Timestamp.now() },
          { merge: true },
        );
      }
      await batch.commit();

      await db.collection("audit_logs").add({
        tenantId,
        branchId: null,
        actorStaffId: staffId,
        action: "catalogue.demo_products_retired",
        entityType: "product",
        entityId: null,
        metadata: { retired: ghosts.length, names },
        createdAt: Timestamp.now(),
      });
    }

    return { retired: ghosts.length, candidates: ghosts.length, names };
  },
);
