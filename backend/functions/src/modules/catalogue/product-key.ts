/**
 * Identity for a catalogue product, used to find the same thing listed twice.
 *
 * The catalogue accumulated a product under several names: the count date baked
 * in ("WHITE CAP CAN (22/05/26)"), the brand spaced differently ("WHITECAP" vs
 * "WHITE CAP"), the words in another order ("WHITECAP LAGER 500ML CAN" vs
 * "WHITE CAP CAN 500ML"), and the demo product the tenant was provisioned with
 * sitting under yet another.
 *
 * What actually separates two things a customer can order is the brand, the
 * size and the container: a 500ml can and a 500ml bottle are different products
 * at different prices. So the key is those three and nothing else.
 */

/** Words that describe rather than distinguish. */
const FILLER = new Set([
  "LAGER", "BEER", "PREMIUM", "ORIGINAL", "BRAND", "THE", "AND",
  "STOCK", "OF", "NEW", "OLD", "PC", "PCS", "PACK",
]);

const CONTAINERS = [
  "CAN", "BOTTLE", "BTL", "DRAUGHT", "KEG", "TIN", "GLASS", "TOT", "JUG", "PITCHER",
];

/** Strips every date the stock log left behind, wherever it sits. */
export function stripDates(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\(?\s*STOCK\s+OF\s*:?\s*\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\s*\)?/gi, " ")
    .replace(/\(\s*\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\s*\)/g, " ")
    .replace(/(^|\s)\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?(?=\s|$)/g, " ")
    .replace(/\(?\s*STOCK\s+OF\s*:?\s*\)?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s(,\-]+$/, "")
    .trim();
}

/** "500ML", "1 LITER", "75CL", "1.5L" -> millilitres, so sizes compare. */
export function sizeToMl(text: string): number | null {
  const ml = text.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (ml) return Math.round(Number(ml[1]));
  const cl = text.match(/(\d+(?:\.\d+)?)\s*CL\b/);
  if (cl) return Math.round(Number(cl[1]) * 10);
  const litre = text.match(/(\d+(?:\.\d+)?)\s*(?:L|LT|LTR|LITER|LITRE|LITERS|LITRES)\b/);
  if (litre) return Math.round(Number(litre[1]) * 1000);
  return null;
}

export function productKey(rawName: unknown): string {
  const name = stripDates(rawName).toUpperCase();
  const size = sizeToMl(name);
  // Plural or not, it is the same container: the catalogue carries both
  // "TUSKER LAGER CAN 500ML" and "TUSKER LAGER CANS 500ML" at the same price.
  const container = CONTAINERS.find((c) => new RegExp(`\\b${c}S?\\b`).test(name)) ?? "";

  const brand = name
    .replace(/\d+(?:\.\d+)?\s*(?:ML|CL|L|LT|LTR|LITERS?|LITRES?)\b/g, " ")
    .replace(new RegExp(`\\b(?:${CONTAINERS.join("|")})S?\\b`, "g"), " ")
    .split(/[^A-Z0-9]+/)
    .filter((word) => word && !FILLER.has(word))
    .join("");

  return `${brand}|${size ?? ""}|${container}`;
}
