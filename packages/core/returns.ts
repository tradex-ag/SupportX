/**
 * A customer return as recorded in the ERP (weclapp: incomingGoods with
 * incomingGoodsType CUSTOMER_RETURN). The status is a booking in the ERP,
 * not a carrier scan.
 */
export interface ReturnFact {
  id: string;
  returnNumber?: string;
  /** NEW, INCOMING_SHIPPED, INCOMING_MOVED_INTO_STORE, INCOMING_CANCELLED (weclapp shipmentStatusType). */
  erpStatus?: string;
  erpStatusAt?: string;
  createdAt?: string;
  statusHistory: ReadonlyArray<{ status: string; at?: string }>;
  items: ReadonlyArray<{ orderLineId?: string; articleId?: string; title?: string; quantity: number; reason?: string }>;
}

/** The parts of an order snapshot this module reads (structural, so the browser bundle needs no server types). */
export interface ReturnOrderInput {
  lines: ReadonlyArray<{ returnedQuantity?: number }>;
  shipments: ReadonlyArray<{ returnLabels?: number }>;
  invoices: ReadonlyArray<CreditNoteInput>;
  returns?: ReadonlyArray<ReturnFact>;
  returnsError?: string;
}

export interface CreditNoteInput {
  id: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  type?: string;
}

/**
 * Return status of an order for the case view: has the customer sent goods back,
 * and is there already a credit note? Built only from the ERP snapshot (weclapp
 * customer returns, returned quantities on the order lines, credit notes).
 * A return label alone never counts as a return.
 */
export type ReturnState =
  /** Snapshot taken before returns were read, or reading failed. */
  | "unknown"
  /** No customer return in weclapp. */
  | "none"
  /** Return created in weclapp, goods not yet booked in. */
  | "announced"
  /** Goods booked in (moved into store) or returned quantity on the order. */
  | "received"
  /** Only cancelled returns. */
  | "cancelled";

export interface ReturnSummary {
  state: ReturnState;
  /** Short label for the chip, German. */
  label: string;
  /** One line what this means for a refund. */
  advice: string;
  tone: "good" | "warn" | "bad" | "neutral";
  returns: ReadonlyArray<ReturnFact>;
  creditNotes: ReadonlyArray<CreditNoteInput>;
  returnedQuantity: number;
  /** Shipments with a return label (no proof that anything was sent back). */
  returnLabels: number;
  error?: string;
}

export const RETURN_STATUS_DE: Readonly<Record<string, string>> = {
  NEW: "angelegt, Ware noch nicht eingegangen",
  INCOMING_SHIPPED: "als Wareneingang erfasst, noch nicht eingelagert",
  INCOMING_MOVED_INTO_STORE: "Ware eingegangen und eingelagert",
  INCOMING_CANCELLED: "storniert",
};

const RECEIVED = new Set(["INCOMING_MOVED_INTO_STORE"]);

function day(iso: string | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** When the goods were booked in: the status date of INCOMING_MOVED_INTO_STORE. */
export function receivedAt(ret: ReturnFact): string | undefined {
  return [...ret.statusHistory].reverse().find((h) => RECEIVED.has(h.status))?.at ?? (ret.erpStatus && RECEIVED.has(ret.erpStatus) ? ret.erpStatusAt : undefined);
}

export function returnSummary(order: ReturnOrderInput): ReturnSummary {
  const creditNotes = order.invoices.filter((i) => i.type === "CREDIT_NOTE");
  const returnedQuantity = order.lines.reduce((sum, l) => sum + (l.returnedQuantity ?? 0), 0);
  const returnLabels = order.shipments.reduce((sum, s) => sum + (s.returnLabels ?? 0), 0);
  const returns = order.returns ?? [];
  const active = returns.filter((r) => r.erpStatus !== "INCOMING_CANCELLED");
  const received = active.filter((r) => r.erpStatus && RECEIVED.has(r.erpStatus));
  const base = { returns, creditNotes, returnedQuantity, returnLabels, ...(order.returnsError ? { error: order.returnsError } : {}) };
  const credit = creditNotes.length
    ? ` Achtung: Gutschrift ${creditNotes.map((c) => c.invoiceNumber ?? c.id).join(", ")} ist schon angelegt, vielleicht wurde bereits erstattet.`
    : "";

  if (received.length > 0 || (returnedQuantity > 0 && order.returns !== undefined && active.length === 0)) {
    const at = received.map(receivedAt).filter(Boolean).sort().at(-1);
    return {
      ...base,
      state: "received",
      label: at ? `Ware zurück (${day(at)})` : "Ware zurück",
      advice: `Die Retoure ist in weclapp als eingegangen gebucht. Aus Sicht der Ware kann erstattet werden.${credit}`,
      tone: creditNotes.length ? "warn" : "good",
    };
  }
  if (active.length > 0) {
    return {
      ...base,
      state: "announced",
      label: "Retoure angelegt, Ware noch nicht da",
      advice: `In weclapp ist eine Retoure angelegt, die Ware ist aber noch nicht als eingegangen gebucht. Vor dem Erstatten den Wareneingang abwarten.${credit}`,
      tone: "warn",
    };
  }
  if (order.returns === undefined) {
    if (returnedQuantity > 0) {
      return { ...base, state: "received", label: "Ware zurück", advice: `Laut Auftrag sind ${returnedQuantity} Stück als zurückgesendet gebucht.${credit}`, tone: creditNotes.length ? "warn" : "good" };
    }
    return { ...base, state: "unknown", label: "Retoure nicht geprüft", advice: "Diese Bestellung wurde abgerufen, bevor SupportX Retouren gelesen hat. „Bestellung neu abrufen“ prüft es.", tone: "neutral" };
  }
  if (order.returnsError) {
    return { ...base, state: "unknown", label: "Retoure nicht prüfbar", advice: `${order.returnsError} Bitte in weclapp nachsehen.${credit}`, tone: "bad" };
  }
  if (returns.length > 0) {
    return { ...base, state: "cancelled", label: "Retoure storniert", advice: `Die Retoure wurde in weclapp storniert, es ist keine Ware zurückgekommen.${credit}`, tone: "neutral" };
  }
  return {
    ...base,
    state: "none",
    label: "Keine Retoure",
    advice: `In weclapp ist zu dieser Bestellung keine Retoure angelegt.${returnLabels ? " Es gibt ein Retourenlabel, das allein heißt aber nicht, dass etwas zurückgeschickt wurde." : ""}${credit}`,
    tone: "neutral",
  };
}
