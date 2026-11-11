/**
 * The case history as a chat: customer messages and our replies in time order.
 * Our replies come from the outbox (planned, being sent, sent, unclear, failed),
 * so a reply shows in the history the moment it is queued, with its send state.
 * When the mailbox later delivers the sent copy (an "echo" with the outbox id),
 * the history keeps one entry: the outbox reply with the echo's id as proof.
 * Withdrawn replies (suppressed) are left out. Pure, shared by UI and tests.
 */

export interface TimelineMessage {
  id: string;
  direction: string;
  kind: string;
  received_at: string;
  outbox_id?: string | null;
}

export interface TimelineOutbox {
  id: string;
  state: string;
  body?: string | null;
  expected_recipient: string | null;
  attempts: number;
  last_error: string | null;
  dispatched_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TimelineEntry<M extends TimelineMessage, O extends TimelineOutbox> =
  | { type: "message"; at: string; message: M }
  | { type: "reply"; at: string; reply: O; echoId: string | null };

/** States in which a reply is (or may be) on its way to the customer. */
export const SHOWN_REPLY_STATES = ["planned", "dispatching", "provider_accepted", "confirmed", "delivery_uncertain", "failed"] as const;

export function replyTime(o: TimelineOutbox): string {
  return o.dispatched_at ?? o.created_at;
}

export function buildTimeline<M extends TimelineMessage, O extends TimelineOutbox>(messages: readonly M[], outbox: readonly O[]): Array<TimelineEntry<M, O>> {
  const shown = outbox.filter((o) => (SHOWN_REPLY_STATES as readonly string[]).includes(o.state));
  const byId = new Map(shown.map((o) => [o.id, o]));
  const echoOf = new Map<string, string>();
  const entries: Array<TimelineEntry<M, O>> = [];
  for (const m of messages) {
    if (m.outbox_id && byId.has(m.outbox_id) && !echoOf.has(m.outbox_id)) {
      echoOf.set(m.outbox_id, m.id);
      continue;
    }
    entries.push({ type: "message", at: m.received_at, message: m });
  }
  for (const o of shown) entries.push({ type: "reply", at: replyTime(o), reply: o, echoId: echoOf.get(o.id) ?? null });
  // Stable: equal times keep messages before replies (a reply never precedes what it answers).
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => new Date(a.e.at).getTime() - new Date(b.e.at).getTime() || a.i - b.i)
    .map(({ e }) => e);
}
