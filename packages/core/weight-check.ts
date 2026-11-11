/**
 * Plausibility check between what was ordered and what the parcel weighed.
 *
 * Expected weight = sum of (quantity × article weight) of the shipped items, from
 * the article master data in the ERP. Actual weight = the package weight booked
 * on the shipment (or the sum of its parcels). Packaging always adds weight, so a
 * parcel that is clearly LIGHTER than its contents alone is a strong hint that
 * something is missing. A parcel that fits is no proof that nothing is missing:
 * the carton can weigh as much as a small article.
 *
 * Never guesses: missing article or package weights are reported as such.
 */

export interface WeightLine {
  id: string;
  title: string;
  quantity: number;
  /** Gross weight of one unit in kg (article master data). */
  grossWeightKg?: number;
  /** Net weight of one unit in kg, used only when no gross weight is set. */
  netWeightKg?: number;
}

export interface WeightParcel {
  weightKg?: number;
}

export interface WeightShipment {
  id: string;
  shipmentNumber?: string;
  /** Package weight booked on the shipment, in kg. */
  weightKg?: number;
  items: ReadonlyArray<{ orderLineId?: string; title?: string; quantity: number }>;
  parcels: ReadonlyArray<WeightParcel>;
}

export interface WeightOrder {
  lines: ReadonlyArray<WeightLine>;
  shipments: ReadonlyArray<WeightShipment>;
  /** True once the order was read with weights; older snapshots lack them. */
  weightsRead?: boolean;
}

export type WeightState = "fits" | "too_light" | "too_heavy" | "same_as_articles" | "no_package_weight" | "no_article_weight" | "not_read";

export interface WeightCheck {
  shipmentId?: string;
  shipmentNumber?: string;
  state: WeightState;
  expectedKg?: number;
  actualKg?: number;
  /** actual / expected, rounded to whole percent. */
  percent?: number;
  label: string;
  advice: string;
  tone: "good" | "warn" | "bad" | "neutral";
}

/** Below expected × LIGHT_FACTOR − LIGHT_SLACK_KG the parcel is lighter than its contents alone. */
export const LIGHT_FACTOR = 0.95;
export const LIGHT_SLACK_KG = 0.02;
/** Above expected × HEAVY_FACTOR + HEAVY_SLACK_KG even generous packaging does not explain the weight. */
export const HEAVY_FACTOR = 1.5;
export const HEAVY_SLACK_KG = 1.0;
/** A package weight this close to the article sum was most likely copied from the articles, not weighed. */
export const SAME_KG = 0.002;

export function formatKg(kg: number): string {
  const rounded = Math.round(kg * 1000) / 1000;
  return `${rounded.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} kg`;
}

function round(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}

const SOURCE = "Gewicht laut weclapp: Artikelstamm und das an der Lieferung gebuchte Paketgewicht.";

function packageWeight(s: WeightShipment): { kg?: number; partial: boolean } {
  if (s.weightKg !== undefined && s.weightKg > 0) return { kg: s.weightKg, partial: false };
  const weights = s.parcels.map((p) => p.weightKg).filter((w): w is number => w !== undefined && w > 0);
  if (weights.length === 0) return { partial: false };
  if (weights.length < s.parcels.length) return { partial: true };
  return { kg: weights.reduce((a, b) => a + b, 0), partial: false };
}

