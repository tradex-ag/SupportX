import type { DraftIssue } from "../core/draft-check.ts";
import { many } from "../storage/db.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { sendBlockers, sendDraft } from "./replies.ts";

const UUID = /^[0-9a-f-]{36}$/i;

export interface BatchItem {
  conversationId: string; subject: string; customer: string | null; platform: string;
  draftId: string | null; version: number | null; body: string | null; ready: boolean; reasons: string[];
}
export const BATCH_MAX = 50;

/**
 * Several ready replies on one page: the current draft of each chosen case with its
 * text, so a person reads them before sending all at once. A draft with any hint,
 * a newer customer message or a closed send route is shown but not offered.
 */
export async function batchCandidates(ctx: AppContext, actor: Actor, conversationIds: ReadonlyArray<string>): Promise<BatchItem[]> {
  requireRole(actor, ["owner", "agent"]);
  const ids = [...new Set(conversationIds)].filter((id) => UUID.test(id)).slice(0, BATCH_MAX);
  if (ids.length === 0) return [];
  const rows = await many<{ conversation_id: string; subject: string; customer_name: string | null; customer_address: string | null; source_platform: string; draft_id: string | null; version: number | null; body: string | null; issues: DraftIssue[] | null; stale: boolean | null }>(
    ctx.db,
    `SELECT c.id AS conversation_id, c.subject, c.customer_name, c.customer_address, c.source_platform,
            d.id AS draft_id, d.version, d.body, d.issues, (d.inbound_message_id IS DISTINCT FROM c.latest_inbound_message_id) AS stale
       FROM conversations c
       LEFT JOIN LATERAL (SELECT * FROM drafts d WHERE d.workspace_id = c.workspace_id AND d.conversation_id = c.id AND d.status IN ('proposed','edited') ORDER BY d.created_at DESC LIMIT 1) d ON true
      WHERE c.workspace_id = $1 AND c.id = ANY($2::uuid[])`,
    [actor.workspaceId, ids],
  );
  const out: BatchItem[] = [];
  for (const r of rows) {
    const reasons: string[] = [];
    if (!r.draft_id) reasons.push("Kein Antwortentwurf.");
    else {
      if (r.stale) reasons.push("Es ist eine neuere Kundennachricht eingegangen.");
      if ((r.issues ?? []).length > 0) reasons.push(`Hat Hinweise (${r.issues!.map((i) => i.message).join("; ")}). Bitte einzeln im Fall prüfen.`);
      const send = await sendBlockers(ctx, ctx.db, actor.workspaceId, r.conversation_id);
      if (!send.allowed) reasons.push(...send.blockers);
    }
    out.push({ conversationId: r.conversation_id, subject: r.subject, customer: r.customer_name || r.customer_address, platform: r.source_platform, draftId: r.draft_id, version: r.version, body: r.body, ready: reasons.length === 0, reasons });
  }
  return ids.map((id) => out.find((o) => o.conversationId === id)).filter((o): o is BatchItem => o !== undefined);
}

/**
 * Sends the drafts the person read, each bound to the version shown.
 * Only drafts without hints (no blanket acknowledgement); one failure does not stop the others.
 */
export async function sendMany(ctx: AppContext, actor: Actor, items: ReadonlyArray<{ draftId: string; expectedVersion: number }>) {
  requireRole(actor, ["owner", "agent"]);
  if (!Array.isArray(items) || items.length === 0) throw new ServiceError(400, "INVALID", "Keine Entwürfe ausgewählt.");
  if (items.length > BATCH_MAX) throw new ServiceError(400, "INVALID", `Höchstens ${BATCH_MAX} Entwürfe auf einmal.`);
  const results: Array<{ draftId: string; ok: boolean; error?: string }> = [];
  for (const item of items) {
    try {
      if (!UUID.test(String(item.draftId)) || !Number.isInteger(item.expectedVersion)) throw new ServiceError(400, "INVALID", "Ungültiger Entwurf.");
      await sendDraft(ctx, actor, item.draftId, { expectedVersion: item.expectedVersion, acknowledgeWarnings: false });
      results.push({ draftId: item.draftId, ok: true });
    } catch (err) {
      results.push({ draftId: String(item.draftId), ok: false, error: err instanceof ServiceError ? err.message : "Unerwarteter Fehler." });
    }
  }
  return results;
}
