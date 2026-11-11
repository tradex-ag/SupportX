import type { AllowedFact, CaseIntent } from "../core/contracts.ts";
import { detectRisks, newestEmailText } from "../core/classify.ts";
import type { DraftIssue } from "../core/draft-check.ts";
import { AUTOMATABLE_TOPICS, AUTOMATION_MODES, classifyTopic, TOPICS, type AutomatableTopic, type AutomationMode } from "../core/topic.ts";
import { many, one, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { approveByRule, generateDraft, queueReply, sendBlockers } from "./replies.ts";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Sorts a case by topic from the newest customer message (keyword rules, no AI).
 * A topic a person chose is never overruled.
 */
export async function classifyCaseTopic(ctx: AppContext, workspaceId: string, conversationId: string): Promise<CaseIntent | null> {
  const conv = await one<{ topic_source: string | null; category: string; latest_inbound_message_id: string | null }>(
    ctx.db, "SELECT topic_source, category, latest_inbound_message_id FROM conversations WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId],
  );
  if (!conv?.latest_inbound_message_id || conv.category !== "support" || conv.topic_source === "person") return null;
  const msg = await one<{ body_text: string; subject: string }>(ctx.db, "SELECT body_text, subject FROM messages WHERE workspace_id = $1 AND id = $2", [workspaceId, conv.latest_inbound_message_id]);
  if (!msg) return null;
  const topic = classifyTopic(`${msg.subject}\n${newestEmailText(msg.body_text)}`);
  await ctx.db.query("UPDATE conversations SET topic = $3, topic_source = 'auto' WHERE workspace_id = $1 AND id = $2 AND topic_source IS DISTINCT FROM 'person'", [workspaceId, conversationId, topic]);
  return topic;
}

/** Sorts open support cases that have no topic yet (e.g. from before 0.7.0), a batch per tick. */
export async function sortUnsortedCases(ctx: AppContext, limit = 200): Promise<number> {
  const rows = await many<{ id: string; workspace_id: string }>(
    ctx.db,
    `SELECT c.id, c.workspace_id FROM conversations c JOIN messages m ON m.id = c.latest_inbound_message_id
      WHERE c.category = 'support' AND c.topic IS NULL AND c.topic_source IS NULL LIMIT $1`,
    [limit],
  );
  for (const r of rows) await classifyCaseTopic(ctx, r.workspace_id, r.id);
  return rows.length;
}

/** A person sorts the case (or with null hands it back to the automatic sorting). */
export async function setCaseTopic(ctx: AppContext, actor: Actor, conversationId: string, topic: string | null): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  if (topic !== null && !(TOPICS as readonly string[]).includes(topic)) throw new ServiceError(400, "INVALID", "Unbekanntes Anliegen.");
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query(
      "UPDATE conversations SET topic = $3, topic_source = CASE WHEN $3::text IS NULL THEN NULL ELSE 'person' END, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, conversationId, topic],
    );
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await audit(tx, actor, "conversation.topic", "conversation", conversationId, { topic });
  });
  if (topic === null) await classifyCaseTopic(ctx, actor.workspaceId, conversationId);
}

type Automations = Partial<Record<AutomatableTopic, { mode: AutomationMode; since: string | null }>>;

/** Switches the automation of one topic. Switching on starts from now: older mail is never answered. */
export async function setAutomation(ctx: AppContext, actor: Actor, input: { topic: string; mode: string }): Promise<void> {
  requireRole(actor, ["owner"]);
  if (!(AUTOMATABLE_TOPICS as readonly string[]).includes(input.topic)) throw new ServiceError(400, "INVALID", "Für dieses Anliegen gibt es keine Automatik.");
  if (!(AUTOMATION_MODES as readonly string[]).includes(input.mode)) throw new ServiceError(400, "INVALID", "Ungültige Einstellung.");
  await withTx(ctx.db, async (tx) => {
    const row = await one<{ automations: Automations }>(tx, "SELECT automations FROM workspaces WHERE id = $1 FOR UPDATE", [actor.workspaceId]);
    const current = row?.automations[input.topic as AutomatableTopic];
    const mode = input.mode as AutomationMode;
    const since = mode === "off" ? null : current && current.mode !== "off" && current.since ? current.since : new Date().toISOString();
    await tx.query("UPDATE workspaces SET automations = automations || jsonb_build_object($2::text, jsonb_build_object('mode', $3::text, 'since', $4::text)) WHERE id = $1", [actor.workspaceId, input.topic, mode, since]);
    await audit(tx, actor, "workspace.automation", "workspace", actor.workspaceId, { topic: input.topic, mode });
  });
}

