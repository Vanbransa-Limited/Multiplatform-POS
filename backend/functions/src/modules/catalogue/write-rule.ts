import { ADMIN_ROLES } from "../../shared/roles";
import { productKey } from "./product-key";

type CatalogueEntry = { id: string; name?: unknown; retiredAt?: unknown };

/**
 * Why a new item would duplicate one already in the catalogue, or null.
 *
 * Same brand, size and container is the same product whatever the spelling.
 * A second copy splits its stock: deliveries land on one, the till sells the
 * other, and the one the till sells goes negative. A removed twin is for the
 * owner to restore; only an owner or manager may deliberately start afresh.
 */
export function duplicateNameRefusal(catalogue: readonly CatalogueEntry[], name: string, role: string): string | null {
  const key = productKey(name);
  const twins = catalogue.filter((product) => productKey(product.name) === key);
  const live = twins.find((product) => !product.retiredAt);
  if (live) return `"${String(live.name)}" already exists. Use that item: Add / Remove stock changes its count.`;
  const removed = twins[0];
  if (removed && !ADMIN_ROLES.has(role)) {
    return `"${String(removed.name)}" was removed from the catalogue. Ask the owner to restore it in Menu Admin rather than adding it again.`;
  }
  return null;
}

/**
 * Who may write a product, or why not.
 *
 * Owners and managers run the menu. A store manager books deliveries in, and a
 * delivery is sometimes an item never stocked before (a gas cylinder, a new
 * crate), so they may add one - but only as a new, unpriced item. Setting what
 * customers pay stays with an owner or manager. Returns null when allowed.
 */
export function catalogueWriteRefusal(role: string, product: { exists: boolean; sellPriceMinor: number }): string | null {
  if (ADMIN_ROLES.has(role)) return null;
  if (role !== "store_manager") return "Only an owner or manager can change the catalogue.";
  if (product.exists) return "That item already exists. Use Add / Remove stock to change its count.";
  if (product.sellPriceMinor > 0) return "Add the item without a price; an owner or manager sets its price in Menu Admin.";
  return null;
}
