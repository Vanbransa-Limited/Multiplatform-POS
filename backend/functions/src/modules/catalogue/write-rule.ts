import { ADMIN_ROLES } from "../../shared/roles";

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
