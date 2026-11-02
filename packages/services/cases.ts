import { CONNECTOR_CATALOG } from "../connectors/catalog.ts";
import { customerText } from "../core/customer-text.ts";
import { many, one, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { enqueue } from "./jobs.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { aiWriter, sendBlockers, titleHintsFor } from "./replies.ts";
import { listCaseFiles, REPLY_FILES } from "./documents.ts";
import { invoiceSummary } from "./invoices.ts";
import { OWN_COPY_REASON, ownCopyText } from "../core/category.ts";
import type { ChannelKind } from "./connections.ts";
import type { OrderRecord } from "../core/contracts.ts";

export type CaseFilter = "open" | "needs_attention" | "waiting" | "closed" | "info" | "all";

const UUID = /^[0-9a-f-]{36}$/i;
function assertId(id: string): void {
  if (!UUID.test(id)) throw new ServiceError(404, "NOT_FOUND", "Nicht gefunden.");
}

/** "Klärung nötig": the tab list and its counter use exactly this. Done cases ("Erledigt") never count. */
const NEEDS_ATTENTION =
  "c.category = 'support' AND c.status <> 'closed' AND (c.order_match_status NOT IN ('unique','pending') OR c.last_error IS NOT NULL OR EXISTS (SELECT 1 FROM outbox o WHERE o.workspace_id = c.workspace_id AND o.conversation_id = c.id AND o.state IN ('delivery_uncertain','failed')))";

export async function listCases(ctx: AppContext, actor: Actor, filter: CaseFilter) {
  const where = {
    open: "c.status = 'open' AND c.category = 'support'",
    needs_attention: NEEDS_ATTENTION,
    waiting: "c.status = 'waiting' AND c.category = 'support'",
    closed: "c.status = 'closed' AND c.category = 'support'",
    info: "c.category = 'info'",
    all: "true",
  }[filter];
  return many(
    ctx.db,
    `SELECT c.id, c.subject, c.status, c.category, c.category_reason, c.source_platform, c.customer_address, c.customer_name, c.order_match_status, c.last_message_at, c.last_error,
            ma.name AS merchant_account_name, cc.display_name AS connection_name, cc.kind AS connection_kind, u.display_name AS assignee_name,
            (SELECT d.status FROM drafts d WHERE d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS draft_status,
            (SELECT d.intent FROM drafts d WHERE d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS intent,
            (SELECT o.state FROM outbox o WHERE o.conversation_id = c.id ORDER BY o.created_at DESC LIMIT 1) AS outbox_state,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c
     JOIN channel_connections cc ON cc.id = c.connection_id
     LEFT JOIN merchant_accounts ma ON ma.id = c.merchant_account_id
     LEFT JOIN users u ON u.id = c.assignee_user_id
     WHERE c.workspace_id = $1 AND ${where}
     ORDER BY c.last_message_at DESC NULLS LAST LIMIT 200`,
    [actor.workspaceId],
  );
}

export async function getCase(ctx: AppContext, actor: Actor, conversationId: string) {
  assertId(conversationId);
  const ws = actor.workspaceId;
  const conversation = await one(
    ctx.db,
    `SELECT c.*, ma.name AS merchant_account_name, cc.display_name AS connection_name, cc.kind AS connection_kind, u.display_name AS assignee_name
     FROM conversations c JOIN channel_connections cc ON cc.id = c.connection_id
     LEFT JOIN merchant_accounts ma ON ma.id = c.merchant_account_id LEFT JOIN users u ON u.id = c.assignee_user_id
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [ws, conversationId],
  );
  if (!conversation) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const [messages, notes, orderLink, drafts, approvals, outbox, history, accounts, members] = await Promise.all([
    many(ctx.db, "SELECT id, direction, kind, from_address, from_name, to_addresses, reply_to, subject, body_text, headers, has_attachments, received_at, removed_remotely_at, outbox_id FROM messages WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY received_at", [ws, conversationId]),
    many(ctx.db, "SELECT n.id, n.body, n.created_at, u.display_name AS author FROM internal_notes n JOIN users u ON u.id = n.author_user_id WHERE n.workspace_id = $1 AND n.conversation_id = $2 ORDER BY n.created_at", [ws, conversationId]),
    one(ctx.db, "SELECT id, status, references_tried, candidates, external_order_id, matched_by, linked_by, error, snapshot, retrieved_at, created_at FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [ws, conversationId]),
    many(ctx.db, "SELECT id, version, status, intent, summary, body, cited_fact_ids, facts, missing_information, suggested_actions, risks, issues, generated_by, ai_model, prompt_version, decision, document_ids, inbound_message_id, created_at, updated_at FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 5", [ws, conversationId]),
    many(ctx.db, "SELECT a.id, a.draft_id, a.draft_version, a.approved_at, a.expires_at, a.invalidated_at, a.invalidation_reason, coalesce(u.display_name, 'automatisch (' || a.auto_rule || ')') AS approved_by FROM approvals a LEFT JOIN users u ON u.id = a.approved_by WHERE a.workspace_id = $1 AND a.conversation_id = $2 ORDER BY a.approved_at DESC LIMIT 10", [ws, conversationId]),
    many(ctx.db, "SELECT id, draft_id, state, attempts, last_error, expected_recipient, dispatched_at, created_at, updated_at FROM outbox WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC", [ws, conversationId]),
    many(ctx.db, "SELECT action, actor_type, details, created_at FROM audit_events WHERE workspace_id = $1 AND ((target_type = 'conversation' AND target_id = $2) OR target_id IN (SELECT id::text FROM drafts WHERE conversation_id = $3) OR target_id IN (SELECT id::text FROM outbox WHERE conversation_id = $3)) ORDER BY created_at DESC LIMIT 50", [ws, conversationId, conversationId]),
    many(ctx.db, "SELECT id, name, platform FROM merchant_accounts WHERE workspace_id = $1 ORDER BY name", [ws]),
    many(ctx.db, "SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role IN ('owner','agent') ORDER BY u.display_name", [ws]),
  ]);
  const send = await sendBlockers(ctx, ctx.db, ws, conversationId);
  // Earlier and parallel cases of the same customer or the same order, so the
  // history reads as one conversation even when the mailbox split it into threads.
  const c = conversation as { customer_address: string | null; order_references: unknown };
  const related = await many(
    ctx.db,
    `SELECT m.id, m.direction, m.kind, m.from_address, m.from_name, m.subject, m.body_text, m.has_attachments, m.received_at, m.removed_remotely_at,
            o.id AS conversation_id, o.subject AS conversation_subject, (o.category_reason = $5) AS own_copy
       FROM conversations o
       JOIN messages m ON m.workspace_id = o.workspace_id AND m.conversation_id = o.id
      WHERE o.workspace_id = $1 AND o.id <> $2 AND (o.category = 'support' OR o.category_reason = $5)
        AND (
          ($3::text IS NOT NULL AND o.customer_address = $3)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.order_references) mine(ref) WHERE mine.ref->>'value' IN (SELECT r->>'value' FROM jsonb_array_elements($4::jsonb) r))
          OR EXISTS (SELECT 1 FROM order_links a JOIN order_links b ON b.workspace_id = a.workspace_id AND b.external_order_id = a.external_order_id AND b.is_current
                      WHERE a.workspace_id = $1 AND a.conversation_id = o.id AND a.is_current AND a.external_order_id IS NOT NULL AND b.conversation_id = $2)
        )
      ORDER BY m.received_at DESC
      LIMIT 50`,
    [ws, conversationId, c.customer_address, JSON.stringify(Array.isArray(c.order_references) ? c.order_references : []), OWN_COPY_REASON],
  );
  // Amazon's copies of what we wrote (also from Seller Central) show as our answer, with only our text.
  for (const m of related as Array<{ own_copy: boolean; body_text: string; direction: string; kind: string }>) {
    if (!m.own_copy) continue;
    m.body_text = ownCopyText(m.body_text);
    m.direction = "outbound";
    m.kind = "own_copy";
  }
  // Addresses for links to the order (weclapp tenant, Mirakl back office); no credentials.
  const linkTargets = await one<{ erp_base_url: string | null; mirakl_base_url: string | null }>(
    ctx.db,
    `SELECT (SELECT base_url FROM erp_connections WHERE workspace_id = $1) AS erp_base_url,
            (SELECT config->>'baseUrl' FROM channel_connections WHERE workspace_id = $1 AND kind = 'mirakl_inbox' ORDER BY created_at LIMIT 1) AS mirakl_base_url`,
    [ws],
  );
  const link = orderLink as { status: string; snapshot: OrderRecord | null } | null;
  const latestInbound = [...(messages as Array<{ direction: string; kind: string; body_text: string }>)].reverse().find((m) => m.direction === "inbound" && m.kind === "customer");
  const titleHints = titleHintsFor(link?.status === "unique" ? link.snapshot : null, latestInbound?.body_text ?? "");
  const writer = await aiWriter(ctx, ws);
  const replyFiles = REPLY_FILES[(conversation as { connection_kind: ChannelKind }).connection_kind] ?? { supported: false, note: "" };
  const caseFiles = await listCaseFiles(ctx, actor, conversationId);
  const invoices = invoiceSummary(link?.status === "unique" ? link.snapshot : null);
  return { conversation, messages, relatedMessages: related.reverse(), notes, orderLink, drafts, approvals, outbox, history, accounts, members, send, linkTargets, titleHints, writer, replyFiles, caseFiles, invoices };
}

/** Counts for the inbox tabs. */
export async function caseCounts(ctx: AppContext, actor: Actor) {
  return one<{ open: number; needs_attention: number; info: number }>(
    ctx.db,
    `SELECT count(*) FILTER (WHERE c.category = 'support' AND c.status = 'open')::int AS open,
            count(*) FILTER (WHERE ${NEEDS_ATTENTION})::int AS needs_attention,
            count(*) FILTER (WHERE c.category = 'info')::int AS info
     FROM conversations c WHERE c.workspace_id = $1`,
    [actor.workspaceId],
  );
}

/**
 * A person decides: customer request or information/advertising. Optionally remembered
 * for the sender's address or domain, so future mails from there are sorted the same way.
 */
export async function setCaseCategory(
  ctx: AppContext,
  actor: Actor,
  conversationId: string,
  input: { category: "support" | "info"; remember?: "none" | "address" | "domain" },
): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  assertId(conversationId);
  if (!["support", "info"].includes(input.category)) throw new ServiceError(400, "INVALID", "Ungültige Einordnung.");
  await withTx(ctx.db, async (tx) => {
    const conv = await one<{ id: string; customer_address: string | null; category: string }>(tx, "SELECT id, customer_address, category FROM conversations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [actor.workspaceId, conversationId]);
    if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    const sender = (await one<{ from_address: string }>(tx, "SELECT from_address FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1", [actor.workspaceId, conversationId]))?.from_address.toLowerCase();
    await tx.query(
      "UPDATE conversations SET category = $3, category_source = 'person', category_reason = 'von Hand eingeordnet', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, conversationId, input.category],
    );
    if (input.category === "info") {
      await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'als Werbung/Info eingeordnet' WHERE workspace_id = $1 AND conversation_id = $2 AND invalidated_at IS NULL", [actor.workspaceId, conversationId]);
      await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [actor.workspaceId, conversationId]);
    } else if (conv.category !== "support") {
      await enqueue(tx, { workspaceId: actor.workspaceId, type: "case.enrich", payload: { conversationId }, dedupeKey: `case.enrich:${conversationId}` });
    }
    if (sender && input.remember && input.remember !== "none") {
      const matchType = input.remember === "address" ? "from_address" : "from_domain";
      const pattern = input.remember === "address" ? sender : sender.slice(sender.lastIndexOf("@") + 1);
      await tx.query(
        `INSERT INTO category_rules (workspace_id, match_type, pattern, category, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, match_type, pattern) DO UPDATE SET category = EXCLUDED.category`,
        [actor.workspaceId, matchType, pattern, input.category, actor.type === "user" ? actor.userId : null],
      );
    }
    await audit(tx, actor, "conversation.categorized", "conversation", conversationId, { category: input.category, remember: input.remember ?? "none" });
  });
}

export async function deleteCategoryRule(ctx: AppContext, actor: Actor, ruleId: string): Promise<void> {
  requireRole(actor, ["owner"]);
  assertId(ruleId);
  const res = await ctx.db.query("DELETE FROM category_rules WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, ruleId]);
  if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Regel nicht gefunden.");
}

export async function addNote(ctx: AppContext, actor: Actor, conversationId: string, body: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Nur Mitarbeitende schreiben Notizen.");
  if (!body.trim()) throw new ServiceError(400, "INVALID", "Notiz ist leer.");
  assertId(conversationId);
  await withTx(ctx.db, async (tx) => {
    const conv = await one(tx, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId]);
    if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    // Internal only: notes are never passed to an AI provider or a channel.
    await tx.query("INSERT INTO internal_notes (workspace_id, conversation_id, author_user_id, body) VALUES ($1, $2, $3, $4)", [actor.workspaceId, conversationId, actor.userId, body.trim().slice(0, 10_000)]);
    await audit(tx, actor, "note.added", "conversation", conversationId);
  });
}

export async function setStatus(ctx: AppContext, actor: Actor, conversationId: string, status: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (!["open", "waiting", "closed"].includes(status)) throw new ServiceError(400, "INVALID", "Ungültiger Status.");
  assertId(conversationId);
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query("UPDATE conversations SET status = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId, status]);
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await audit(tx, actor, "conversation.status", "conversation", conversationId, { status });
  });
}

export const OUTCOMES = ["none", "replacement", "refund", "partial_refund", "return", "question", "other"] as const;

/** Records what was done for the customer (or clears it with null). */
export async function setOutcome(ctx: AppContext, actor: Actor, conversationId: string, input: { outcome: string | null; note?: string }): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  assertId(conversationId);
  if (input.outcome !== null && !(OUTCOMES as readonly string[]).includes(input.outcome)) throw new ServiceError(400, "INVALID", "Ungültige Maßnahme.");
  const note = input.note?.trim().slice(0, 2000) || null;
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query(
      "UPDATE conversations SET outcome = $3, outcome_note = $4, outcome_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, outcome_by = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, conversationId, input.outcome, input.outcome === null ? null : note, input.outcome !== null && actor.type === "user" ? actor.userId : null],
    );
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await audit(tx, actor, "conversation.outcome", "conversation", conversationId, { outcome: input.outcome });
  });
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // Leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * All customer cases with what the customer wrote, what was answered and what
 * was done, as CSV (semicolon, UTF-8 with BOM for Excel). Owners only.
 */
export async function exportCasesCsv(ctx: AppContext, actor: Actor): Promise<string> {
  requireRole(actor, ["owner"]);
  const rows = await many<Record<string, unknown>>(
    ctx.db,
    `SELECT c.id, c.created_at, c.source_platform, c.status, c.subject,
            (SELECT d.intent FROM drafts d WHERE d.workspace_id = c.workspace_id AND d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS intent,
            ol.snapshot->>'orderNumber' AS order_number, ol.snapshot->>'orderNumberAtCustomer' AS marketplace_order,
            (SELECT m.body_text FROM messages m WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.direction = 'inbound' ORDER BY m.received_at ASC LIMIT 1) AS customer_body,
            (SELECT o.body FROM outbox o WHERE o.workspace_id = c.workspace_id AND o.conversation_id = c.id AND o.state IN ('provider_accepted','confirmed') ORDER BY o.created_at DESC LIMIT 1) AS reply,
            c.outcome, c.outcome_note, c.outcome_at
       FROM conversations c
       LEFT JOIN order_links ol ON ol.workspace_id = c.workspace_id AND ol.conversation_id = c.id AND ol.is_current
      WHERE c.workspace_id = $1 AND c.category = 'support'
      ORDER BY c.created_at DESC`,
    [actor.workspaceId],
  );
  const head = ["Fall", "Eingang", "Marktplatz", "Status", "Betreff", "Anliegen", "Auftrag weclapp", "Bestellung Marktplatz", "Kundentext", "Gesendete Antwort", "Maßnahme", "Notiz", "Maßnahme am"];
  const lines = rows.map((r) => [r.id, r.created_at, r.source_platform, r.status, r.subject, r.intent, r.order_number, r.marketplace_order, customerText(String(r.customer_body ?? "")).slice(0, 2000), r.reply, r.outcome, r.outcome_note, r.outcome_at].map(csvCell).join(";"));
  await audit(ctx.db, actor, "cases.exported", "workspace", actor.workspaceId, { rows: rows.length });
  return `\uFEFF${[head.join(";"), ...lines].join("\r\n")}\r\n`;
}

export async function assign(ctx: AppContext, actor: Actor, conversationId: string, userId: string | null): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  assertId(conversationId);
  await withTx(ctx.db, async (tx) => {
    if (userId) {
      const member = await one(tx, "SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [actor.workspaceId, userId]);
      if (!member) throw new ServiceError(400, "INVALID", "Person gehört nicht zu diesem Arbeitsbereich.");
    }
    const res = await tx.query("UPDATE conversations SET assignee_user_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId, userId]);
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await audit(tx, actor, "conversation.assigned", "conversation", conversationId, { userId });
  });
}

/** Settings overview. Secrets are represented only as "hinterlegt". */
export async function getSettings(ctx: AppContext, actor: Actor) {
  const ws = actor.workspaceId;
  const [workspace, accounts, connections, rules, routes, erp, categoryRules, jobs] = await Promise.all([
    one(ctx.db, "SELECT id, name, reply_signature, reply_tone, default_language, allowed_link_prefixes, ai_enabled, auto_invoice, ai_secret_id IS NOT NULL AS has_ai_key, ai_key_hint, setup_confirmations FROM workspaces WHERE id = $1", [ws]),
    many(ctx.db, "SELECT id, name, platform, order_scope_field, order_scope_value, paused FROM merchant_accounts WHERE workspace_id = $1 ORDER BY name", [ws]),
    many(ctx.db, "SELECT id, kind, display_name, config - 'clientState' - 'secretHint' - 'oauthStateHash' - 'oauthStateExpiresAt' - 'oauthStateUserId' AS config, secret_id IS NOT NULL AS has_secret, default_merchant_account_id, default_source_platform, send_enabled, paused, health, last_sync_at, last_error FROM channel_connections WHERE workspace_id = $1 ORDER BY display_name", [ws]),
    many(ctx.db, "SELECT r.id, r.connection_id, r.priority, r.match_type, r.pattern, r.source_platform, r.merchant_account_id, ma.name AS merchant_account_name FROM routing_rules r LEFT JOIN merchant_accounts ma ON ma.id = r.merchant_account_id WHERE r.workspace_id = $1 ORDER BY r.priority, r.pattern", [ws]),
    many(ctx.db, "SELECT v.id, v.connection_id, v.source_platform, v.evidence_note, v.verified_at, u.display_name AS verified_by FROM reply_route_verifications v LEFT JOIN users u ON u.id = v.verified_by WHERE v.workspace_id = $1 AND v.revoked_at IS NULL", [ws]),
    one(ctx.db, "SELECT id, base_url, search_fields, secret_id IS NOT NULL AS has_secret, status, last_checked_at, last_error FROM erp_connections WHERE workspace_id = $1", [ws]),
    many(ctx.db, "SELECT id, match_type, pattern, category, created_at FROM category_rules WHERE workspace_id = $1 ORDER BY pattern", [ws]),
    many(ctx.db, "SELECT type, status, count(*)::int AS count, max(last_error) AS last_error FROM jobs WHERE workspace_id = $1 AND (status IN ('queued','running','failed')) GROUP BY type, status ORDER BY type", [ws]),
  ]);
  return {
    workspace,
    accounts,
    connections,
    rules,
    routes,
    erp,
    categoryRules,
    jobs,
    catalog: CONNECTOR_CATALOG,
    ai: { provider: ctx.ai.id, model: ctx.ai.model, promptVersion: ctx.ai.promptVersion },
    sendMode: ctx.config.SEND_MODE,
    demoMode: ctx.config.DEMO_MODE,
  };
}

/**
 * Stores (or with null removes) the workspace's own Claude API key. The key is
 * encrypted, never returned, and only its last characters are kept as a hint.
 */
export async function setWorkspaceAiKey(ctx: AppContext, actor: Actor, rawKey: string | null): Promise<{ ok: boolean; detail: string } | null> {
  requireRole(actor, ["owner"]);
  const key = rawKey?.trim() || null;
  if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw new ServiceError(400, "INVALID", "Das sieht nicht wie ein Claude-API-Schlüssel aus. Er beginnt mit „sk-ant-“.");
  const check = key ? await ctx.checkAiKey(key) : null;
  if (check && !check.ok) throw new ServiceError(400, "AI_KEY_REJECTED", `Schlüssel nicht gespeichert: ${check.detail}`);
  await withTx(ctx.db, async (tx) => {
    const old = await one<{ ai_secret_id: string | null }>(tx, "SELECT ai_secret_id FROM workspaces WHERE id = $1 FOR UPDATE", [actor.workspaceId]);
    const secretId = key ? await ctx.secrets.store(tx, actor.workspaceId, "anthropic_api_key", key) : null;
    await tx.query("UPDATE workspaces SET ai_secret_id = $2, ai_key_hint = $3, ai_enabled = CASE WHEN $2::uuid IS NULL THEN ai_enabled ELSE true END WHERE id = $1", [actor.workspaceId, secretId, key ? `…${key.slice(-4)}` : null]);
    if (old?.ai_secret_id) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, old.ai_secret_id]);
    await audit(tx, actor, key ? "workspace.ai_key_saved" : "workspace.ai_key_removed", "workspace", actor.workspaceId, {});
  });
  return check;
}

export async function checkWorkspaceAiKey(ctx: AppContext, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await one<{ ai_secret_id: string | null }>(ctx.db, "SELECT ai_secret_id FROM workspaces WHERE id = $1", [actor.workspaceId]);
  if (!row?.ai_secret_id) return { ok: false, detail: "Kein eigener Schlüssel hinterlegt." };
  return ctx.checkAiKey(await ctx.secrets.read(ctx.db, actor.workspaceId, row.ai_secret_id));
}

/** Platforms whose setup has a step outside SupportX that an owner ticks off by hand. */
export const CONFIRMABLE_PLATFORMS = ["amazon", "docmorris", "shopify"] as const;

/**
 * Ticks (or unticks) the step done at the marketplace itself, e.g. the mailbox
 * address entered in Seller Central. SupportX cannot see it, so an owner confirms it.
 */
export async function setSetupConfirmation(ctx: AppContext, actor: Actor, input: { platform: string; done: boolean }): Promise<void> {
  requireRole(actor, ["owner"]);
  if (!(CONFIRMABLE_PLATFORMS as readonly string[]).includes(input.platform)) throw new ServiceError(400, "INVALID", "Für diese Plattform gibt es keinen Schritt zum Abhaken.");
  await withTx(ctx.db, async (tx) => {
    const user = await one<{ display_name: string }>(tx, "SELECT display_name FROM users WHERE id = $1", [actorId(actor)]);
    if (input.done) {
      await tx.query(
        "UPDATE workspaces SET setup_confirmations = setup_confirmations || jsonb_build_object($2::text, jsonb_build_object('at', now(), 'by', $3::text)) WHERE id = $1",
        [actor.workspaceId, input.platform, user?.display_name ?? null],
      );
    } else {
      await tx.query("UPDATE workspaces SET setup_confirmations = setup_confirmations - $2::text WHERE id = $1", [actor.workspaceId, input.platform]);
    }
    await audit(tx, actor, "workspace.setup_confirmation", "workspace", actor.workspaceId, { platform: input.platform, done: input.done });
  });
}

export async function updateWorkspaceSettings(ctx: AppContext, actor: Actor, input: { replySignature?: string; replyTone?: string; allowedLinkPrefixes?: string[]; aiEnabled?: boolean; autoInvoice?: "off" | "draft" | "send" }): Promise<void> {
  requireRole(actor, ["owner"]);
  const prefixes = input.allowedLinkPrefixes?.map((p) => p.trim()).filter(Boolean);
  if (prefixes?.some((p) => !/^https:\/\/[^\s/]+\.[^\s/]+\//.test(p))) throw new ServiceError(400, "INVALID", "Freigegebene Links müssen mit https://domain.tld/ beginnen.");
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE workspaces SET reply_signature = coalesce($2, reply_signature), reply_tone = coalesce($3, reply_tone),
         allowed_link_prefixes = coalesce($4, allowed_link_prefixes), ai_enabled = coalesce($5, ai_enabled), auto_invoice = coalesce($6, auto_invoice),
         auto_invoice_since = CASE WHEN $6::text IS NULL OR $6::text = auto_invoice THEN auto_invoice_since WHEN $6::text = 'off' THEN NULL ELSE now() END WHERE id = $1`,
      [actor.workspaceId, input.replySignature ?? null, input.replyTone ?? null, prefixes ?? null, input.aiEnabled ?? null, input.autoInvoice ?? null],
    );
    await audit(tx, actor, "workspace.settings", "workspace", actor.workspaceId, { aiEnabled: input.aiEnabled, autoInvoice: input.autoInvoice });
  });
}
