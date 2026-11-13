import { isRefundNotice } from "./refund-due.ts";

/**
 * The refund list ("Erstattungen"): every case where a refund was decided or a
 * marketplace reports one, grouped per order, so a person can work through the
 * credit notes in the ERP and tick off what is done there.
 *
 * SupportX never refunds and never writes to the ERP: the tick only records
 * that a person says it is done.
 */

const REFUND_OUTCOMES = new Set(["refund", "partial_refund"]);

/** A case that may belong on the list, with what is stored for it. */
export interface RefundCandidate {
  conversationId: string;
  subject: string | null;
  platform: string;
  customerName: string | null;
  customerAddress: string | null;
  outcome: string | null;
  outcomeNote: string | null;
  outcomeAt: string | null;
  lastMessageAt: string | null;
  /** Order numbers the customer or the marketplace wrote. */
  orderReferences: ReadonlyArray<{ value: string; kind?: string }>;
  /** Matched ERP order (only when unique). */
  externalOrderId: string | null;
  order: {
    orderNumber?: string;
    orderNumberAtCustomer?: string;
    lines?: ReadonlyArray<{ title: string; quantity: number; returnedQuantity?: number }>;
    invoices?: ReadonlyArray<{ id: string; invoiceNumber?: string; invoiceDate?: string; type?: string }>;
    returns?: ReadonlyArray<{ erpStatus?: string; items: ReadonlyArray<{ title?: string; quantity: number }> }>;
  } | null;
  entry: {
    addedManually: boolean;
    removed: boolean;
    amountCents: number | null;
    currency: string | null;
    note: string | null;
    creditNoteNumber: string | null;
    doneAt: string | null;
    doneByName: string | null;
    updatedAt: string | null;
  } | null;
}

export type RefundSource = "outcome" | "notice" | "manual";

export interface RefundListItem {
  /** Stable key of the group: the first case id. */
  key: string;
  conversationIds: string[];
  cases: Array<{ id: string; subject: string | null; platform: string; source: RefundSource; at: string | null }>;
  orderNumber: string | null;
  /** ERP order id for the link to the order in weclapp. */
  externalOrderId: string | null;
  marketplaceOrderNumber: string | null;
  customer: string | null;
  platform: string;
  /** "partial" when a case says "Teilweise erstattet". */
  kind: "full" | "partial" | "unknown";
  amount: { cents: number; currency: string; from: "entered" | "notice" } | null;
  items: Array<{ title: string; quantity: number }>;
  /** Where the items come from: the return in the ERP or the whole order. */
  itemsFrom: "return" | "order" | null;
  /** Credit notes already in the ERP snapshot: a hint, not a tick. */
  creditNotes: string[];
  note: string | null;
  since: string | null;
  done: { at: string; by: string | null; creditNoteNumber: string | null } | null;
}

/** Why a case is on the list, or null when it is not. */
export function refundSource(c: Pick<RefundCandidate, "outcome" | "subject" | "entry">): RefundSource | null {
  if (c.entry?.removed) return null;
  if (c.outcome && REFUND_OUTCOMES.has(c.outcome)) return "outcome";
  if (isRefundNotice(c.subject)) return "notice";
  if (c.entry?.addedManually) return "manual";
  return null;
}

const CURRENCY: Record<string, string> = { "€": "EUR", eur: "EUR", euro: "EUR", "£": "GBP", gbp: "GBP", chf: "CHF", "$": "USD", usd: "USD", pln: "PLN", sek: "SEK" };

/** "12,50" / "12.50" / "1.234,56" / "1,234.56" → cents. */
function toCents(raw: string): number | null {
  let s = raw.replace(/\s/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const dec = Math.max(lastComma, lastDot);
  if (dec >= 0 && s.length - dec - 1 <= 2 && s.length - dec - 1 > 0) {
    s = `${s.slice(0, dec).replace(/[.,]/g, "")}.${s.slice(dec + 1)}`;
  } else {
    s = s.replace(/[.,]/g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}

/**
 * Amount in a marketplace refund notice, e.g. Amazon
 * "18.30 EUR Rückerstattung veranlasst – Bestellung …" or "Rückerstattung über 12,50 €".
 */
export function parseNoticeAmount(subject: string | null | undefined): { cents: number; currency: string } | null {
  if (!subject || !isRefundNotice(subject)) return null;
  const m = subject.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|\d+(?:[.,]\d{1,2})?)\s*(EUR|€|GBP|£|CHF|USD|\$|PLN|SEK)/i)
    ?? subject.match(/(EUR|€|GBP|£|CHF|USD|\$|PLN|SEK)\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|\d+(?:[.,]\d{1,2})?)/i);
  if (!m) return null;
  const [num, cur] = /\d/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
  const cents = toCents(num);
  const currency = CURRENCY[cur.toLowerCase()] ?? cur.toUpperCase();
  return cents === null ? null : { cents, currency };
}

/** What a person typed as amount ("12,50", "12.50 €", ""), null for empty, undefined for invalid. */
export function parseAmountInput(text: string): number | null | undefined {
  const t = text.trim().replace(/\s*(€|eur)$/i, "");
  if (!t) return null;
  return toCents(t) ?? undefined;
}