export function checkShipmentWeight(order: WeightOrder, shipment: WeightShipment): WeightCheck {
  const base = { shipmentId: shipment.id, shipmentNumber: shipment.shipmentNumber };
  const linesById = new Map(order.lines.map((l) => [l.id, l]));
  // Shipment items say what went into this parcel; without items, the whole order is assumed.
  const items = shipment.items.length
    ? shipment.items.map((i) => ({ line: i.orderLineId ? linesById.get(i.orderLineId) : undefined, title: i.title, quantity: i.quantity }))
    : order.lines.map((l) => ({ line: l as WeightLine | undefined, title: l.title, quantity: l.quantity }));
  const counted = items.filter((i) => i.quantity > 0);
  const missing = counted.filter((i) => !(i.line?.grossWeightKg ?? i.line?.netWeightKg));
  const usesNet = counted.some((i) => i.line && !i.line.grossWeightKg && i.line.netWeightKg);
  const pkg = packageWeight(shipment);

  if (counted.length === 0 || missing.length > 0) {
    const names = [...new Set(missing.map((i) => i.line?.title ?? i.title ?? "Position ohne Artikel"))];
    return {
      ...base,
      state: "no_article_weight",
      ...(pkg.kg !== undefined ? { actualKg: round(pkg.kg) } : {}),
      label: "Gewicht nicht prüfbar",
      advice: `Im Artikelstamm in weclapp fehlt das Gewicht${names.length ? ` für: ${names.join(", ")}` : ""}. Ohne Artikelgewicht lässt sich das Paket nicht abgleichen.`,
      tone: "neutral",
    };
  }
  const expected = round(counted.reduce((sum, i) => sum + i.quantity * (i.line!.grossWeightKg ?? i.line!.netWeightKg!), 0));
  if (pkg.kg === undefined) {
    return {
      ...base,
      state: "no_package_weight",
      expectedKg: expected,
      label: "Kein Paketgewicht",
      advice: pkg.partial
        ? `Soll laut Artikelstamm ${formatKg(expected)}. Nicht für jedes Paket der Lieferung ist in weclapp ein Gewicht gebucht, deshalb kein Abgleich.`
        : `Soll laut Artikelstamm ${formatKg(expected)}. An der Lieferung ist in weclapp kein Paketgewicht gebucht, deshalb kein Abgleich.`,
      tone: "neutral",
    };
  }
  const actual = round(pkg.kg);
  const percent = Math.round((actual / expected) * 100);
  const numbers = { expectedKg: expected, actualKg: actual, percent };
  const basis = usesNet ? " (teils Nettogewicht, ohne Produktverpackung)" : "";

  if (Math.abs(actual - expected) <= SAME_KG) {
    return {
      ...base,
      ...numbers,
      state: "same_as_articles",
      label: "Gewicht nicht gewogen",
      advice: `Das Paketgewicht (${formatKg(actual)}) ist genau die Summe der Artikelgewichte. Es wurde vermutlich aus dem Artikelstamm übernommen und nicht gewogen, deshalb sagt es nichts über den Paketinhalt.`,
      tone: "neutral",
    };
  }
  if (actual < expected * LIGHT_FACTOR - LIGHT_SLACK_KG) {
    return {
      ...base,
      ...numbers,
      state: "too_light",
      label: "Paket zu leicht",
      advice: `Die bestellten Artikel wiegen allein schon ${formatKg(expected)}${basis}, das Paket wog laut weclapp nur ${formatKg(actual)} (etwa ${percent} %), samt Verpackung. Das passt nicht zu einer vollständigen Lieferung und spricht dafür, dass etwas fehlt.`,
      tone: "bad",
    };
  }
  if (actual > expected * HEAVY_FACTOR + HEAVY_SLACK_KG) {
    return {
      ...base,
      ...numbers,
      state: "too_heavy",
      label: "Paket schwerer als erwartet",
      advice: `Die Artikel wiegen ${formatKg(expected)}${basis}, das Paket ${formatKg(actual)}. Mehr als die übliche Verpackung: vielleicht lag mehr oder etwas anderes im Paket, oder das Gewicht ist falsch gebucht.`,
      tone: "warn",
    };
  }
  return {
    ...base,
    ...numbers,
    state: "fits",
    label: "Gewicht passt",
    advice: `Artikel ${formatKg(expected)}${basis}, Paket ${formatKg(actual)} mit Verpackung: passt zu einer vollständigen Lieferung. Ein Beweis, dass nichts fehlt, ist das nicht, weil die Verpackung so viel wiegen kann wie ein kleiner Artikel.`,
    tone: "good",
  };
}

/** One check per shipment; an empty list when nothing was shipped. */
export function weightChecks(order: WeightOrder): WeightCheck[] {
  if (order.shipments.length === 0) return [];
  if (!order.weightsRead) {
    return [{ state: "not_read", label: "Gewicht nicht geprüft", advice: `Diese Bestellung wurde abgerufen, bevor SupportX Gewichte gelesen hat. „Neu aus weclapp abrufen“ prüft es. ${SOURCE}`, tone: "neutral" }];
  }
  return order.shipments.map((s) => checkShipmentWeight(order, s));
}

/** Short hints for the reply writer, only where the weight says something. */
export function weightHints(order: WeightOrder): string[] {
  return weightChecks(order)
    .filter((c) => c.state === "too_light" || c.state === "too_heavy")
    .map((c) => `${c.shipmentNumber ? `Lieferung ${c.shipmentNumber}: ` : ""}${c.advice}`);
}

export const WEIGHT_SOURCE_NOTE = SOURCE;
