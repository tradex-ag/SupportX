/**
 * Plausibility check between what the customer says, the title on the order and
 * the article in the ERP. Pack sizes (g, ml, Stück …) and colours are compared;
 * a mismatch is a hint for a person ("mögliche Falschlieferung"), never a verdict.
 */

export interface TitleLine {
  position?: number;
  /** Title on the order position (often the marketplace title from the import). */
  title: string;
  /** Article name in the ERP, when known. */
  articleName?: string;
  /** Ordered quantity of this position. */
  quantity?: number;
}

export interface TitleHint {
  kind: "customer_vs_order" | "order_vs_article" | "quantity";
  text: string;
}

const UNIT: Record<string, { unit: string; factor: number }> = {
  mg: { unit: "mg", factor: 1 },
  g: { unit: "g", factor: 1 },
  gr: { unit: "g", factor: 1 },
  gramm: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 },
  cl: { unit: "ml", factor: 10 },
  l: { unit: "ml", factor: 1000 },
  liter: { unit: "ml", factor: 1000 },
  stk: { unit: "Stück", factor: 1 },
  "stück": { unit: "Stück", factor: 1 },
  kps: { unit: "Stück", factor: 1 },
  kapseln: { unit: "Stück", factor: 1 },
  tabletten: { unit: "Stück", factor: 1 },
  tbl: { unit: "Stück", factor: 1 },
};

const SIZE = /(\d+(?:[.,]\d+)?)\s*(mg|kg|gramm|gr|g|ml|cl|liter|l|stk|stück|kps|kapseln|tabletten|tbl)(?![a-zäöüß])/giu;

/** Normalised pack sizes in a text, e.g. "70 g", "1200 ml". */
export function sizesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SIZE)) {
    const u = UNIT[m[2]!.toLowerCase()];
    if (!u) continue;
    const value = Math.round(Number(m[1]!.replace(",", ".")) * u.factor * 1000) / 1000;
    out.add(`${String(value).replace(".", ",")} ${u.unit}`);
  }
  return [...out];
}

const COLOURS = ["schwarz", "weiß", "weiss", "grau", "rot", "rosa", "pink", "orange", "gelb", "grün", "blau", "türkis", "lila", "violett", "braun", "beige", "gold", "silber"];

/** Colour words (also inflected: "grüne", "braunen"). */
export function coloursOf(text: string): string[] {
  const lower = text.toLowerCase();
  return COLOURS.filter((c) => new RegExp(`(^|[^a-zäöüß])${c}(e|en|er|es|em)?(?![a-zäöüß])`, "u").test(lower)).map((c) => (c === "weiss" ? "weiß" : c));
}

const SIZE_UNIT = "(?:mg|kg|gramm|gr|g|ml|cl|liter|l|stk|stück|kps|kapseln|tabletten|tbl)";
const NUMBER_WORDS: Record<string, number> = { zwei: 2, drei: 3, vier: 4, "fünf": 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, zwölf: 12 };
const MULTIPLIER = new RegExp(`(?<![\\d.,a-zäöüß])(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})\\s*(?:x|×|mal)\\s*(\\d+(?:[.,]\\d+)?\\s*${SIZE_UNIT})(?![a-zäöüß])`, "iu");
const PACK = new RegExp(`(?<![\\d.,])(\\d{1,2})er[\\s-]?(?:pack|packung|set|vorteilspack|karton)|(doppelpack|doppelpackung)`, "iu");
const CONTAINERS = new RegExp(`(?<![\\d.,])(\\d{1,2})\\s*(?:flaschen|dosen|gläser|packungen|tuben|beutel|packs)(?![a-zäöüß])`, "iu");

/**
 * How many units a text names: "2 x 100 ml" → 2, "3er-Pack" → 3, "Doppelpack" → 2
 * and, with `containers`, "6 Flaschen" → 6. Undefined when the text names no count.
 */
export function packCountOf(text: string, opts: { containers?: boolean } = {}): number | undefined {
  const m = MULTIPLIER.exec(text);
  if (m) return NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
  const p = PACK.exec(text);
  if (p) return p[2] ? 2 : Number(p[1]);
  if (opts.containers) {
    const c = CONTAINERS.exec(text);
    if (c) return Number(c[1]);
  }
  return undefined;
}