export function formatAmount(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

const norm = (v: string) => v.trim().toLowerCase();

/** Order keys of a case: the ERP order and every order number known. */
function keysOf(c: RefundCandidate): string[] {
  const keys = new Set<string>();
  if (c.externalOrderId) keys.add(`erp:${c.externalOrderId}`);
  for (const n of [c.order?.orderNumber, c.order?.orderNumberAtCustomer]) if (n?.trim()) keys.add(`no:${norm(n)}`);
  for (const r of c.orderReferences) if ((r.kind ?? "order") === "order" && r.value.trim()) keys.add(`no:${norm(r.value)}`);
  return [...keys];
}

/** Items to refund: what came back in the ERP return, otherwise the order lines. */
function itemsOf(order: RefundCandidate["order"]): { items: Array<{ title: string; quantity: number }>; from: "return" | "order" | null } {
  if (!order) return { items: [], from: null };
  const returned = (order.returns ?? []).filter((r) => r.erpStatus !== "INCOMING_CANCELLED").flatMap((r) => r.items).filter((i) => i.title);
  if (returned.length) return { items: returned.map((i) => ({ title: i.title!, quantity: i.quantity })), from: "return" };
  const back = (order.lines ?? []).filter((l) => (l.returnedQuantity ?? 0) > 0);
  if (back.length) return { items: back.map((l) => ({ title: l.title, quantity: l.returnedQuantity! })), from: "return" };
  const lines = order.lines ?? [];
  return lines.length ? { items: lines.map((l) => ({ title: l.title, quantity: l.quantity })), from: "order" } : { items: [], from: null };
}

/** A marketplace notice arrives by mail; an Amazon order number tells the marketplace. */
function platformOf(platform: string, numbers: ReadonlyArray<string>): string {
  return platform === "email" && numbers.some((n) => /^\d{3}-\d{7}-\d{7}$/.test(n.trim())) ? "amazon" : platform;
}

const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);

/**
 * Groups the cases on the list per order: a customer case "Erstattet" and the
 * marketplace notice for the same order are one refund, so it is not done twice.
 * Cases without any order number stay on their own.
 */
export function groupRefunds(candidates: ReadonlyArray<RefundCandidate>): RefundListItem[] {
  const rows = candidates.map((c) => ({ c, source: refundSource(c) })).filter((r): r is { c: RefundCandidate; source: RefundSource } => r.source !== null);
  // Union-find over shared order keys.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  rows.forEach((r, i) => {
    for (const k of keysOf(r.c)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, typeof rows>();
  rows.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));

  const items: RefundListItem[] = [];
  for (const members of groups.values()) {
    // The case with the ERP order first, then the oldest.
    members.sort((a, b) => Number(!!b.c.order) - Number(!!a.c.order) || (a.c.lastMessageAt ?? "").localeCompare(b.c.lastMessageAt ?? ""));
    const withOrder = members.find((m) => m.c.order)?.c ?? null;
    const first = members[0]!.c;
    const entries = members.map((m) => m.c.entry).filter((e): e is NonNullable<RefundCandidate["entry"]> => !!e);
    const entered = entries.filter((e) => e.amountCents !== null).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
    const notice = members.map((m) => parseNoticeAmount(m.c.subject)).find((a) => a);
    const done = entries.filter((e) => e.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!))[0];
    const { items: lineItems, from } = itemsOf(withOrder?.order ?? null);
    const outcomes = members.map((m) => m.c.outcome);
    const numbers = members.flatMap((m) => m.c.orderReferences.filter((r) => (r.kind ?? "order") === "order").map((r) => r.value));
    const note = entries.map((e) => e.note).find((n) => n) ?? members.map((m) => m.c.outcomeNote).find((n) => n) ?? null;
    let since: string | null = null;
    for (const m of members) since = earliest(since, m.c.outcomeAt ?? m.c.lastMessageAt);
    let last: string | null = null;
    for (const m of members) last = latest(last, m.c.lastMessageAt);
    items.push({
      key: [...members].map((m) => m.c.conversationId).sort()[0]!,
      conversationIds: members.map((m) => m.c.conversationId),
      cases: members.map((m) => ({ id: m.c.conversationId, subject: m.c.subject, platform: m.c.platform, source: m.source, at: m.c.lastMessageAt })),
      orderNumber: withOrder?.order?.orderNumber ?? null,
      externalOrderId: withOrder?.externalOrderId ?? null,
      marketplaceOrderNumber: withOrder?.order?.orderNumberAtCustomer ?? numbers.find((n) => n !== withOrder?.order?.orderNumber) ?? null,
      // A marketplace notice comes from the marketplace, not from the customer.
      customer: members.filter((m) => m.source !== "notice").map((m) => m.c.customerName || m.c.customerAddress).find((n) => n) ?? null,
      platform: platformOf((members.find((m) => m.source !== "notice") ?? members[0]!).c.platform ?? first.platform, numbers),
      kind: outcomes.includes("partial_refund") ? "partial" : outcomes.includes("refund") ? "full" : "unknown",
      amount: entered ? { cents: entered.amountCents!, currency: entered.currency ?? "EUR", from: "entered" } : notice ? { ...notice, from: "notice" } : null,
      items: lineItems,
      itemsFrom: from,
      creditNotes: (withOrder?.order?.invoices ?? []).filter((i) => i.type === "CREDIT_NOTE").map((i) => i.invoiceNumber ?? i.id),
      note,
      since: since ?? last,
      done: done ? { at: done.doneAt!, by: done.doneByName, creditNoteNumber: done.creditNoteNumber } : null,
    });
  }
  // Open: oldest first (work through them). Done: last ticked first.
  return items.sort((a, b) =>
    (a.done ? 1 : 0) - (b.done ? 1 : 0)
    || (a.done && b.done ? b.done.at.localeCompare(a.done.at) : (a.since ?? "").localeCompare(b.since ?? "")));
}
