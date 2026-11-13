import { caseForwards } from "./forwards.ts";
import { caseAmazonListingAccess, listCaseListingActions } from "./amazon-listings.ts";
import { CONNECTOR_CATALOG } from "../connectors/catalog.ts";
import { customerText } from "../core/customer-text.ts";
import { many, one, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { enqueue } from "./jobs.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { aiWriter, sendBlockers, titleHintsFor } from "./replies.ts";
import { listCaseFiles, REPLY_FILES } from "./documents.ts";
import { invoiceSummary } from "./invoices.ts";
import { marketplaceResolve } from "../core/marketplace-resolve.ts";
import { OWN_COPY_REASON, SYSTEM_NOTICE_REASON, ownCopyText, ruleReason } from "../core/category.ts";
import { checkSubjectPattern, matchesSubjectPattern } from "../core/subject-pattern.ts";
import type { Queryable } from "../storage/db.ts";
import type { ChannelKind } from "./connections.ts";
import type { OrderRecord } from "../core/contracts.ts";
import { deadlineState, MAX_DEADLINE_HOURS, normalizeDeadlines } from "../core/deadline.ts";
import { TOPICS } from "../core/topic.ts";
import { isRefundNotice, refundDue, type RefundDue, type RelatedRefundCase } from "../core/refund-due.ts";
import { returnSummary, type ReturnOrderInput } from "../core/returns.ts";
import { refundNoticeAmount, returnCheck, type RefundNoticeAmount, type ReturnCheck } from "../core/return-check.ts";
import { caseRefundStatus } from "./refunds.ts";
import { parseAmountInput } from "../core/refund-list.ts";

export type CaseFilter = "open" | "needs_attention" | "waiting" | "closed" | "info" | "all";

const UUID = /^[0-9a-f-]{36}$/i;
function assertId(id: string): void {
  if (!UUID.test(id)) throw new ServiceError(404, "NOT_FOUND", "Nicht gefunden.");
}

/** "Klärung nötig": the tab list and its counter use exactly this. Done cases ("Erledigt") never count. */
const NEEDS_ATTENTION =
  "c.category = 'support' AND c.status <> 'closed' AND (c.order_match_status NOT IN ('unique','pending') OR c.last_error IS NOT NULL OR EXISTS (SELECT 1 FROM outbox o WHERE o.workspace_id = c.workspace_id AND o.conversation_id = c.id AND o.state IN ('delivery_uncertain','failed')))";

/**
 * Since when the customer waits for an answer: the first customer message after our
 * last reply (sent from SupportX, from the mailbox or seen as Amazon's copy). Only
 * open customer cases have a deadline; "Wartet" and "Erledigt" stop the clock.
 */
const WAITING_SINCE = `CASE WHEN c.status = 'open' AND c.category = 'support' THEN (
    SELECT min(m.received_at) FROM messages m
     WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.direction = 'inbound' AND m.kind = 'customer'
       AND m.received_at > greatest(
         (SELECT max(o.received_at) FROM messages o WHERE o.workspace_id = c.workspace_id AND o.conversation_id = c.id AND o.direction = 'outbound'),
         -- Answered in Seller Central: Amazon's copy of our message lands as its own (info) case.
         (SELECT max(om.received_at) FROM conversations oc JOIN messages om ON om.workspace_id = oc.workspace_id AND om.conversation_id = oc.id
           WHERE oc.workspace_id = c.workspace_id AND oc.category_reason = '${OWN_COPY_REASON.replace(/'/g, "''")}'
             AND ((c.customer_address IS NOT NULL AND oc.customer_address = c.customer_address)
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(oc.order_references) x, jsonb_array_elements(c.order_references) y WHERE x->>'value' = y->>'value'))),
         '-infinity'::timestamptz)
  ) END`;
const REPLY_HOURS = "nullif((w.reply_deadlines->>c.source_platform)::int, 0)";
/** Others who had the case open in the last 45 seconds (heartbeat every 15). */
const PRESENCE_WINDOW = "interval '45 seconds'";

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listCases(ctx: AppContext, actor: Actor, filter: CaseFilter, query?: string, topic?: string): Promise<Array<Record<string, any>>> {
  if (topic && !(TOPICS as readonly string[]).includes(topic)) throw new ServiceError(400, "INVALID", "Unbekanntes Anliegen.");
  const q = query?.trim().slice(0, 100) ?? "";
  if (q.length === 1) throw new ServiceError(400, "INVALID", "Bitte mindestens zwei Zeichen eingeben.");
  // A search looks through every case, whatever tab is open.
  const where = q ? "true" : {
    open: "c.status = 'open' AND c.category = 'support'",
    needs_attention: NEEDS_ATTENTION,
    waiting: "c.status = 'waiting' AND c.category = 'support'",
    closed: "c.status = 'closed' AND c.category = 'support'",
    info: "c.category = 'info'",
    all: "true",
  }[filter];
  // Open cases: the deadline that runs out first on top. "Wartet": the next follow-up first.
  const order = q ? "last_message_at DESC NULLS LAST"
    : filter === "open" || filter === "needs_attention" ? "due_at ASC NULLS LAST, last_message_at DESC NULLS LAST"
    : filter === "waiting" ? "snooze_until ASC NULLS LAST, last_message_at DESC NULLS LAST"
    : "last_message_at DESC NULLS LAST";
  const search = `($3::text IS NULL OR c.subject ILIKE $3 OR c.customer_address ILIKE $3 OR c.customer_name ILIKE $3
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(c.order_references) r WHERE r->>'value' ILIKE $3)
      OR EXISTS (SELECT 1 FROM order_links ol WHERE ol.workspace_id = c.workspace_id AND ol.conversation_id = c.id AND ol.is_current AND ol.snapshot::text ILIKE $3)
      OR EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND (m.body_text ILIKE $3 OR m.from_name ILIKE $3 OR m.from_address ILIKE $3)))`;
  const rows = await many<Record<string, unknown> & { id: string; outcome: string | null; order_return: (ReturnOrderInput & { orderNumber?: string; orderNumberAtCustomer?: string }) | null; external_order_id: string | null }>(
    ctx.db,
    `SELECT * FROM (
       SELECT c.id, c.subject, c.status, c.category, c.category_reason, c.source_platform, c.customer_address, c.customer_name, c.order_match_status, c.last_message_at, c.last_error, c.snooze_until, c.topic, c.topic_source, c.outcome,
              (SELECT jsonb_build_object('lines', coalesce(ol.snapshot->'lines', '[]'), 'shipments', coalesce(ol.snapshot->'shipments', '[]'), 'invoices', coalesce(ol.snapshot->'invoices', '[]'),
                                         'returns', ol.snapshot->'returns', 'returnsError', ol.snapshot->'returnsError', 'orderNumber', ol.snapshot->'orderNumber', 'orderNumberAtCustomer', ol.snapshot->'orderNumberAtCustomer')
                 FROM order_links ol WHERE ol.workspace_id = c.workspace_id AND ol.conversation_id = c.id AND ol.is_current AND ol.status = 'unique' AND ol.snapshot IS NOT NULL) AS order_return,
              (SELECT ol.external_order_id FROM order_links ol WHERE ol.workspace_id = c.workspace_id AND ol.conversation_id = c.id AND ol.is_current AND ol.status = 'unique') AS external_order_id,
              ma.name AS merchant_account_name, cc.display_name AS connection_name, cc.kind AS connection_kind, u.display_name AS assignee_name,
              (SELECT d.status FROM drafts d WHERE d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS draft_status,
              (SELECT d.intent FROM drafts d WHERE d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS intent,
              (SELECT o.state FROM outbox o WHERE o.conversation_id = c.id ORDER BY o.created_at DESC LIMIT 1) AS outbox_state,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT string_agg(pu.display_name, ', ' ORDER BY pu.display_name) FROM case_presence p JOIN users pu ON pu.id = p.user_id
                WHERE p.workspace_id = c.workspace_id AND p.conversation_id = c.id AND p.user_id IS DISTINCT FROM $2::uuid AND p.seen_at > now() - ${PRESENCE_WINDOW}) AS open_by,
              ws.waiting_since, ${REPLY_HOURS} AS reply_hours,
              ws.waiting_since + ${REPLY_HOURS} * interval '1 hour' AS due_at
       FROM conversations c
       JOIN workspaces w ON w.id = c.workspace_id
       JOIN channel_connections cc ON cc.id = c.connection_id
       LEFT JOIN merchant_accounts ma ON ma.id = c.merchant_account_id
       LEFT JOIN users u ON u.id = c.assignee_user_id
       CROSS JOIN LATERAL (SELECT ${WAITING_SINCE} AS waiting_since) ws
       WHERE c.workspace_id = $1 AND ${where} AND ${search} AND ($4::text IS NULL OR c.topic = $4)
     ) x
     ORDER BY ${order} LIMIT 200`,
    [actor.workspaceId, actor.type === "user" ? actor.userId : null, q ? likePattern(q) : null, topic || null],
  );
  // "Erstattung offen": goods are back in the ERP and no refund is recorded yet.
  return Promise.all(rows.map(async ({ order_return, external_order_id, ...row }) => {
    const order = order_return ? { ...order_return, returns: order_return.returns ?? undefined, returnsError: order_return.returnsError ?? undefined } : null;
    let refund: RefundDue["state"] = "none";
    if (order && returnSummary(order).state === "received") {
      const related = await relatedRefundCases(ctx, actor.workspaceId, row.id, external_order_id, [order.orderNumber, order.orderNumberAtCustomer]);
      refund = refundDue({ order, outcome: row.outcome, subject: row.subject as string | null, related }).state;
    }
    return { ...row, refund };
  }));
}

/**
 * Other cases about the same order, any category (marketplace notices such as
 * "Rückerstattung veranlasst" are sorted as information): same order number in
 * the references or the same ERP order linked.
 */
async function relatedRefundCases(ctx: AppContext, ws: string, conversationId: string, externalOrderId: string | null, numbers: ReadonlyArray<string | null | undefined>): Promise<RelatedRefundCase[]> {
  const values = numbers.map((n) => n?.trim()).filter((n): n is string => !!n);
  if (!externalOrderId && values.length === 0) return [];
  return many<RelatedRefundCase>(
    ctx.db,
    `SELECT o.subject, o.outcome, o.last_message_at
       FROM conversations o
      WHERE o.workspace_id = $1 AND o.id <> $2
        AND (EXISTS (SELECT 1 FROM jsonb_array_elements(o.order_references) r WHERE r->>'value' = ANY($3::text[]))
          OR ($4::text IS NOT NULL AND EXISTS (SELECT 1 FROM order_links l WHERE l.workspace_id = o.workspace_id AND l.conversation_id = o.id AND l.is_current AND l.external_order_id = $4)))
      ORDER BY o.last_message_at DESC NULLS LAST
      LIMIT 20`,
    [ws, conversationId, values, externalOrderId],
  );
}

/**
 * Refund hint and exact return check for the case view, see core/refund-due.ts
 * and core/return-check.ts. Refund amounts come from marketplace notices about
 * the same order (this case or related ones).
 */
async function refundDueFor(ctx: AppContext, ws: string, conversationId: string, conv: { outcome: string | null; subject: string | null }, link: { status: string; external_order_id?: string | null; snapshot: OrderRecord | null } | null): Promise<{ refund: RefundDue; returnCheck: ReturnCheck | null }> {
  const order = link?.status === "unique" ? link.snapshot : null;
  if (!order) return { refund: refundDue({ order: null }), returnCheck: null };
  const check = returnCheck(order);
  if (returnSummary(order).state !== "received" && !check.applicable) return { refund: refundDue({ order: null }), returnCheck: null };
  const related = await relatedRefundCases(ctx, ws, conversationId, link?.external_order_id ?? null, [order.orderNumber, order.orderNumberAtCustomer]);
  const notices = [conv.subject, ...related.map((r) => r.subject)]
    .filter((subject): subject is string => isRefundNotice(subject))
    .map(refundNoticeAmount)
    .filter((n): n is RefundNoticeAmount => !!n);
  return { refund: refundDue({ order, outcome: conv.outcome, subject: conv.subject, related }), returnCheck: returnCheck(order, notices) };
}

export async function getCase(ctx: AppContext, actor: Actor, conversationId: string) {
  assertId(conversationId);
  const ws = actor.workspaceId;
  const conversation = await one(
    ctx.db,
    `SELECT c.*, ma.name AS merchant_account_name, cc.display_name AS connection_name, cc.kind AS connection_kind, u.display_name AS assignee_name,
            ${WAITING_SINCE} AS waiting_since, ${REPLY_HOURS} AS reply_hours
     FROM conversations c JOIN workspaces w ON w.id = c.workspace_id JOIN channel_connections cc ON cc.id = c.connection_id
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
    many(ctx.db, "SELECT id, draft_id, state, body, attempts, last_error, expected_recipient, dispatched_at, created_at, updated_at FROM outbox WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC", [ws, conversationId]),
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
            o.id AS conversation_id, o.subject AS conversation_subject, (o.category_reason = $5) AS own_copy, (o.category_reason = $6) AS system_notice
       FROM conversations o
       JOIN messages m ON m.workspace_id = o.workspace_id AND m.conversation_id = o.id
      WHERE o.workspace_id = $1 AND o.id <> $2 AND (o.category = 'support' OR o.category_reason IN ($5, $6))
        AND (
          -- Marketplace notices all come from one system address: only the order links them.
          ($3::text IS NOT NULL AND o.customer_address = $3 AND o.category_reason IS DISTINCT FROM $6)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.order_references) mine(ref) WHERE mine.ref->>'value' IN (SELECT r->>'value' FROM jsonb_array_elements($4::jsonb) r))
          OR EXISTS (SELECT 1 FROM order_links a JOIN order_links b ON b.workspace_id = a.workspace_id AND b.external_order_id = a.external_order_id AND b.is_current
                      WHERE a.workspace_id = $1 AND a.conversation_id = o.id AND a.is_current AND a.external_order_id IS NOT NULL AND b.conversation_id = $2)
        )
      ORDER BY m.received_at DESC
      LIMIT 50`,
    [ws, conversationId, c.customer_address, JSON.stringify(Array.isArray(c.order_references) ? c.order_references : []), OWN_COPY_REASON, SYSTEM_NOTICE_REASON],
  );
  const customerHistory = await customerHistoryFor(ctx, ws, conversationId, c.customer_address, (orderLink as { status: string; snapshot: OrderRecord | null } | null));
  // Amazon's copies of what we wrote (also from Seller Central) show as our answer, with only our text.
  for (const m of related as Array<{ own_copy: boolean; system_notice: boolean; body_text: string; direction: string; kind: string }>) {
    if (m.system_notice) m.kind = "system_notice";
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
  const forwards = await caseForwards(ctx, ws, conversationId);
  const [listingActions, amazonListings] = await Promise.all([listCaseListingActions(ctx.db, ws, conversationId), caseAmazonListingAccess(ctx.db, ws)]);
  const refundList = await caseRefundStatus(ctx, ws, conversationId);
  const { refund, returnCheck: returnCheckResult } = await refundDueFor(ctx, ws, conversationId, conversation as { outcome: string | null; subject: string | null }, orderLink as { status: string; external_order_id: string | null; snapshot: OrderRecord | null } | null);
  // What "Erledigt" still needs at the marketplace (Amazon: answered via relay, or its own "Fall lösen" link).
  const resolveAt = marketplaceResolve(
    (conversation as { source_platform: string }).source_platform,
    [...(messages as Array<{ direction: string; kind: string; body_text: string; received_at: Date }>),
     ...(related as Array<{ direction: string; kind: string; body_text: string; received_at: Date }>).filter((m) => m.kind === "own_copy")],
  );
  return { conversation, messages, forwards, relatedMessages: related.reverse(), customerHistory, notes, orderLink, drafts, approvals, outbox, history, accounts, members, send, linkTargets, titleHints, writer, replyFiles, caseFiles, invoices, listingActions, amazonListings, refund, returnCheck: returnCheckResult, refundList, resolveAt };
}

/**
 * Earlier cases of the same customer: same sender address or the same weclapp customer
 * (from the matched orders). With topic, status and what was done, so a refund or a
 * replacement last month is visible before deciding again.
 */
async function customerHistoryFor(ctx: AppContext, ws: string, conversationId: string, address: string | null, link: { status: string; snapshot: OrderRecord | null } | null) {
  const customerId = link?.status === "unique" ? link.snapshot?.customerId ?? null : null;
  if (!address && !customerId) return { cases: [], counts: { cases: 0, refunds: 0, replacements: 0, returns: 0 } };
  const cases = await many<{ id: string; subject: string; topic: string | null; status: string; outcome: string | null; source_platform: string; last_message_at: Date | null; order_number: string | null }>(
    ctx.db,
    `SELECT o.id, o.subject, o.topic, o.status, o.outcome, o.source_platform, o.last_message_at,
            (SELECT coalesce(l.snapshot->>'orderNumberAtCustomer', l.snapshot->>'orderNumber') FROM order_links l WHERE l.workspace_id = o.workspace_id AND l.conversation_id = o.id AND l.is_current AND l.status = 'unique') AS order_number
       FROM conversations o
      WHERE o.workspace_id = $1 AND o.id <> $2 AND o.category = 'support'
        AND (($3::text IS NOT NULL AND lower(o.customer_address) = lower($3))
          OR ($4::text IS NOT NULL AND EXISTS (SELECT 1 FROM order_links l WHERE l.workspace_id = o.workspace_id AND l.conversation_id = o.id AND l.is_current AND l.status = 'unique' AND l.snapshot->>'customerId' = $4)))
      ORDER BY o.last_message_at DESC NULLS LAST
      LIMIT 20`,
    [ws, conversationId, address, customerId],
  );
  const count = (...o: string[]) => cases.filter((x) => x.outcome && o.includes(x.outcome)).length;
  return { cases, counts: { cases: cases.length, refunds: count("refund", "partial_refund"), replacements: count("replacement"), returns: count("return") } };
}

/** Counts for the inbox tabs. */
export async function caseCounts(ctx: AppContext, actor: Actor) {
  const counts = await one<{ open: number; needs_attention: number; info: number }>(
    ctx.db,
    `SELECT count(*) FILTER (WHERE c.category = 'support' AND c.status = 'open')::int AS open,
            count(*) FILTER (WHERE ${NEEDS_ATTENTION})::int AS needs_attention,
            count(*) FILTER (WHERE c.category = 'info')::int AS info
     FROM conversations c WHERE c.workspace_id = $1`,
    [actor.workspaceId],
  );
  // Open cases whose reply deadline is red (overdue or only a few hours left).
  const clocks = await many<{ waiting_since: Date | null; reply_hours: number | null }>(
    ctx.db,
    `SELECT ${WAITING_SINCE} AS waiting_since, ${REPLY_HOURS} AS reply_hours
       FROM conversations c JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.workspace_id = $1 AND c.category = 'support' AND c.status = 'open' AND ${REPLY_HOURS} IS NOT NULL`,
    [actor.workspaceId],
  );
  const now = new Date();
  const urgent = clocks.filter((x) => deadlineState(x.waiting_since, x.reply_hours, now)?.tone === "bad").length;
  return { ...counts!, urgent };
}

type Category = "support" | "info";
type Remember = "none" | "address" | "domain" | "subject";

interface PatternCandidate { id: string; subject: string; category: Category; movable: boolean }

/** Cases whose subject follows the pattern. Movable: no person decided it and nothing was sent yet. */
async function casesWithSubjectPattern(q: Queryable, workspaceId: string, pattern: string): Promise<PatternCandidate[]> {
  const rows = await many<{ id: string; subject: string; category: Category; category_source: string; sent: boolean }>(
    q,
    `SELECT c.id, c.subject, c.category, c.category_source,
            EXISTS (SELECT 1 FROM outbox o WHERE o.workspace_id = c.workspace_id AND o.conversation_id = c.id) AS sent
       FROM conversations c WHERE c.workspace_id = $1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 20000`,
    [workspaceId],
  );
  return rows
    .filter((r) => matchesSubjectPattern(pattern, r.subject))
    .map((r) => ({ id: r.id, subject: r.subject, category: r.category, movable: r.category_source !== "person" && !r.sent }));
}

export interface SubjectPatternPreview {
  pattern: string;
  valid: boolean;
  error?: string;
  /** Existing cases with this subject pattern. */
  matching: number;
  /** Of those, cases that would be re-sorted now (others are already sorted so, decided by a person or answered). */
  moving: number;
  examples: Array<{ id: string; subject: string; category: Category }>;
}

/** What a subject rule would catch, before anyone saves it. */
export async function previewSubjectPattern(ctx: AppContext, actor: Actor, input: { pattern: string; category: Category }): Promise<SubjectPatternPreview> {
  requireRole(actor, ["owner", "agent"]);
  const checked = checkSubjectPattern(input.pattern);
  if (!checked.ok) return { pattern: input.pattern, valid: false, error: checked.error, matching: 0, moving: 0, examples: [] };
  const hits = await casesWithSubjectPattern(ctx.db, actor.workspaceId, checked.pattern);
  const moving = hits.filter((h) => h.movable && h.category !== input.category);
  // Show first what would change, then the rest.
  const examples = [...moving, ...hits.filter((h) => !moving.includes(h))].slice(0, 5).map(({ id, subject, category }) => ({ id, subject, category }));
  return { pattern: checked.pattern, valid: true, matching: hits.length, moving: moving.length, examples };
}

async function moveCase(tx: Queryable, workspaceId: string, conversationId: string, category: Category, source: "person" | "rule", reason: string, previous: string): Promise<void> {
  await tx.query(
    `UPDATE conversations SET category = $3, category_source = $4, category_reason = $5, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, conversationId, category, source, reason.slice(0, 500)],
  );
  if (category === "info") {
    await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'als Werbung/Info eingeordnet' WHERE workspace_id = $1 AND conversation_id = $2 AND invalidated_at IS NULL", [workspaceId, conversationId]);
    await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [workspaceId, conversationId]);
  } else if (previous !== "support") {
    await enqueue(tx, { workspaceId, type: "case.enrich", payload: { conversationId }, dedupeKey: `case.enrich:${conversationId}` });
  }
}

/**
 * A person decides: customer request or information/advertising. Optionally remembered
 * for the sender's address or domain, or for a subject pattern, so future mails are
 * sorted the same way. A subject rule also re-sorts existing cases with that pattern
 * (not those a person decided or that were already answered).
 */
export async function setCaseCategory(
  ctx: AppContext,
  actor: Actor,
  conversationId: string,
  input: { category: Category; remember?: Remember; pattern?: string },
): Promise<{ moved: number }> {
  requireRole(actor, ["owner", "agent"]);
  assertId(conversationId);
  if (!["support", "info"].includes(input.category)) throw new ServiceError(400, "INVALID", "Ungültige Einordnung.");
  let subjectPattern: string | null = null;
  if (input.remember === "subject") {
    const checked = checkSubjectPattern(input.pattern ?? "");
    if (!checked.ok) throw new ServiceError(400, "INVALID", checked.error);
    subjectPattern = checked.pattern;
  }
  return withTx(ctx.db, async (tx) => {
    const conv = await one<{ id: string; customer_address: string | null; category: string }>(tx, "SELECT id, customer_address, category FROM conversations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [actor.workspaceId, conversationId]);
    if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    const sender = (await one<{ from_address: string }>(tx, "SELECT from_address FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1", [actor.workspaceId, conversationId]))?.from_address.toLowerCase();
    await moveCase(tx, actor.workspaceId, conversationId, input.category, "person", "von Hand eingeordnet", conv.category);
    let moved = 0;
    if (subjectPattern) {
      const rule = await one<{ id: string }>(
        tx,
        `INSERT INTO category_rules (workspace_id, match_type, pattern, category, created_by) VALUES ($1, 'subject_pattern', $2, $3, $4)
         ON CONFLICT (workspace_id, match_type, pattern) DO UPDATE SET category = EXCLUDED.category RETURNING id`,
        [actor.workspaceId, subjectPattern, input.category, actor.type === "user" ? actor.userId : null],
      );
      const reason = ruleReason({ matchType: "subject_pattern", pattern: subjectPattern });
      for (const c of await casesWithSubjectPattern(tx, actor.workspaceId, subjectPattern)) {
        if (c.id === conversationId || !c.movable || c.category === input.category) continue;
        await tx.query("SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [actor.workspaceId, c.id]);
        await moveCase(tx, actor.workspaceId, c.id, input.category, "rule", reason, c.category);
        moved++;
      }
      // The case itself and the re-sorted ones count as hits of the new rule.
      await tx.query("UPDATE category_rules SET hits = hits + $3, last_hit_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, rule!.id, moved + 1]);
    } else if (sender && input.remember && input.remember !== "none") {
      const matchType = input.remember === "address" ? "from_address" : "from_domain";
      const pattern = input.remember === "address" ? sender : sender.slice(sender.lastIndexOf("@") + 1);
      await tx.query(
        `INSERT INTO category_rules (workspace_id, match_type, pattern, category, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, match_type, pattern) DO UPDATE SET category = EXCLUDED.category`,
        [actor.workspaceId, matchType, pattern, input.category, actor.type === "user" ? actor.userId : null],
      );
    }
    await audit(tx, actor, "conversation.categorized", "conversation", conversationId, { category: input.category, remember: input.remember ?? "none", ...(subjectPattern ? { pattern: subjectPattern, moved } : {}) });
    return { moved };
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

/**
 * Open / Wartet / Erledigt. "Wartet" can carry a follow-up date: the worker reopens
 * the case then. Any status set by a person clears an earlier follow-up.
 */
export async function setStatus(ctx: AppContext, actor: Actor, conversationId: string, status: string, snoozeUntil?: string | null): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (!["open", "waiting", "closed"].includes(status)) throw new ServiceError(400, "INVALID", "Ungültiger Status.");
  assertId(conversationId);
  let until: Date | null = null;
  if (snoozeUntil) {
    if (status !== "waiting") throw new ServiceError(400, "INVALID", "Eine Wiedervorlage gibt es nur bei „Wartet“.");
    until = new Date(snoozeUntil);
    const now = Date.now();
    if (Number.isNaN(until.getTime()) || until.getTime() <= now || until.getTime() > now + 366 * 86_400_000) {
      throw new ServiceError(400, "INVALID", "Die Wiedervorlage muss in der Zukunft liegen, höchstens ein Jahr.");
    }
  }
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query("UPDATE conversations SET status = $3, snooze_until = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId, status, until]);
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await audit(tx, actor, "conversation.status", "conversation", conversationId, until ? { status, snoozeUntil: until.toISOString() } : { status });
  });
}

/** Worker: cases whose follow-up date has come are open again. */
export async function reopenDueFollowUps(ctx: AppContext): Promise<number> {
  return withTx(ctx.db, async (tx) => {
    const rows = await many<{ id: string; workspace_id: string }>(
      tx,
      "UPDATE conversations SET status = 'open', updated_at = now() WHERE status = 'waiting' AND snooze_until IS NOT NULL AND snooze_until <= now() RETURNING id, workspace_id",
    );
    for (const r of rows) await audit(tx, { type: "system", workspaceId: r.workspace_id }, "conversation.follow_up_due", "conversation", r.id);
    return rows.length;
  });
}

/**
 * Heartbeat while a person has a case open (and whether they are writing the answer).
 * Returns the others who have it open, so nobody answers the same customer twice.
 */
export async function touchPresence(ctx: AppContext, actor: Actor, conversationId: string, editing: boolean): Promise<Array<{ name: string; editing: boolean }>> {
  assertId(conversationId);
  if (actor.type !== "user") return [];
  return withTx(ctx.db, async (tx) => {
    const conv = await one(tx, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId]);
    if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await tx.query(
      `INSERT INTO case_presence (workspace_id, conversation_id, user_id, editing, seen_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (workspace_id, conversation_id, user_id) DO UPDATE SET editing = EXCLUDED.editing, seen_at = now()`,
      [actor.workspaceId, conversationId, actor.userId, editing],
    );
    await tx.query("DELETE FROM case_presence WHERE workspace_id = $1 AND seen_at < now() - interval '1 hour'", [actor.workspaceId]);
    return many<{ name: string; editing: boolean }>(
      tx,
      `SELECT u.display_name AS name, p.editing FROM case_presence p JOIN users u ON u.id = p.user_id
        WHERE p.workspace_id = $1 AND p.conversation_id = $2 AND p.user_id <> $3 AND p.seen_at > now() - ${PRESENCE_WINDOW} ORDER BY u.display_name`,
      [actor.workspaceId, conversationId, actor.userId],
    );
  });
}

/** The person closed the case view. */
export async function leavePresence(ctx: AppContext, actor: Actor, conversationId: string): Promise<void> {
  assertId(conversationId);
  if (actor.type !== "user") return;
  await ctx.db.query("DELETE FROM case_presence WHERE workspace_id = $1 AND conversation_id = $2 AND user_id = $3", [actor.workspaceId, conversationId, actor.userId]);
}

export const OUTCOMES = ["none", "replacement", "refund", "partial_refund", "return", "question", "other"] as const;

/** Records what was done for the customer (or clears it with null). */
export async function setOutcome(ctx: AppContext, actor: Actor, conversationId: string, input: { outcome: string | null; note?: string; amount?: string | null }): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  assertId(conversationId);
  if (input.outcome !== null && !(OUTCOMES as readonly string[]).includes(input.outcome)) throw new ServiceError(400, "INVALID", "Ungültige Maßnahme.");
  const isRefund = input.outcome === "refund" || input.outcome === "partial_refund";
  // Refunded amount for the refund list ("Erstattungen"), only with a refund outcome.
  let amount: number | null | undefined;
  if (isRefund && input.amount !== undefined) {
    amount = input.amount === null ? null : parseAmountInput(input.amount);
    if (amount === undefined) throw new ServiceError(400, "INVALID", "Betrag bitte als Zahl eingeben, z. B. 12,50.");
  }
  const note = input.note?.trim().slice(0, 2000) || null;
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query(
      "UPDATE conversations SET outcome = $3, outcome_note = $4, outcome_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, outcome_by = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, conversationId, input.outcome, input.outcome === null ? null : note, input.outcome !== null && actor.type === "user" ? actor.userId : null],
    );
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    // "Erstattet" again after the case was taken off the refund list: it belongs on it.
    if (isRefund) {
      await tx.query("UPDATE refund_entries SET removed_at = NULL, updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND removed_at IS NOT NULL", [actor.workspaceId, conversationId]);
      if (amount !== undefined) {
        await tx.query(
          `INSERT INTO refund_entries (workspace_id, conversation_id, amount_cents, currency, created_by) VALUES ($1, $2, $3::int, CASE WHEN $3::int IS NULL THEN NULL ELSE 'EUR' END, $4)
           ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET amount_cents = $3::int, currency = CASE WHEN $3::int IS NULL THEN NULL ELSE coalesce(refund_entries.currency, 'EUR') END, updated_at = now()`,
          [actor.workspaceId, conversationId, amount, actorId(actor)],
        );
      }
    }
    await audit(tx, actor, "conversation.outcome", "conversation", conversationId, { outcome: input.outcome, ...(amount !== undefined ? { amountCents: amount } : {}) });
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
    one(ctx.db, "SELECT id, name, reply_signature, reply_tone, default_language, allowed_link_prefixes, ai_enabled, auto_invoice, ai_secret_id IS NOT NULL AS has_ai_key, ai_key_hint, setup_confirmations, reply_deadlines, automations FROM workspaces WHERE id = $1", [ws]),
    many(ctx.db, "SELECT id, name, platform, order_scope_field, order_scope_value, paused FROM merchant_accounts WHERE workspace_id = $1 ORDER BY name", [ws]),
    many(ctx.db, "SELECT id, kind, display_name, config - 'clientState' - 'secretHint' - 'oauthStateHash' - 'oauthStateExpiresAt' - 'oauthStateUserId' AS config, secret_id IS NOT NULL AS has_secret, default_merchant_account_id, default_source_platform, send_enabled, paused, health, last_sync_at, last_error FROM channel_connections WHERE workspace_id = $1 ORDER BY display_name", [ws]),
    many(ctx.db, "SELECT r.id, r.connection_id, r.priority, r.match_type, r.pattern, r.source_platform, r.merchant_account_id, ma.name AS merchant_account_name FROM routing_rules r LEFT JOIN merchant_accounts ma ON ma.id = r.merchant_account_id WHERE r.workspace_id = $1 ORDER BY r.priority, r.pattern", [ws]),
    many(ctx.db, "SELECT v.id, v.connection_id, v.source_platform, v.evidence_note, v.verified_at, u.display_name AS verified_by FROM reply_route_verifications v LEFT JOIN users u ON u.id = v.verified_by WHERE v.workspace_id = $1 AND v.revoked_at IS NULL", [ws]),
    one(ctx.db, "SELECT id, base_url, search_fields, secret_id IS NOT NULL AS has_secret, status, last_checked_at, last_error FROM erp_connections WHERE workspace_id = $1", [ws]),
    many(ctx.db, "SELECT id, match_type, pattern, category, hits, last_hit_at, created_at FROM category_rules WHERE workspace_id = $1 ORDER BY match_type DESC, pattern", [ws]),
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

export async function updateWorkspaceSettings(ctx: AppContext, actor: Actor, input: { replySignature?: string; replyTone?: string; allowedLinkPrefixes?: string[]; aiEnabled?: boolean; autoInvoice?: "off" | "draft" | "send"; replyDeadlines?: unknown }): Promise<void> {
  requireRole(actor, ["owner"]);
  const deadlines = input.replyDeadlines === undefined ? null : normalizeDeadlines(input.replyDeadlines);
  if (input.replyDeadlines !== undefined && !deadlines) throw new ServiceError(400, "INVALID", `Antwortfristen sind ganze Stunden von 0 bis ${MAX_DEADLINE_HOURS} (0 = keine Frist).`);
  const prefixes = input.allowedLinkPrefixes?.map((p) => p.trim()).filter(Boolean);
  if (prefixes?.some((p) => !/^https:\/\/[^\s/]+\.[^\s/]+\//.test(p))) throw new ServiceError(400, "INVALID", "Freigegebene Links müssen mit https://domain.tld/ beginnen.");
  await withTx(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE workspaces SET reply_signature = coalesce($2, reply_signature), reply_tone = coalesce($3, reply_tone),
         allowed_link_prefixes = coalesce($4, allowed_link_prefixes), ai_enabled = coalesce($5, ai_enabled), auto_invoice = coalesce($6, auto_invoice),
         auto_invoice_since = CASE WHEN $6::text IS NULL OR $6::text = auto_invoice THEN auto_invoice_since WHEN $6::text = 'off' THEN NULL ELSE now() END,
         reply_deadlines = reply_deadlines || coalesce($7::jsonb, '{}'::jsonb) WHERE id = $1`,
      [actor.workspaceId, input.replySignature ?? null, input.replyTone ?? null, prefixes ?? null, input.aiEnabled ?? null, input.autoInvoice ?? null, deadlines ? JSON.stringify(deadlines) : null],
    );
    await audit(tx, actor, "workspace.settings", "workspace", actor.workspaceId, { aiEnabled: input.aiEnabled, autoInvoice: input.autoInvoice, replyDeadlines: deadlines ?? undefined });
  });
}
