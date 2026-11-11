import { createHash } from "node:crypto";
import type { AiProvider, AllowedFact, CaseRisk, OrderRecord, Proposal, ProposalInput, ReplyAttachment, ReplyDecision, ReplyOutcome, SourcePlatform } from "../core/contracts.ts";
import { checkTitles } from "../core/title-check.ts";
import { weightHints } from "../core/weight-check.ts";
import { customerText } from "../core/customer-text.ts";
import { detectRisks, newestEmailText } from "../core/classify.ts";
import { checkDraft, hasBlockingIssue, type DraftIssue } from "../core/draft-check.ts";
import { buildOrderFacts } from "../core/facts.ts";
import { fillSnippet, type SnippetPlaceholder } from "../core/snippets.ts";
import { getSnippet } from "./snippets.ts";
import { AiProviderError } from "../ai/index.ts";
import { RulesProvider } from "../ai/rules.ts";
import { many, one, withTx, type Queryable, type Tx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { channelFor, loadChannelConnection } from "./connections.ts";
import { outboxAttachments } from "./documents.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { enqueue } from "./jobs.ts";

interface ConversationRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  merchant_account_id: string | null;
  source_platform: SourcePlatform;
  version: number;
  latest_inbound_message_id: string | null;
  order_match_status: string;
  external_thread_key: string;
  customer_address: string | null;
  customer_name: string | null;
}

interface DraftRow {
  id: string;
  conversation_id: string;
  version: number;
  based_on_conversation_version: number;
  inbound_message_id: string;
  body: string;
  status: string;
  facts: AllowedFact[];
  cited_fact_ids: string[];
  issues: DraftIssue[];
  document_ids: string[];
}

interface WorkspaceRow {
  reply_signature: string;
  reply_tone: string;
  default_language: string;
  allowed_link_prefixes: string[];
  ai_enabled: boolean;
  ai_secret_id: string | null;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function loadConversation(q: Queryable, workspaceId: string, conversationId: string, lock = false): Promise<ConversationRow> {
  const row = await one<ConversationRow>(q, `SELECT * FROM conversations WHERE workspace_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [workspaceId, conversationId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  return row;
}

async function currentOrder(q: Queryable, workspaceId: string, conversationId: string): Promise<{ linkId: string | null; order: OrderRecord | null }> {
  const link = await one<{ id: string; status: string; snapshot: OrderRecord | null }>(q, "SELECT id, status, snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [workspaceId, conversationId]);
  return { linkId: link?.id ?? null, order: link?.status === "unique" ? link.snapshot : null };
}

function orderStatusForAi(status: string): ProposalInput["orderStatus"] {
  if (status === "unique" || status === "ambiguous" || status === "error") return status;
  if (status === "pending") return "not_checked";
  return "missing";
}

/**
 * Create a reply proposal for the latest inbound message. The AI provider sees
 * the conversation (no internal notes) and the closed list of ERP facts; its
 * output is schema-validated and claim-checked on the server.
 */
export const DECISIONS: ReadonlyArray<ReplyDecision> = ["customer_right", "customer_wrong", "ask_customer"];

/** Plausibility hints for the latest customer message against the linked order. */
export function titleHintsFor(order: OrderRecord | null, latestCustomerText: string): string[] {
  if (!order) return [];
  return checkTitles(customerText(latestCustomerText), order.lines.map((l) => ({ position: l.position, title: l.title, articleName: l.articleName, quantity: l.quantity }))).map((h) => h.text);
}

export async function generateDraft(ctx: AppContext, workspaceId: string, conversationId: string, decision?: ReplyDecision, opts: { rulesOnly?: boolean } = {}): Promise<string | null> {
  const conv = await loadConversation(ctx.db, workspaceId, conversationId);
  if (!conv.latest_inbound_message_id) return null;
  const ws = (await one<WorkspaceRow>(ctx.db, "SELECT reply_signature, reply_tone, default_language, allowed_link_prefixes, ai_enabled, ai_secret_id FROM workspaces WHERE id = $1", [workspaceId]))!;
  const { linkId, order } = await currentOrder(ctx.db, workspaceId, conversationId);
  const facts = order ? buildOrderFacts(order) : [];
  const history = await many<{ direction: "inbound" | "outbound"; body_text: string; received_at: Date; kind: string }>(
    ctx.db,
    "SELECT direction, body_text, received_at, kind FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND kind IN ('customer','echo','manual_external') ORDER BY received_at DESC LIMIT 8",
    [workspaceId, conversationId],
  );
  const messages = history.reverse().map((m) => ({ direction: m.direction, text: m.direction === "inbound" ? newestEmailText(m.body_text) : m.body_text.slice(0, 3000), at: m.received_at.toISOString() }));
  const input: ProposalInput = {
    messages,
    facts,
    orderStatus: orderStatusForAi(conv.order_match_status),
    sourcePlatform: conv.source_platform,
    language: ws.default_language,
    tone: ws.reply_tone,
    signature: ws.reply_signature,
    decision,
    hints: [...titleHintsFor(order, [...history].find((m) => m.direction === "inbound")?.body_text ?? ""), ...(order ? weightHints(order) : [])],
  };

  // The workspace's own Claude key wins over the installation's provider.
  // Automations always use the fixed templates: no AI, no cost.
  const provider = opts.rulesOnly ? new RulesProvider() : await providerFor(ctx, ws, workspaceId);
  let proposal: Proposal;
  let generatedBy = provider.id;
  let model: string | null = provider.model;
  let promptVersion = provider.promptVersion;
  let providerNote: string | null = null;
  try {
    proposal = await provider.propose(input);
  } catch (error) {
    if (error instanceof AiProviderError && error.retryable) throw error;
    // Non-retryable AI failure: fall back to the deterministic template and say so.
    const fallback = new RulesProvider();
    proposal = await fallback.propose(input);
    generatedBy = fallback.id;
    model = fallback.model;
    promptVersion = fallback.promptVersion;
    providerNote = `KI-Entwurf fehlgeschlagen: ${(error as Error).message}`;
  }

  const latestInbound = [...messages].reverse().find((m) => m.direction === "inbound")?.text ?? "";
  const risks = [...new Set<CaseRisk>([...detectRisks(latestInbound), ...proposal.risks])];
  const issues = checkDraft({
    text: proposal.replyText,
    citedFactIds: proposal.citedFactIds,
    facts,
    order,
    orderStatus: orderStatusForAi(conv.order_match_status),
    allowedLinkPrefixes: ws.allowed_link_prefixes,
    sourcePlatform: conv.source_platform,
  });
  if (risks.includes("health")) {
    issues.push({ severity: "warn", code: "HEALTH_REVIEW", message: "Gesundheitsbezogene Anfrage: bitte durch fachlich qualifiziertes Personal prüfen lassen." });
  }

  return withTx(ctx.db, async (tx) => {
    const locked = await loadConversation(tx, workspaceId, conversationId, true);
    // A newer message arrived while the model was working: that message has its own job.
    if (locked.version !== conv.version || locked.latest_inbound_message_id !== conv.latest_inbound_message_id) return null;
    await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [workspaceId, conversationId]);
    const draft = await one<{ id: string }>(
      tx,
      `INSERT INTO drafts (workspace_id, conversation_id, based_on_conversation_version, inbound_message_id, order_link_id, intent, summary, body,
         cited_fact_ids, facts, missing_information, suggested_actions, risks, issues, generated_by, ai_model, prompt_version, decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        workspaceId, conversationId, locked.version, locked.latest_inbound_message_id, linkId, proposal.intent,
        [proposal.summary, providerNote].filter(Boolean).join(" "), proposal.replyText, [...proposal.citedFactIds],
        JSON.stringify(facts), JSON.stringify(proposal.missingInformation), JSON.stringify(proposal.suggestedActions), risks,
        JSON.stringify(issues), generatedBy, model, promptVersion, decision ?? null,
      ],
    );
    await tx.query("UPDATE conversations SET last_error = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId, providerNote]);
    // An AI draft refines the topic sorted on arrival; a person's choice stays.
    if (generatedBy !== "rules") await tx.query("UPDATE conversations SET topic = $3, topic_source = 'ai' WHERE workspace_id = $1 AND id = $2 AND topic_source IS DISTINCT FROM 'person'", [workspaceId, conversationId, proposal.intent]);
    await audit(tx, { type: "system", workspaceId }, "draft.generated", "draft", draft!.id, { provider: generatedBy, model, intent: proposal.intent, blocking: hasBlockingIssue(issues) });
    return draft!.id;
  });
}

