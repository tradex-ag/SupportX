/**
 * What the case view says under a draft about sending. Pure display logic: the
 * server decides whether sending is allowed; this only keeps a reply that is
 * already queued or sent from reading like a lock.
 */
export interface SendInfo {
  allowed: boolean;
  blockers: string[];
  pending?: { state: string; text: string } | null;
  setupMissing?: boolean;
}

export interface SendNotice {
  /** Real reasons why sending is not possible; the yellow box shows only these. */
  blocked: string[];
  /** Point to the marketplace card only when the reason is set up there. */
  setupHint: boolean;
  /** Neutral line about a reply that is already on its way or out. */
  status: { tone: "ok" | "muted" | "bad"; text: string } | null;
}

const STATUS: Record<string, SendNotice["status"]> = {
  planned: { tone: "muted", text: "Antwort ist eingeplant und wird gleich gesendet." },
  dispatching: { tone: "muted", text: "Antwort wird gerade gesendet." },
  provider_accepted: { tone: "ok", text: "Antwort wurde gesendet." },
  confirmed: { tone: "ok", text: "Antwort wurde gesendet und im Postfach bestätigt." },
  delivery_uncertain: { tone: "bad", text: "Versand ungeklärt: bitte im Postausgang unten prüfen, ob die Antwort angekommen ist." },
};

export function sendNotice(send: SendInfo): SendNotice {
  const pending = send.pending ?? null;
  const blocked = send.blockers.filter((b) => b !== pending?.text);
  const status = pending ? (STATUS[pending.state] ?? { tone: "muted" as const, text: "Auf die letzte Kundennachricht gibt es schon einen Versandauftrag." }) : null;
  return { blocked, setupHint: blocked.length > 0 && !!send.setupMissing, status };
}
