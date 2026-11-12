import type { ReturnFact } from "./returns.ts";

/**
 * Exact check of a customer return against the order, before anyone refunds:
 * how many units of each position came back compared with what was ordered and
 * shipped, and which amount fits the return (goods value, shipping costs, order
 * total, credit notes and marketplace refunds already made).
 *
 * Built only from the ERP snapshot (weclapp) and refund notices in the inbox.
 * The result is a hint for a person: SupportX never refunds by itself, and the
 * check never decides who pays the return shipping (merchant terms, not in weclapp).
 */

/** The parts of an order snapshot this module reads (structural, so the browser bundle needs no server types). */
export interface ReturnCheckOrder {
  lines: ReadonlyArray<{ id: string; title?: string; articleId?: string; quantity: number; shippedQuantity?: number; returnedQuantity?: number; grossAmount?: number }>;
  shipments: ReadonlyArray<{ items: ReadonlyArray<{ orderLineId?: string; quantity: number }> }>;
  invoices: ReadonlyArray<{ id: string; invoiceNumber?: string; type?: string; grossAmount?: number; shippingGrossAmount?: number }>;
  returns?: ReadonlyArray<ReturnFact>;
  grossAmount?: number;
  shippingGrossAmount?: number;
  currency?: string;
  amountsRead?: boolean;
}

/** A marketplace notice that a refund was issued, e.g. Amazon "18.30 EUR Rückerstattung veranlasst – …". */
export interface RefundNoticeAmount {
  amount: number;
  currency?: string;
  subject: string;
}

export type CheckTone = "good" | "warn" | "bad" | "neutral";

export interface ReturnLineCheck {
  lineId: string;
  title: string;
  ordered: number;
  /** Shipped according to weclapp (order line, else shipment items); undefined when unknown. */
  shipped?: number;
  /** In active returns that are not booked in yet. */
  announced: number;
  /** In returns booked in (moved into store). */
  received: number;
  /** returnedQuantity on the order line in weclapp. */
  erpReturned?: number;
  /** Value of one unit incl. VAT (line gross / quantity, incl. a share of an order discount). */
  unitGross?: number;
}

export interface ReturnFinding {
  code:
    | "foreign_item"
    | "more_than_ordered"
    | "more_than_shipped"
    | "duplicate_return"
    | "erp_quantity_mismatch"
    | "partial"
    | "complete"
    | "over_credited"
    | "shipping_missing"
    | "shipping_on_partial"
    | "credit_higher"
    | "credit_lower"
    | "credit_matches"
    | "amounts_unknown";
  tone: CheckTone;
  text: string;
}

export interface ReturnAmounts {
  currency?: string;
  /** Value of the received units incl. VAT. */
  goods: number;
  /** Shipping costs charged on the order incl. VAT. */
  shipping: number;
  /** goods, plus shipping when everything shipped came back. */
  expected: number;
  /** Order total: more can never be refunded. */
  maximum: number;
  /** Sum of credit notes in weclapp. */
  credited: number;
  /** Shipping cost items on the credit notes. */
  creditedShipping: number;
  /** Refunds announced by marketplace notices. */
  noticed: number;
}

export interface ReturnCheck {
  /** False when there is no active return and nothing returned: nothing to check. */
  applicable: boolean;
  tone: CheckTone;
  lines: ReturnLineCheck[];
  findings: ReturnFinding[];
  /** Every shipped (or ordered) unit is back. */
  complete: boolean;
  receivedUnits: number;
  /** Units the received quantity is compared with: shipped, or ordered when shipping is unknown. */
  baseUnits: number;
  amounts?: ReturnAmounts;
}

const CENT = 0.01;
const round = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) < CENT + 1e-9;

export function formatMoney(amount: number, currency?: string): string {
  const s = round(amount).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return currency === "EUR" || !currency ? `${s} €` : `${s} ${currency}`;
}

/**
 * Amount and currency in the subject of a refund notice ("18.30 EUR Rückerstattung veranlasst",
 * "Rückerstattung über 18,30 € veranlasst"). Undefined when the subject names no amount.
 */
export function refundNoticeAmount(subject: string | null | undefined): RefundNoticeAmount | undefined {
  if (!subject) return undefined;
  const m = /(?:(EUR|€)\s*)?(\d{1,6}(?:[.,]\d{3})*[.,]\d{2})(?:\s*(EUR|€))?/i.exec(subject);
  if (!m || !(m[1] || m[3])) return undefined;
  const raw = m[2]!;
  // The last separator is the decimal one; others are thousands separators.
  const amount = Number(raw.slice(0, -3).replace(/[.,]/g, "") + "." + raw.slice(-2));
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: "EUR", subject } : undefined;
}

const RECEIVED = "INCOMING_MOVED_INTO_STORE";

function shippedOf(order: ReturnCheckOrder, lineId: string, lineShipped: number | undefined): number | undefined {
  if (lineShipped !== undefined) return lineShipped;
  const items = order.shipments.flatMap((s) => s.items).filter((i) => i.orderLineId === lineId);
  return items.length ? items.reduce((sum, i) => sum + i.quantity, 0) : undefined;
}