async function loadDraft(q: Queryable, workspaceId: string, draftId: string, lock = false): Promise<DraftRow> {
  const row = await one<DraftRow>(q, `SELECT * FROM drafts WHERE workspace_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [workspaceId, draftId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Entwurf nicht gefunden.");
  return row;
}

/** Human edit. Optimistic locking on the draft version; every edit voids earlier approvals. */
export async function editDraft(ctx: AppContext, actor: Actor, draftId: string, input: { body: string; expectedVersion: number }): Promise<{ version: number; issues: DraftIssue[] }> {
  requireRole(actor, ["owner", "agent"]);
  return withTx(ctx.db, async (tx) => {
    const draft = await loadDraft(tx, actor.workspaceId, draftId, true);
    if (!["proposed", "edited"].includes(draft.status)) throw new ServiceError(409, "DRAFT_CLOSED", "Dieser Entwurf ist nicht mehr aktuell.");
    if (draft.version !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
    const conv = await loadConversation(tx, actor.workspaceId, draft.conversation_id);
    const { order } = await currentOrder(tx, actor.workspaceId, draft.conversation_id);
    const ws = (await one<WorkspaceRow>(tx, "SELECT allowed_link_prefixes FROM workspaces WHERE id = $1", [actor.workspaceId]))!;
    const issues = checkDraft({ text: input.body, citedFactIds: draft.cited_fact_ids, facts: draft.facts, order, orderStatus: orderStatusForAi(conv.order_match_status), allowedLinkPrefixes: ws.allowed_link_prefixes, sourcePlatform: conv.source_platform });
    const updated = await one<{ version: number }>(
      tx,
      "UPDATE drafts SET body = $3, version = version + 1, status = 'edited', issues = $4, updated_by = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING version",
      [actor.workspaceId, draftId, input.body, JSON.stringify(issues), actorId(actor)],
    );
    await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'Entwurf geändert' WHERE workspace_id = $1 AND draft_id = $2 AND invalidated_at IS NULL", [actor.workspaceId, draftId]);
    await tx.query("UPDATE outbox SET state = 'suppressed', last_error = 'Entwurf geändert', updated_at = now() WHERE workspace_id = $1 AND draft_id = $2 AND state = 'planned'", [actor.workspaceId, draftId]);
    await audit(tx, actor, "draft.edited", "draft", draftId, { version: updated!.version });
    return { version: updated!.version, issues };
  });
}

export async function discardDraft(ctx: AppContext, actor: Actor, draftId: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  await withTx(ctx.db, async (tx) => {
    await loadDraft(tx, actor.workspaceId, draftId, true);
    await tx.query("UPDATE drafts SET status = 'discarded', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status IN ('proposed','edited')", [actor.workspaceId, draftId]);
    await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'Entwurf verworfen' WHERE workspace_id = $1 AND draft_id = $2 AND invalidated_at IS NULL", [actor.workspaceId, draftId]);
    await audit(tx, actor, "draft.discarded", "draft", draftId);
  });
}

/**
 * A reply is only written after a person decided (customer right / not right / ask first).
 * Nothing generates a reply on its own, so no AI cost arises without a click.
 */
export async function requestRedraft(ctx: AppContext, actor: Actor, conversationId: string, decision: ReplyDecision): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (!DECISIONS.includes(decision)) throw new ServiceError(400, "INVALID", "Bitte zuerst entscheiden, ob der Kunde recht hat.");
  await loadConversation(ctx.db, actor.workspaceId, conversationId);
  await enqueue(ctx.db, { workspaceId: actor.workspaceId, type: "case.draft", payload: { conversationId, decision }, dedupeKey: `case.draft:${conversationId}:${decision}` });
  await audit(ctx.db, actor, "draft.requested", "conversation", conversationId, { decision });
}

/**
 * "Individuell": what the person typed is the answer. With Claude it is worded
 * friendly and customer-oriented; without, it is wrapped in greeting and signature.
 * Saved as a normal draft, so the draft check and approval apply as always.
 */
export async function composeDraft(ctx: AppContext, actor: Actor, conversationId: string, instruction: string): Promise<{ draftId: string; worded: boolean }> {
  requireRole(actor, ["owner", "agent"]);
  const text = instruction.trim();
  if (!text) throw new ServiceError(400, "INVALID", "Bitte zuerst eintippen, was geantwortet werden soll.");
  const conv = await loadConversation(ctx.db, actor.workspaceId, conversationId);
  if (!conv.latest_inbound_message_id) throw new ServiceError(409, "NO_MESSAGE", "In diesem Fall gibt es keine Kundennachricht zum Beantworten.");
  const ws = (await one<WorkspaceRow>(ctx.db, "SELECT reply_signature, reply_tone, default_language, allowed_link_prefixes, ai_enabled, ai_secret_id FROM workspaces WHERE id = $1", [actor.workspaceId]))!;
  const provider = await providerFor(ctx, ws, actor.workspaceId);
  const { linkId, order } = await currentOrder(ctx.db, actor.workspaceId, conversationId);
  const facts = order ? buildOrderFacts(order) : [];
  const body = provider.polish ? text : ["Guten Tag,", "", text, "", ws.reply_signature].join("\n");
  const issues = checkDraft({ text: body, citedFactIds: [], facts, order, orderStatus: orderStatusForAi(conv.order_match_status), allowedLinkPrefixes: ws.allowed_link_prefixes, sourcePlatform: conv.source_platform });
  const draft = await withTx(ctx.db, async (tx) => {
    await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [actor.workspaceId, conversationId]);
    const row = await one<{ id: string; version: number }>(
      tx,
      `INSERT INTO drafts (workspace_id, conversation_id, based_on_conversation_version, inbound_message_id, order_link_id, intent, summary, body,
         cited_fact_ids, facts, missing_information, suggested_actions, risks, issues, generated_by, ai_model, prompt_version, decision)
       VALUES ($1,$2,$3,$4,$5,'other','Antwort nach Vorgabe des Teams.',$6,'{}',$7,'[]','["none"]',$8,$9,'person',NULL,NULL,'custom') RETURNING id, version`,
      [actor.workspaceId, conversationId, conv.version, conv.latest_inbound_message_id, linkId, body, JSON.stringify(facts), detectRisks(text), JSON.stringify(issues)],
    );
    await audit(tx, actor, "draft.composed", "draft", row!.id, {});
    return row!;
  });
  if (!provider.polish) return { draftId: draft.id, worded: false };
  await polishDraft(ctx, actor, draft.id, { body: text, expectedVersion: draft.version });
  return { draftId: draft.id, worded: true };
}

/**
 * A text block filled for this case: customer name, order numbers, parcel numbers and
 * tracking links from weclapp (only for a uniquely linked order), signature. No AI.
 */
export async function renderSnippet(ctx: AppContext, actor: Actor, conversationId: string, snippetId: string): Promise<{ title: string; text: string; missing: SnippetPlaceholder[] }> {
  const snippet = await getSnippet(ctx, actor, snippetId);
  const conv = await loadConversation(ctx.db, actor.workspaceId, conversationId);
  const { order } = await currentOrder(ctx.db, actor.workspaceId, conversationId);
  const ws = (await one<WorkspaceRow>(ctx.db, "SELECT reply_signature FROM workspaces WHERE id = $1", [actor.workspaceId]))!;
  const filled = fillSnippet(snippet.body, { customerName: conv.customer_name, order, signature: ws.reply_signature });
  return { title: snippet.title, ...filled };
}

/**
 * "Textbaustein" as the answer: the filled block becomes the draft, without AI and
 * without cost. The draft check and approval apply as always; an open placeholder blocks.
 */
export async function snippetDraft(ctx: AppContext, actor: Actor, conversationId: string, snippetId: string): Promise<{ draftId: string; missing: SnippetPlaceholder[] }> {
  requireRole(actor, ["owner", "agent"]);
  const conv = await loadConversation(ctx.db, actor.workspaceId, conversationId);
  if (!conv.latest_inbound_message_id) throw new ServiceError(409, "NO_MESSAGE", "In diesem Fall gibt es keine Kundennachricht zum Beantworten.");
  const rendered = await renderSnippet(ctx, actor, conversationId, snippetId);
  const ws = (await one<WorkspaceRow>(ctx.db, "SELECT allowed_link_prefixes FROM workspaces WHERE id = $1", [actor.workspaceId]))!;
  const { linkId, order } = await currentOrder(ctx.db, actor.workspaceId, conversationId);
  const facts = order ? buildOrderFacts(order) : [];
  const issues = checkDraft({ text: rendered.text, citedFactIds: [], facts, order, orderStatus: orderStatusForAi(conv.order_match_status), allowedLinkPrefixes: ws.allowed_link_prefixes, sourcePlatform: conv.source_platform });
  const latest = await one<{ body_text: string }>(ctx.db, "SELECT body_text FROM messages WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conv.latest_inbound_message_id]);
  const risks = detectRisks(newestEmailText(latest?.body_text ?? ""));
  if (risks.includes("health")) issues.push({ severity: "warn", code: "HEALTH_REVIEW", message: "Gesundheitsbezogene Anfrage: bitte durch fachlich qualifiziertes Personal prüfen lassen." });
  const draftId = await withTx(ctx.db, async (tx) => {
    const locked = await loadConversation(tx, actor.workspaceId, conversationId, true);
    if (locked.latest_inbound_message_id !== conv.latest_inbound_message_id) throw new ServiceError(409, "VERSION_CONFLICT", "Inzwischen ist eine neue Kundennachricht da. Bitte neu laden.");
    // The topic stays what an earlier draft recognised; a text block does not classify.
    const earlier = await one<{ intent: string }>(tx, "SELECT intent FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1", [actor.workspaceId, conversationId]);
    await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [actor.workspaceId, conversationId]);
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO drafts (workspace_id, conversation_id, based_on_conversation_version, inbound_message_id, order_link_id, intent, summary, body,
         cited_fact_ids, facts, missing_information, suggested_actions, risks, issues, generated_by, ai_model, prompt_version, decision)
       VALUES ($1,$2,$3,$4,$5,$11,$6,$7,'{}',$8,'[]','["none"]',$9,$10,'snippet',NULL,NULL,'custom') RETURNING id`,
      [actor.workspaceId, conversationId, locked.version, locked.latest_inbound_message_id, linkId, `Textbaustein „${rendered.title}“.`, rendered.text,
        JSON.stringify(facts), risks, JSON.stringify(issues), earlier?.intent ?? "other"],
    );
    await audit(tx, actor, "draft.snippet", "draft", row!.id, { snippetId, missing: rendered.missing });
    return row!.id;
  });
  return { draftId, missing: rendered.missing };
}

