/**
 * Picks a picture for a product from its name.
 *
 * The rules are the ones curated on the till, moved here because the till was
 * the wrong place for them: they were written into the browser's own database,
 * which the customer menu never reads and which the next catalogue refresh
 * overwrites from the server. Applied on import, they land on the product
 * document itself, so every till and the customer menu show the same picture.
 *
 * Order matters - the first rule that matches wins - so the specific ones come
 * before the general: a Jameson gets the Jameson bottle, not the generic
 * whiskey glass, and a chapati with beans beats plain beans.
 */

interface ImageRule {
  /** Any of these appearing in the name selects this image. */
  match: string[];
  /** ...unless one of these appears too. */
  not?: string[];
  path: string;
}

export const IMAGE_RULES: readonly ImageRule[] = [
  { match: ["chapati beans", "chapati & beans", "chapati and beans", "beans & chapati"], path: "/ai_images/chapati_beans.jpg" },
  { match: ["chapati"], not: ["rolling pin", "pin"], path: "/ai_images/chapati_beans.jpg" },
  { match: ["beans", "maharagwe", "madondo"], not: ["coffee", "espresso", "jelly", "cocoa", "vanilla"], path: "/ai_images/chapati_beans.jpg" },
  { match: ["william lawson", "william lawsons", "william"], path: "/ai_images/william_lawson.jpg" },
  { match: ["jameson"], path: "/ai_images/jameson_bottle.jpg" },
  { match: ["jw blue", "blue label"], path: "/ai_images/blue_label.jpg" },
  { match: ["johnnie walker", "black label", "red label", "gold label", "green label"], path: "/ai_images/johnnie_walker.jpg" },
  { match: ["savanna", "cider"], path: "/ai_images/cider_glass.jpg" },
  { match: ["guinness", "stout"], path: "/ai_images/stout_glass.jpg" },
  { match: ["tusker"], path: "/ai_images/tusker_lager.jpg" },
  { match: ["white cap", "whitecap"], path: "/ai_images/whitecap_lager.jpg" },
  { match: ["beer", "lager", "senator", "pilsner"], not: ["glass", "mug"], path: "/ai_images/beer_glass.jpg" },
  { match: ["smirnoff", "vodka"], path: "/ai_images/vodka_glass.jpg" },
  { match: ["whiskey", "whisky", "jack daniel", "balvenie", "glenfiddich", "king robert", "bond 7"], path: "/ai_images/whiskey_glass.jpg" },
  { match: ["konyagi", "gin", "gordon", "tanqueray", "gilbeys"], not: ["ginger", "charging"], path: "/ai_images/gin_glass.jpg" },
  { match: ["rosé", "rose wine", "rose", "allee bleue", "rosato", "blush"], not: ["rosemary"], path: "/ai_images/rose_wine.jpg" },
  { match: ["syrah", "primitivo", "cabernet", "merlot", "shiraz", "pinot noir", "malbec", "tempranillo", "chianti", "rioja"], path: "/ai_images/red_wine_bottle.jpg" },
  { match: ["wine", "red wine"], not: ["glasses", "glassware"], path: "/ai_images/red_wine_glass.jpg" },
  { match: ["coca-cola", "coca cola", "coke"], path: "/ai_images/coke_bottle.png" },
  { match: ["fanta", "sprite", "stoney", "krest"], path: "/ai_images/fanta_glass.jpg" },
  { match: ["fresh juice", "juice"], not: ["vape", "e-liquid", "vaping"], path: "/ai_images/fresh_juice.jpg" },
  { match: ["mineral water", "water", "aqua", "dasani"], not: ["watermelon", "tonic", "watercress"], path: "/ai_images/mineral_water.jpg" },
  { match: ["nyama choma", "choma", "roasted meat", "goat ribs", "pork ribs", "mbuzi"], path: "/ai_images/nyama_choma.jpg" },
  { match: ["chicken", "kuku", "grilled chicken", "wings"], path: "/ai_images/grilled_chicken.jpg" },
  { match: ["pilau", "biryani", "fried rice", "rice"], not: ["rolling pin", "price"], path: "/ai_images/pilau_rice.jpg" },
  { match: ["fish", "tilapia", "omena", "fillet", "samaki"], not: ["safisha"], path: "/ai_images/fish_chips.jpg" },
  { match: ["ugali", "beef stew", "stew", "sukuma", "managu"], not: ["beans"], path: "/ai_images/ugali_nyama.jpg" },
  { match: ["samosa", "sambusa"], path: "/ai_images/beef_samosas.jpg" },
];

/** The picture for this product name, or null when no rule claims it. */
export function imageForName(name: unknown): string | null {
  const lower = String(name ?? "").toLowerCase();
  if (!lower) return null;
  for (const rule of IMAGE_RULES) {
    if (rule.not?.some((word) => lower.includes(word))) continue;
    if (rule.match.some((word) => lower.includes(word))) return rule.path;
  }
  return null;
}
