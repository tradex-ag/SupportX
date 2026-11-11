import { returnSummary, type ReturnOrderInput, type ReturnSummary } from "./returns.ts";

/**
 * Is a refund for this order now up to us? Built from the ERP snapshot (the
 * return is booked in as received) and from what is already known about a
 * refund: a credit note in the ERP, a case outcome "Erstattet", or a
 * marketplace notice that a refund was issued for the same order.
 *
 * "due" is only a hint for a person: SupportX never refunds by itself.
 */
export type RefundDueState =
  /** Goods are back, no sign of a refund yet: the refund is to be done. */
  | "due"
  /** Goods are back and a refund is already recorded somewhere. */
  | "done"
  /** Nothing to do from the goods' side (no return, not yet received, unknown). */
  | "none";

export interface RefundSignal {
  /** Where the sign comes from, shown to the person. */
  source: "credit_note" | "outcome" | "notice";
  /** Short German text, e.g. "Gutschrift GS-1 in weclapp". */
  text: string;
  at?: string;
}

/** Another case about the same order (same order number or same ERP order). */
export interface RelatedRefundCase {
  subject: string | null;
  outcome: string | null;
  last_message_at?: string | Date | null;
}

export interface RefundDue {
  state: RefundDueState;
  /** One line for the button area / list, German. Empty for "none". */
  headline: string;
  signals: RefundSignal[];
}

const REFUND_OUTCOMES = new Set(["refund", "partial_refund"]);

/**
 * Subjects of marketplace notices saying a refund was issued, e.g. Amazon
 * "18.30 EUR Rückerstattung veranlasst – Bestellung …" or "Refund initiated".
 * A customer asking for a refund ("Bitte um Erstattung") does not match.
 */
const REFUND_NOTICE = /(rück)?erstattung\s+(veranlasst|durchgeführt|erfolgt|ausgeführt|abgeschlossen)|refund\s+(initiated|issued|processed|completed)|remboursement\s+(effectué|initié)/i;

export function isRefundNotice(subject: string | null | undefined): boolean {
  return !!subject && REFUND_NOTICE.test(subject);
}

function day(iso: string | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}.${m}.${y}` : "";
}

const iso = (v: string | Date | null | undefined): string | undefined => (v instanceof Date ? v.toISOString() : v ?? undefined);

export function refundDue(input: {
  order: ReturnOrderInput | null | undefined;
  /** Outcome recorded on this case ("Was wurde danach gemacht?"). */
  outcome?: string | null;
  /** Subject of this case: a refund notice itself is a sign of a refund. */
  subject?: string | null;
  /** Other cases about the same order, including marketplace notices. */
  related?: ReadonlyArray<RelatedRefundCase>;
}): RefundDue {
  if (!input.order) return { state: "none", headline: "", signals: [] };
  const rs: ReturnSummary = returnSummary(input.order);
  if (rs.state !== "received") return { state: "none", headline: "", signals: [] };

  const signals: RefundSignal[] = [];
  for (const cn of rs.creditNotes) {
    signals.push({ source: "credit_note", text: `Gutschrift ${cn.invoiceNumber ?? cn.id} in weclapp`, ...(cn.invoiceDate ? { at: cn.invoiceDate } : {}) });
  }
  if (input.outcome && REFUND_OUTCOMES.has(input.outcome)) {
    signals.push({ source: "outcome", text: input.outcome === "partial_refund" ? "In diesem Fall als „Teilweise erstattet“ erfasst" : "In diesem Fall als „Erstattet“ erfasst" });
  }
  if (isRefundNotice(input.subject)) signals.push({ source: "notice", text: `Dieser Fall ist die Meldung „${input.subject}“` });
  for (const r of input.related ?? []) {
    const at = iso(r.last_message_at);
    if (r.outcome && REFUND_OUTCOMES.has(r.outcome)) {
      signals.push({ source: "outcome", text: `Anderer Fall zur Bestellung als erstattet erfasst${r.subject ? `: „${r.subject}“` : ""}`, ...(at ? { at } : {}) });
    } else if (isRefundNotice(r.subject)) {
      signals.push({ source: "notice", text: `Meldung „${r.subject}“`, ...(at ? { at } : {}) });
    }
  }

  const label = rs.label;
  if (signals.length > 0) {
    return { state: "done", headline: `Erstattung schon erfasst (${label}): ${signals.map((s) => s.text + (s.at ? ` vom ${day(s.at)}` : "")).join("; ")}.`, signals };
  }
  return { state: "due", headline: `Erstattung ist jetzt zu machen: ${label}.`, signals };
}