/** Which writer this workspace uses: its own Claude key, the installation's Claude, or the free templates. */
async function providerFor(ctx: AppContext, ws: Pick<WorkspaceRow, "ai_enabled" | "ai_secret_id">, workspaceId: string): Promise<AiProvider> {
  if (!ws.ai_enabled) return new RulesProvider();
  return ws.ai_secret_id ? ctx.aiWithKey(await ctx.secrets.read(ctx.db, workspaceId, ws.ai_secret_id)) : ctx.ai;
}

export async function aiWriter(ctx: AppContext, workspaceId: string): Promise<"own_key" | "installation" | "rules"> {
  const ws = (await one<WorkspaceRow>(ctx.db, "SELECT ai_enabled, ai_secret_id FROM workspaces WHERE id = $1", [workspaceId]))!;
  if (!ws.ai_enabled) return "rules";
  if (ws.ai_secret_id) return "own_key";
  return ctx.ai.polish ? "installation" : "rules";
}

/**
 * The person's own text, rewritten friendly and customer-oriented (one AI call, on click).
 * The result is saved like a manual edit, so the draft check runs and approvals are voided.
 */
export async function polishDraft(ctx: AppContext, actor: Actor, draftId: string, input: { body: string; expectedVersion: number }): Promise<{ body: string; version: number; issues: DraftIssue[] }> {
  requireRole(actor, ["owner", "agent"]);
  const draft = await loadDraft(ctx.db, actor.workspaceId, draftId);
  if (!["proposed", "edited"].includes(draft.status)) throw new ServiceError(409, "DRAFT_CLOSED", "Dieser Entwurf ist nicht mehr aktuell.");
  if (draft.version !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
  if (!input.body.trim()) throw new ServiceError(400, "INVALID", "Bitte zuerst einen Text eingeben.");
  const ws = (await one<WorkspaceRow>(ctx.db, "SELECT reply_signature, reply_tone, default_language, ai_enabled, ai_secret_id FROM workspaces WHERE id = $1", [actor.workspaceId]))!;
  const provider = await providerFor(ctx, ws, actor.workspaceId);
  if (!provider.polish) throw new ServiceError(409, "NO_AI", "Freundlich formulieren braucht einen Claude-Schlüssel (Einstellungen → KI).");
  const history = await many<{ direction: "inbound" | "outbound"; body_text: string }>(
    ctx.db,
    "SELECT direction, body_text FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND kind IN ('customer','echo','manual_external') ORDER BY received_at DESC LIMIT 6",
    [actor.workspaceId, draft.conversation_id],
  );
  let body: string;
  try {
    body = await provider.polish({
      text: input.body,
      messages: history.reverse().map((m) => ({ direction: m.direction, text: m.direction === "inbound" ? newestEmailText(m.body_text) : m.body_text.slice(0, 3000), at: "" })),
      facts: draft.facts,
      language: ws.default_language,
      tone: ws.reply_tone,
      signature: ws.reply_signature,
    });
  } catch (error) {
    throw new ServiceError(502, "AI_FAILED", `Formulieren hat nicht geklappt: ${(error as Error).message}`);
  }
  const saved = await editDraft(ctx, actor, draftId, { body, expectedVersion: input.expectedVersion });
  await audit(ctx.db, actor, "draft.polished", "draft", draftId, { provider: provider.id, model: provider.model });
  return { body, ...saved };
}

/**
 * Approve the exact current draft revision. The approval binds draft version,
 * conversation version and a hash of the text, and expires.
 */
export async function approveDraft(ctx: AppContext, actor: Actor, draftId: string, input: { expectedVersion: number; acknowledgeWarnings: boolean }): Promise<string> {
  requireRole(actor, ["owner", "agent"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Freigaben erteilt nur ein Mensch.");
  return withTx(ctx.db, async (tx) => {
    const draft = await loadDraft(tx, actor.workspaceId, draftId, true);
    const conv = await loadConversation(tx, actor.workspaceId, draft.conversation_id, true);
    if (!["proposed", "edited"].includes(draft.status)) throw new ServiceError(409, "DRAFT_CLOSED", "Dieser Entwurf ist nicht mehr aktuell.");
    if (draft.version !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "Der Entwurf wurde zwischenzeitlich geändert.");
    if (draft.inbound_message_id !== conv.latest_inbound_message_id) throw new ServiceError(409, "STALE_DRAFT", "Es ist eine neuere Kundennachricht eingegangen.");
    if (hasBlockingIssue(draft.issues)) throw new ServiceError(422, "BLOCKING_ISSUES", "Der Entwurf enthält unbelegte Aussagen und kann so nicht freigegeben werden.");
    if (draft.issues.length > 0 && !input.acknowledgeWarnings) throw new ServiceError(422, "WARNINGS_NOT_ACKNOWLEDGED", "Bitte die Hinweise zum Entwurf bestätigen.");
    await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'Durch neue Freigabe ersetzt' WHERE workspace_id = $1 AND draft_id = $2 AND invalidated_at IS NULL", [actor.workspaceId, draftId]);
    const approval = await one<{ id: string }>(
      tx,
      `INSERT INTO approvals (workspace_id, conversation_id, draft_id, draft_version, conversation_version, body_sha256, approved_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::int * interval '1 minute')) RETURNING id`,
      [actor.workspaceId, conv.id, draftId, draft.version, conv.version, sha256(draft.body), actor.userId, ctx.config.APPROVAL_TTL_MIN],
    );
    await audit(tx, actor, "draft.approved", "draft", draftId, { approvalId: approval!.id, draftVersion: draft.version, conversationVersion: conv.version });
    return approval!.id;
  });
}

/**
 * Approval by a narrow rule the operator switched on (e.g. "Rechnungen automatisch
 * senden"), instead of a person. Same binding as a human approval; only for drafts
 * without any warning. The send itself still passes every send blocker.
 */
export async function approveByRule(ctx: AppContext, workspaceId: string, draftId: string, rule: string): Promise<string> {
  return withTx(ctx.db, async (tx) => {
    const draft = await loadDraft(tx, workspaceId, draftId, true);
    const conv = await loadConversation(tx, workspaceId, draft.conversation_id, true);
    if (!["proposed", "edited"].includes(draft.status)) throw new ServiceError(409, "DRAFT_CLOSED", "Dieser Entwurf ist nicht mehr aktuell.");
    if (draft.inbound_message_id !== conv.latest_inbound_message_id) throw new ServiceError(409, "STALE_DRAFT", "Es ist eine neuere Kundennachricht eingegangen.");
    if (draft.issues.length > 0) throw new ServiceError(422, "NEEDS_PERSON", "Der Entwurf hat Hinweise und braucht eine Freigabe durch einen Menschen.");
    const approval = await one<{ id: string }>(
      tx,
      `INSERT INTO approvals (workspace_id, conversation_id, draft_id, draft_version, conversation_version, body_sha256, approved_by, auto_rule, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, now() + ($8::int * interval '1 minute')) RETURNING id`,
      [workspaceId, conv.id, draftId, draft.version, conv.version, sha256(draft.body), rule, ctx.config.APPROVAL_TTL_MIN],
    );
    await audit(tx, { type: "worker", workspaceId }, "draft.approved_by_rule", "draft", draftId, { approvalId: approval!.id, rule, draftVersion: draft.version });
    return approval!.id;
  });
}

export interface SendStatus {
  allowed: boolean;
  blockers: string[];
  /** A reply to the latest customer message is already queued or sent (state and the blocker text it adds). Display only. */
  pending: { state: string; text: string } | null;
  /** True when a blocker comes from the marketplace card (sending switched off or reply route not checked). Display only. */
  setupMissing: boolean;
}

/** Why a reply can or cannot be sent right now. Shared by UI, worker and (later) MCP. */
export async function sendBlockers(ctx: AppContext, q: Queryable, workspaceId: string, conversationId: string): Promise<SendStatus> {
  const conv = await loadConversation(q, workspaceId, conversationId);
  const connection = await loadChannelConnection(q, workspaceId, conv.connection_id);
  const blockers: string[] = [];
  let pending: SendStatus["pending"] = null;
  if (ctx.config.SEND_MODE !== "enabled") blockers.push("Versand ist für diese Installation deaktiviert (SEND_MODE=drafts_only). Es werden nur Entwürfe erstellt.");
  if (!connection.send_enabled) blockers.push(`Versand ist für die Verbindung „${connection.display_name}“ nicht aktiviert.`);
  if (connection.paused) blockers.push("Die Verbindung ist pausiert.");
  const route = await one(q, "SELECT 1 FROM reply_route_verifications WHERE workspace_id = $1 AND connection_id = $2 AND source_platform = $3 AND revoked_at IS NULL", [workspaceId, connection.id, conv.source_platform]);
  if (!route) blockers.push(`Der Antwortweg für ${conv.source_platform} über diese Verbindung ist noch nicht mit einer kontrollierten Testantwort geprüft.`);
  if (conv.merchant_account_id) {
    const account = await one<{ paused: boolean }>(q, "SELECT paused FROM merchant_accounts WHERE workspace_id = $1 AND id = $2", [workspaceId, conv.merchant_account_id]);
    if (account?.paused) blockers.push("Das Verkäuferkonto ist pausiert.");
  }
  if (conv.latest_inbound_message_id) {
    const live = await one<{ state: string }>(
      q,
      "SELECT state FROM outbox WHERE workspace_id = $1 AND idempotency_key = $2 AND state NOT IN ('failed','suppressed')",
      [workspaceId, idempotencyKey(conv.id, conv.latest_inbound_message_id)],
    );
    if (live) {
      const text = `Auf die letzte Kundennachricht gibt es bereits einen Versandauftrag (Status: ${live.state}).`;
      blockers.push(text);
      pending = { state: live.state, text };
    }
  }
  return { allowed: blockers.length === 0, blockers, pending, setupMissing: !connection.send_enabled || !route };
}

function idempotencyKey(conversationId: string, inboundMessageId: string): string {
  return `reply.v1:${conversationId}:${inboundMessageId}`;
}

interface ApprovalCheck {
  ok: boolean;
  reason?: string;
}

async function checkApproval(tx: Tx, workspaceId: string, approvalId: string): Promise<ApprovalCheck & { draft?: DraftRow; conv?: ConversationRow }> {
  const approval = await one<{ draft_id: string; draft_version: number; conversation_version: number; body_sha256: string; expires_at: Date; invalidated_at: Date | null; invalidation_reason: string | null }>(
    tx,
    "SELECT * FROM approvals WHERE workspace_id = $1 AND id = $2",
    [workspaceId, approvalId],
  );
  if (!approval) return { ok: false, reason: "Freigabe nicht gefunden." };
  if (approval.invalidated_at) return { ok: false, reason: `Freigabe ungültig: ${approval.invalidation_reason ?? "zurückgezogen"}.` };
  if (approval.expires_at.getTime() < Date.now()) return { ok: false, reason: "Freigabe abgelaufen." };
  const draft = await loadDraft(tx, workspaceId, approval.draft_id);
  const conv = await loadConversation(tx, workspaceId, draft.conversation_id, true);
  if (draft.version !== approval.draft_version || sha256(draft.body) !== approval.body_sha256) return { ok: false, reason: "Entwurf wurde nach der Freigabe geändert." };
  if (conv.version !== approval.conversation_version) return { ok: false, reason: "Der Fall hat sich nach der Freigabe geändert (neue Nachricht oder Zuordnung)." };
  if (draft.inbound_message_id !== conv.latest_inbound_message_id) return { ok: false, reason: "Es ist eine neuere Kundennachricht eingegangen." };
  return { ok: true, draft, conv };
}

/** Queue an approved reply. Fails closed on every stale or unverified precondition. */
export async function queueReply(ctx: AppContext, actor: Actor, approvalId: string): Promise<string> {
  requireRole(actor, ["owner", "agent"]);
  return withTx(ctx.db, async (tx) => {
    const check = await checkApproval(tx, actor.workspaceId, approvalId);
    if (!check.ok || !check.draft || !check.conv) throw new ServiceError(409, "APPROVAL_INVALID", check.reason ?? "Freigabe ungültig.");
    const status = await sendBlockers(ctx, tx, actor.workspaceId, check.conv.id);
    if (!status.allowed) throw new ServiceError(409, "SEND_BLOCKED", status.blockers.join(" "));
    const inbound = await one<{ reply_to: Array<{ address: string }>; from_address: string }>(tx, "SELECT reply_to, from_address FROM messages WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, check.conv.latest_inbound_message_id]);
    // Recipient is derived from the original message by the transport, never from draft text.
    const expectedRecipient = inbound?.reply_to[0]?.address ?? inbound?.from_address ?? null;
    let outboxId: string;
    try {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO outbox (workspace_id, conversation_id, connection_id, draft_id, draft_version, approval_id, in_reply_to_message_id, idempotency_key, body, expected_recipient, document_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[]) RETURNING id`,
        [actor.workspaceId, check.conv.id, check.conv.connection_id, check.draft.id, check.draft.version, approvalId, check.conv.latest_inbound_message_id, idempotencyKey(check.conv.id, check.conv.latest_inbound_message_id!), check.draft.body, expectedRecipient, check.draft.document_ids ?? []],
      );
      outboxId = row!.id;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ServiceError(409, "DUPLICATE_REPLY", "Auf diese Kundennachricht wurde bereits geantwortet oder ein Versand läuft.");
      throw error;
    }
    await enqueue(tx, { workspaceId: actor.workspaceId, type: "outbox.dispatch", payload: { outboxId }, dedupeKey: `outbox.dispatch:${outboxId}`, maxAttempts: 3 });
    await audit(tx, actor, "reply.queued", "outbox", outboxId, { approvalId, draftId: check.draft.id });
    return outboxId;
  });
}

interface OutboxRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  connection_id: string;
  draft_id: string;
  approval_id: string;
  in_reply_to_message_id: string;
  body: string;
  document_ids: string[];
  state: string;
  attempts: number;
  dispatched_at: Date | null;
}

export class DispatchRetry extends Error {}

/**
 * Worker step. Reserve atomically, re-check everything, then call the channel
 * once. A timeout or 5xx after the request left us is "delivery_uncertain" and
 * is reconciled instead of retried.
 */
export async function dispatchOutbox(ctx: AppContext, workspaceId: string, outboxId: string): Promise<string> {
  const reserved = await withTx(ctx.db, async (tx) => {
    const row = await one<OutboxRow>(tx, "SELECT * FROM outbox WHERE workspace_id = $1 AND id = $2 FOR UPDATE SKIP LOCKED", [workspaceId, outboxId]);
    if (!row || row.state !== "planned") return null;
    const check = await checkApproval(tx, workspaceId, row.approval_id);
    const blockers = check.ok ? await sendBlockers(ctx, tx, workspaceId, row.conversation_id) : null;
    // The pending entry itself is the only allowed live outbox row.
    const otherBlockers = blockers?.blockers.filter((b) => !b.startsWith("Auf die letzte Kundennachricht gibt es bereits")) ?? [];
    if (!check.ok || otherBlockers.length > 0) {
      const reason = check.reason ?? otherBlockers.join(" ");
      await tx.query("UPDATE outbox SET state = 'suppressed', last_error = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, outboxId, reason]);
      await audit(tx, { type: "worker", workspaceId }, "reply.suppressed", "outbox", outboxId, { reason });
      return null;
    }
    await tx.query("UPDATE outbox SET state = 'dispatching', attempts = attempts + 1, dispatched_at = now(), updated_at = now() WHERE id = $1", [outboxId]);
    const inbound = await one<{ external_message_id: string; external_thread_key: string }>(
      tx,
      "SELECT m.external_message_id, c.external_thread_key FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.workspace_id = $1 AND m.id = $2",
      [workspaceId, row.in_reply_to_message_id],
    );
    return { row, inboundExternalId: inbound!.external_message_id, threadKey: inbound!.external_thread_key };
  });
  if (!reserved) return "skipped";

  const connection = await loadChannelConnection(ctx.db, workspaceId, reserved.row.connection_id);
  let outcome: ReplyOutcome | null = null;
  let attachments: ReplyAttachment[] = [];
  try {
    attachments = await outboxAttachments(ctx, workspaceId, reserved.row.document_ids ?? []);
  } catch (error) {
    // Nothing left our side yet: a clear failure, never a send without the approved files.
    outcome = { state: "rejected", error: (error as Error).message, retryable: false };
  }
  try {
    if (!outcome) outcome = await (await channelFor(ctx, ctx.db, connection)).sendReply({ inReplyToExternalId: reserved.inboundExternalId, externalThreadKey: reserved.threadKey, bodyText: reserved.row.body, outboxMarker: outboxId, ...(attachments.length ? { attachments } : {}) });
  } catch (error) {
    outcome = { state: "uncertain" as const, error: (error as Error).message };
  }

  const result: ReplyOutcome = outcome;
  return withTx(ctx.db, async (tx) => {
    const actor = { type: "worker" as const, workspaceId };
    const outcome = result;
    if (outcome.state === "provider_accepted") {
      await tx.query("UPDATE outbox SET state = 'provider_accepted', external_message_id = $3, last_error = NULL, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND state = 'dispatching'", [workspaceId, outboxId, outcome.externalMessageId ?? null]);
      await tx.query("UPDATE drafts SET status = 'sent', updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, reserved.row.draft_id]);
      await tx.query("UPDATE conversations SET status = 'waiting', updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, reserved.row.conversation_id]);
      await enqueue(tx, { workspaceId, type: "outbox.reconcile", payload: { outboxId }, dedupeKey: `outbox.reconcile:${outboxId}`, delayMs: 60_000, maxAttempts: 3 });
      await audit(tx, actor, "reply.provider_accepted", "outbox", outboxId);
      return "provider_accepted";
    }
    if (outcome.state === "rejected" && outcome.retryable) {
      // Definitely not executed (e.g. 429): safe to try again later.
      await tx.query("UPDATE outbox SET state = 'planned', last_error = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, outboxId, outcome.error]);
      throw new DispatchRetry(outcome.error);
    }
    if (outcome.state === "rejected") {
      await tx.query("UPDATE outbox SET state = 'failed', last_error = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, outboxId, outcome.error]);
      await audit(tx, actor, "reply.failed", "outbox", outboxId, { error: outcome.error });
      return "failed";
    }
    await tx.query("UPDATE outbox SET state = 'delivery_uncertain', last_error = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, outboxId, outcome.error]);
    await enqueue(tx, { workspaceId, type: "outbox.reconcile", payload: { outboxId }, dedupeKey: `outbox.reconcile:${outboxId}`, delayMs: 30_000, maxAttempts: 4 });
    await audit(tx, actor, "reply.delivery_uncertain", "outbox", outboxId, { error: outcome.error });
    return "delivery_uncertain";
  });
}

/** Look for the sent copy. Never resends; an unresolved uncertainty waits for a person. */
export async function reconcileOutbox(ctx: AppContext, workspaceId: string, outboxId: string): Promise<string> {
  const row = await one<OutboxRow & { external_thread_key: string }>(
    ctx.db,
    "SELECT o.*, c.external_thread_key FROM outbox o JOIN conversations c ON c.id = o.conversation_id WHERE o.workspace_id = $1 AND o.id = $2",
    [workspaceId, outboxId],
  );
  if (!row || !["provider_accepted", "delivery_uncertain", "dispatching"].includes(row.state)) return "nothing_to_do";
  const connection = await loadChannelConnection(ctx.db, workspaceId, row.connection_id);
  const channel = await channelFor(ctx, ctx.db, connection);
  const result = await channel.reconcileReply(outboxId, row.dispatched_at ?? new Date(Date.now() - 3_600_000), row.external_thread_key, row.body);
  if (result.state === "found") {
    await withTx(ctx.db, async (tx) => {
      await tx.query("UPDATE outbox SET state = 'confirmed', external_message_id = $3, last_error = NULL, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND state IN ('provider_accepted','delivery_uncertain','dispatching')", [workspaceId, outboxId, result.externalMessageId]);
      await tx.query("UPDATE drafts SET status = 'sent', updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, row.draft_id]);
      await audit(tx, { type: "worker", workspaceId }, "reply.reconciled_found", "outbox", outboxId);
    });
    return "confirmed";
  }
  const note = result.state === "unknown" ? `Abgleich nicht möglich: ${result.error}` : "Kein gesendetes Exemplar gefunden. Bitte im Postfach prüfen und manuell klären.";
  if (row.state !== "provider_accepted") {
    await ctx.db.query("UPDATE outbox SET state = 'delivery_uncertain', last_error = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, outboxId, note]);
  }
  return row.state === "provider_accepted" ? "accepted_unconfirmed" : "still_uncertain";
}

/**
 * A person resolves an uncertain send after checking the mailbox: either it was
 * sent (confirmed) or it was not (failed, which allows a new approved send).
 */
export async function resolveUncertainSend(ctx: AppContext, actor: Actor, outboxId: string, resolution: "was_sent" | "was_not_sent"): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  await withTx(ctx.db, async (tx) => {
    const row = await one<OutboxRow>(tx, "SELECT * FROM outbox WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [actor.workspaceId, outboxId]);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Versandauftrag nicht gefunden.");
    if (!["delivery_uncertain", "dispatching"].includes(row.state)) throw new ServiceError(409, "NOT_UNCERTAIN", "Dieser Versandauftrag ist nicht ungeklärt.");
    if (resolution === "was_sent") {
      await tx.query("UPDATE outbox SET state = 'confirmed', resolved_by = $3, last_error = 'Manuell als gesendet bestätigt', updated_at = now() WHERE id = $2 AND workspace_id = $1", [actor.workspaceId, outboxId, actorId(actor)]);
      await tx.query("UPDATE drafts SET status = 'sent', updated_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.draft_id]);
    } else {
      await tx.query("UPDATE outbox SET state = 'failed', resolved_by = $3, last_error = 'Manuell als nicht gesendet geklärt', updated_at = now() WHERE id = $2 AND workspace_id = $1", [actor.workspaceId, outboxId, actorId(actor)]);
      await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'Versand nicht erfolgt; neue Freigabe nötig' WHERE workspace_id = $1 AND id = $2 AND invalidated_at IS NULL", [actor.workspaceId, row.approval_id]);
    }
    await audit(tx, actor, "reply.uncertain_resolved", "outbox", outboxId, { resolution });
  });
}

/** Sweeper: a reservation without a recorded result (worker crash) becomes uncertain. */
export async function sweepStaleDispatches(ctx: AppContext): Promise<number> {
  const rows = await many<{ id: string; workspace_id: string }>(
    ctx.db,
    "UPDATE outbox SET state = 'delivery_uncertain', last_error = 'Versandergebnis nicht protokolliert (Prozessabbruch?)', updated_at = now() WHERE state = 'dispatching' AND updated_at < now() - interval '5 minutes' RETURNING id, workspace_id",
  );
  for (const row of rows) {
    await enqueue(ctx.db, { workspaceId: row.workspace_id, type: "outbox.reconcile", payload: { outboxId: row.id }, dedupeKey: `outbox.reconcile:${row.id}`, maxAttempts: 4 });
  }
  return rows.length;
}