const AUTO_RULE = "parcel-v1";

/** Every shipment has at least one parcel with a tracking link from weclapp. */
export function trackingComplete(facts: ReadonlyArray<AllowedFact>): boolean {
  if (facts.some((f) => f.id === "shipments.none" || /^shipment\.\d+\.no_tracking$/.test(f.id))) return false;
  const shipments = new Set(facts.filter((f) => /^shipment\.\d+\.status$/.test(f.id)).map((f) => f.id.split(".")[1]));
  if (shipments.size === 0) return false;
  return [...shipments].every((n) => facts.some((f) => f.id.startsWith(`shipment.${n}.parcel.`) && /Trackinglink https?:\/\//.test(f.text)));
}

/**
 * "Wo ist mein Paket?": if switched on, answer from the fixed template with the
 * tracking link(s) from weclapp (no AI, no cost). "send" sends only when nothing needs
 * a person: unique order, a tracking link for every shipment, no sensitive topic
 * (e.g. "nie angekommen"), no hint from the draft check and every send check passed.
 * Otherwise the draft waits for a person and the case says why.
 */
export async function autoParcelStatus(ctx: AppContext, workspaceId: string, conversationId: string): Promise<"off" | "skipped" | "drafted" | "sent"> {
  const ws = await one<{ automations: Automations }>(ctx.db, "SELECT automations FROM workspaces WHERE id = $1", [workspaceId]);
  const setting = ws?.automations.parcel_status;
  if (!setting || setting.mode === "off" || !setting.since) return "off";
  const conv = await one<{ category: string; status: string; topic: string | null; order_match_status: string; latest_inbound_message_id: string | null }>(
    ctx.db, "SELECT category, status, topic, order_match_status, latest_inbound_message_id FROM conversations WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId],
  );
  if (!conv?.latest_inbound_message_id || conv.category !== "support" || conv.status === "closed" || conv.topic !== "parcel_status") return "skipped";
  const msg = await one<{ body_text: string; kind: string; received_at: Date }>(ctx.db, "SELECT body_text, kind, received_at FROM messages WHERE workspace_id = $1 AND id = $2", [workspaceId, conv.latest_inbound_message_id]);
  if (!msg || msg.kind !== "customer" || msg.received_at < new Date(setting.since)) return "skipped";
  // Once per customer message, never over a reply someone already prepared.
  const existing = await one(ctx.db, "SELECT 1 FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 AND inbound_message_id = $3", [workspaceId, conversationId, conv.latest_inbound_message_id]);
  if (existing) return "skipped";

  const draftId = await generateDraft(ctx, workspaceId, conversationId, undefined, { rulesOnly: true });
  if (!draftId) return "skipped";
  await audit(ctx.db, { type: "worker", workspaceId }, "draft.auto_topic", "draft", draftId, { topic: "parcel_status", mode: setting.mode });
  if (setting.mode === "draft") return "drafted";

  const draft = await one<{ issues: DraftIssue[]; facts: AllowedFact[]; missing_information: string[] }>(ctx.db, "SELECT issues, facts, missing_information FROM drafts WHERE workspace_id = $1 AND id = $2", [workspaceId, draftId]);
  const reasons: string[] = [];
  if (conv.order_match_status !== "unique") reasons.push("die Bestellung ist nicht eindeutig zugeordnet");
  else if (!trackingComplete(draft?.facts ?? [])) reasons.push("nicht jede Lieferung hat einen Trackinglink in weclapp");
  if (detectRisks(newestEmailText(msg.body_text)).length > 0) reasons.push("die Nachricht enthält ein heikles Thema (z. B. nicht angekommen oder Erstattung)");
  for (const issue of draft?.issues ?? []) reasons.push(issue.message);
  if ((draft?.missing_information.length ?? 0) > 0) reasons.push(`es fehlt etwas: ${draft!.missing_information.join("; ")}`);
  if (reasons.length === 0) {
    const blockers = await sendBlockers(ctx, ctx.db, workspaceId, conversationId);
    if (!blockers.allowed) reasons.push(...blockers.blockers);
  }
  const note = (text: string | null) => ctx.db.query("UPDATE conversations SET last_error = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId, text]);
  if (reasons.length > 0) {
    await note(`Paketstatus vorbereitet, nicht automatisch gesendet: ${reasons.join("; ")}. Bitte prüfen und selbst senden.`);
    return "drafted";
  }
  const approvalId = await approveByRule(ctx, workspaceId, draftId, AUTO_RULE);
  await queueReply(ctx, { type: "worker", workspaceId }, approvalId);
  await note(null);
  return "sent";
}
