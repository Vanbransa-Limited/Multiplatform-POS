/**
 * The demo products provisionTenant writes when a tenant is created.
 *
 * They are a sample bar - a Tusker, a Coca-Cola, a plate of nyama choma - meant
 * to give an empty till something to show. On a live tenant they are ghosts:
 * they reach the customer menu at their seeded prices, they are not what the
 * business sells, and no import ever removes them because an import only adds
 * and updates.
 *
 * Matched on id AND sku together, so a tenant who reused one of these records
 * for something real - same id, their own sku - keeps it.
 *
 * The three service charges are deliberately absent. The till toggles
 * prod-table-service and prod-staff-discount by id, and retiring them would
 * take the VIP charge and the staff discount off the counter.
 */
export const SEED_PRODUCTS: ReadonlyMap<string, string> = new Map([
  ["prod-tusker-bottle", "BAR-BEE-01"],
  ["prod-guinness", "BAR-BEE-02"],
  ["prod-whitecap", "BAR-BEE-03"],
  ["prod-savanna", "BAR-CID-04"],
  ["prod-smirnoff-tot", "BAR-SPR-01"],
  ["prod-jameson-tot", "BAR-SPR-02"],
  ["prod-konyagi", "BAR-SPR-03"],
  ["prod-wine-glass", "BAR-WIN-01"],
  ["prod-coca-cola", "BAR-SFT-01"],
  ["prod-fanta", "BAR-SFT-02"],
  ["prod-water", "BAR-SFT-03"],
  ["prod-juice", "BAR-SFT-04"],
  ["prod-nyama-choma", "FOD-NYM-01"],
  ["prod-chicken-chips", "FOD-CKN-02"],
  ["prod-pilau", "FOD-PIL-03"],
  ["prod-ugali-stew", "FOD-UGL-04"],
  ["prod-samosa", "FOD-SAM-05"],
]);

/** True when this document is still the untouched demo record. */
export function isSeedProduct(id: string, data: Record<string, unknown>): boolean {
  const sku = SEED_PRODUCTS.get(id);
  if (!sku) return false;
  if (data.isService === true) return false;
  // An import that covered this record made it part of the real menu.
  if (typeof data.lastImportBatch === "string" && data.lastImportBatch) return false;
  return String(data.sku ?? "") === sku;
}