/** The count and pack size the customer names, e.g. "2 x 100 ml" → { count: 2, size: "100 ml" }. */
export function claimedCountOf(text: string): { count: number; size: string; said: string } | undefined {
  const m = MULTIPLIER.exec(text);
  if (!m) return undefined;
  const size = sizesOf(m[2]!)[0];
  if (!size) return undefined;
  return { count: NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]), size, said: m[0]!.replace(/\s+/g, " ").trim() };
}

/** Units of one pack size in the order: quantity × pack count of the ERP article (or else of the order title). */
function unitsOfSize(lines: ReadonlyArray<TitleLine>, size: string): number | undefined {
  let units = 0;
  let found = false;
  for (const line of lines) {
    const erp = line.articleName && sizesOf(line.articleName).length ? line.articleName : undefined;
    const text = erp ?? line.title;
    if (!sizesOf(text).includes(size)) continue;
    if (line.quantity === undefined) return undefined;
    found = true;
    units += line.quantity * (packCountOf(text, { containers: true }) ?? 1);
  }
  return found ? units : undefined;
}

function list(values: string[]): string {
  return values.join(", ");
}

export function checkTitles(customerText: string, lines: ReadonlyArray<TitleLine>): TitleHint[] {
  const hints: TitleHint[] = [];
  if (lines.length === 0) return hints;
  const orderText = lines.map((l) => `${l.title} ${l.articleName ?? ""}`).join(" ");

  const saidSizes = sizesOf(customerText);
  const orderSizes = sizesOf(orderText);
  const unknownSizes = saidSizes.filter((s) => !orderSizes.includes(s));
  if (orderSizes.length > 0 && unknownSizes.length > 0) {
    hints.push({ kind: "customer_vs_order", text: `Der Kunde nennt ${list(unknownSizes)}, die Bestellung in weclapp enthält ${list(orderSizes)}.` });
  }
  const saidColours = coloursOf(customerText);
  const orderColours = coloursOf(orderText);
  const unknownColours = saidColours.filter((c) => !orderColours.includes(c));
  if (orderColours.length > 0 && unknownColours.length > 0) {
    hints.push({ kind: "customer_vs_order", text: `Der Kunde nennt die Farbe ${list(unknownColours)}, die Bestellung in weclapp enthält ${list(orderColours)}.` });
  }

  // Quantity: "2 x 100 ml" against what the order holds of that size. A difference
  // can mean a wrong offer on the marketplace (title or picture shows more than is sold).
  const claim = claimedCountOf(customerText);
  if (claim) {
    const ordered = unitsOfSize(lines, claim.size);
    if (ordered !== undefined && ordered !== claim.count) {
      hints.push({
        kind: "quantity",
        text: `Der Kunde nennt ${claim.count} × ${claim.size}, laut weclapp sind ${ordered} × ${claim.size} bestellt. Vielleicht zeigt das Angebot auf dem Marktplatz (Titel, Bild, Variante) eine andere Menge, als verkauft wird.`,
      });
    }
  }

  lines.forEach((line, i) => {
    if (!line.articleName || line.articleName.trim() === line.title.trim()) return;
    const titleCount = packCountOf(line.title, { containers: true });
    const articleCount = packCountOf(line.articleName, { containers: true });
    if ((titleCount ?? 1) !== (articleCount ?? 1)) {
      hints.push({
        kind: "quantity",
        text: `Position ${line.position ?? i + 1}: Der Bestelltitel nennt ${titleCount ?? 1} Stück („${line.title}“), der verknüpfte Artikel in weclapp ${articleCount ?? 1} Stück („${line.articleName}“). Vielleicht ist das Angebot auf dem Marktplatz falsch eingestellt oder dem falschen Artikel zugeordnet.`,
      });
      return;
    }
    const a = sizesOf(line.title);
    const b = sizesOf(line.articleName);
    const ca = coloursOf(line.title);
    const cb = coloursOf(line.articleName);
    const sizeDiff = a.length > 0 && b.length > 0 && a.join() !== b.join();
    const colourDiff = ca.length > 0 && cb.length > 0 && ca.join() !== cb.join();
    if (sizeDiff || colourDiff) {
      hints.push({ kind: "order_vs_article", text: `Position ${line.position ?? i + 1}: Bestelltitel „${line.title}“, verknüpfter Artikel in weclapp „${line.articleName}“.` });
    }
  });
  return hints;
}