export function returnCheck(order: ReturnCheckOrder, notices: ReadonlyArray<RefundNoticeAmount> = []): ReturnCheck {
  const findings: ReturnFinding[] = [];
  const active = (order.returns ?? []).filter((r) => r.erpStatus !== "INCOMING_CANCELLED");
  const lines: ReturnLineCheck[] = order.lines.map((l) => ({
    lineId: l.id,
    title: l.title ?? "Position",
    ordered: l.quantity,
    ...(shippedOf(order, l.id, l.shippedQuantity) !== undefined ? { shipped: shippedOf(order, l.id, l.shippedQuantity) } : {}),
    announced: 0,
    received: 0,
    ...(l.returnedQuantity !== undefined ? { erpReturned: l.returnedQuantity } : {}),
  }));
  const byId = new Map(lines.map((l) => [l.lineId, l]));
  const byArticle = new Map<string, ReturnLineCheck[]>();
  order.lines.forEach((l, i) => {
    if (l.articleId) byArticle.set(l.articleId, [...(byArticle.get(l.articleId) ?? []), lines[i]!]);
  });
  /** Which returns contain a line: two active returns for the same units are a likely duplicate. */
  const returnsPerLine = new Map<string, Set<string>>();

  for (const ret of active) {
    const isReceived = ret.erpStatus === RECEIVED;
    for (const item of ret.items) {
      if (item.quantity <= 0) continue;
      let line = item.orderLineId ? byId.get(item.orderLineId) : undefined;
      if (!line && item.articleId) {
        const candidates = byArticle.get(item.articleId) ?? [];
        if (candidates.length === 1) line = candidates[0];
      }
      if (!line) {
        findings.push({
          code: "foreign_item",
          tone: "bad",
          text: `Retoure ${ret.returnNumber ?? ret.id} enthält ${item.quantity} × „${item.title ?? "unbekannte Position"}“, das nicht zu dieser Bestellung gehört. Falscher Artikel zurück oder falsch gebucht?`,
        });
        continue;
      }
      if (isReceived) line.received += item.quantity;
      else line.announced += item.quantity;
      returnsPerLine.set(line.lineId, (returnsPerLine.get(line.lineId) ?? new Set()).add(ret.returnNumber ?? ret.id));
    }
  }

  // Returned quantity on the order line without any return record (booked in weclapp directly, or a snapshot taken before returns were read).
  const recordsRead = order.returns !== undefined;
  if (active.length === 0) {
    for (const l of lines) if (l.erpReturned) l.received = l.erpReturned;
  }

  for (const l of lines) {
    const inReturns = l.received + l.announced;
    const numbers = [...(returnsPerLine.get(l.lineId) ?? [])];
    if (inReturns > l.ordered) {
      findings.push({
        code: numbers.length > 1 ? "duplicate_return" : "more_than_ordered",
        tone: "bad",
        text: `„${l.title}“: bestellt ${l.ordered}, in Retouren ${inReturns}${numbers.length > 1 ? ` (${numbers.join(", ")}). Ist die Retoure doppelt angelegt?` : "."} Höchstens ${l.ordered} Stück erstatten.`,
      });
    } else if (l.shipped !== undefined && l.received > l.shipped) {
      findings.push({
        code: "more_than_shipped",
        tone: "bad",
        text: `„${l.title}“: ${l.received} Stück als eingegangen gebucht, versendet wurden laut weclapp aber nur ${l.shipped}.`,
      });
    }
    if (recordsRead && active.length > 0 && l.erpReturned !== undefined && (l.erpReturned > inReturns || l.erpReturned < l.received)) {
      findings.push({
        code: "erp_quantity_mismatch",
        tone: "warn",
        text: `„${l.title}“: am Auftrag stehen ${l.erpReturned} Stück als retourniert, in den Retouren ${l.received} eingegangen${l.announced ? ` und ${l.announced} angemeldet` : ""}. Bitte in weclapp abgleichen.`,
      });
    }
  }

  // Compared with what was shipped; when weclapp records no shipped units at all, with what was ordered.
  const shippingKnown = lines.some((l) => (l.shipped ?? 0) > 0);
  const base = (l: ReturnLineCheck) => (shippingKnown && l.shipped !== undefined ? Math.min(l.shipped, l.ordered) : l.ordered);
  const receivedUnits = lines.reduce((sum, l) => sum + Math.min(l.received, l.ordered), 0);
  const baseUnits = lines.reduce((sum, l) => sum + base(l), 0);
  const applicable = active.length > 0 || lines.some((l) => l.received > 0) || findings.length > 0;
  const complete = receivedUnits > 0 && lines.every((l) => Math.min(l.received, l.ordered) >= base(l));

  if (receivedUnits > 0) {
    if (complete) {
      findings.push({ code: "complete", tone: "good", text: `Vollständige Rücksendung: alle ${baseUnits} Stück sind zurück.` });
    } else {
      const missing = lines
        .map((l) => ({ l, open: base(l) - Math.min(l.received, l.ordered) }))
        .filter((x) => x.open > 0)
        .map((x) => `${x.open} × „${x.l.title}“`);
      findings.push({
        code: "partial",
        tone: "warn",
        text: `Teilretoure: ${receivedUnits} von ${baseUnits} Stück zurück. Nicht zurück: ${missing.join(", ")}. Nur die zurückgekommenen Artikel erstatten.`,
      });
    }
  }

  const amounts = receivedUnits > 0 ? amountsOf(order, lines, complete, notices, findings) : undefined;
  const tone: CheckTone = findings.some((f) => f.tone === "bad") ? "bad" : findings.some((f) => f.tone === "warn") ? "warn" : findings.some((f) => f.tone === "good") ? "good" : "neutral";
  return { applicable, tone, lines, findings, complete, receivedUnits, baseUnits, ...(amounts ? { amounts } : {}) };
}

function amountsOf(order: ReturnCheckOrder, lines: ReturnLineCheck[], complete: boolean, notices: ReadonlyArray<RefundNoticeAmount>, findings: ReturnFinding[]): ReturnAmounts | undefined {
  if (!order.amountsRead || order.grossAmount === undefined) {
    findings.push({ code: "amounts_unknown", tone: "neutral", text: "Beträge sind in diesem Abruf nicht enthalten. „Neu aus weclapp abrufen“ liest Preise und Versandkosten." });
    return undefined;
  }
  const shipping = round(order.shippingGrossAmount ?? 0);
  const lineTotal = order.lines.reduce((sum, l) => sum + (l.grossAmount ?? 0), 0);
  // An order discount (headerDiscount) lowers the order total, not the line amounts: spread it over the lines.
  const factor = lineTotal > 0 && order.grossAmount - shipping < lineTotal - CENT ? Math.max(0, (order.grossAmount - shipping) / lineTotal) : 1;
  let goods = 0;
  for (const [i, l] of order.lines.entries()) {
    const check = lines[i]!;
    if (l.grossAmount === undefined || l.quantity <= 0) continue;
    check.unitGross = round((l.grossAmount * factor) / l.quantity);
    goods += (l.grossAmount * factor * Math.min(check.received, l.quantity)) / l.quantity;
  }
  goods = round(goods);
  const maximum = round(order.grossAmount);
  const expected = round(Math.min(maximum, goods + (complete ? shipping : 0)));
  const credits = order.invoices.filter((inv) => inv.type === "CREDIT_NOTE");
  const credited = round(credits.reduce((sum, c) => sum + Math.abs(c.grossAmount ?? 0), 0));
  const creditedShipping = round(credits.reduce((sum, c) => sum + Math.abs(c.shippingGrossAmount ?? 0), 0));
  const noticed = round(notices.reduce((sum, n) => sum + n.amount, 0));
  const money = (n: number) => formatMoney(n, order.currency);

  const compare = (paid: number, what: string) => {
    if (paid > maximum + CENT) {
      findings.push({ code: "over_credited", tone: "bad", text: `${what} ${money(paid)} ist höher als die ganze Bestellung (${money(maximum)}). Zu viel erstattet?` });
    } else if (close(paid, expected)) {
      findings.push({ code: "credit_matches", tone: "good", text: `${what} ${money(paid)} passt zur Retoure${complete && shipping > 0 ? " (Ware und Versandkosten)" : ""}.` });
    } else if (complete && shipping > 0 && close(paid, goods)) {
      findings.push({ code: "shipping_missing", tone: "warn", text: `${what} ${money(paid)} enthält die Versandkosten von ${money(shipping)} nicht. Bei einer vollständigen Rücksendung werden sie üblicherweise mit erstattet (beim Widerruf gesetzlich).` });
    } else if (!complete && shipping > 0 && close(paid, goods + shipping)) {
      findings.push({ code: "shipping_on_partial", tone: "warn", text: `${what} ${money(paid)} enthält die Versandkosten von ${money(shipping)}, obwohl nur ein Teil zurückkam. Bitte prüfen, ob das so gewollt ist.` });
    } else if (paid > expected) {
      findings.push({ code: "credit_higher", tone: "warn", text: `${what} ${money(paid)} ist höher als der Wert der zurückgekommenen Ware (${money(expected)}).` });
    } else {
      findings.push({ code: "credit_lower", tone: "warn", text: `${what} ${money(paid)} ist niedriger als der Wert der zurückgekommenen Ware (${money(expected)}). Rücksendekosten oder Wertminderung abgezogen? Bitte prüfen.` });
    }
  };
  if (credits.length > 0) compare(credited, credits.length > 1 ? `Gutschriften (${credits.map((c) => c.invoiceNumber ?? c.id).join(", ")}) zusammen` : `Gutschrift ${credits[0]!.invoiceNumber ?? credits[0]!.id}`);
  if (notices.length > 0) compare(noticed, notices.length > 1 ? "Marktplatz-Erstattungen zusammen" : "Marktplatz-Erstattung");
  return { ...(order.currency ? { currency: order.currency } : {}), goods, shipping, expected, maximum, credited, creditedShipping, noticed };
}
