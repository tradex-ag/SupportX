import type { IngressMessage, SyncResult } from "../core/contracts.ts";
import { newestEmailText, routeMessage, type RoutingRule } from "../core/classify.ts";
import { categorizeMail, type CategoryRule } from "../core/category.ts";
import { extractOrderReferences, type OrderReference } from "../core/references.ts";
import { sameText } from "../connectors/marketplace-common.ts";
import { OUTBOX_HEADER } from "../connectors/microsoft/graph-mail.ts";
import { many, one, withTx, type Db, type Queryable, type Tx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { channelFor, loadCategoryRules, loadChannelConnection, loadRoutingRules, type ChannelConnectionRow } from "./connections.ts";
import type { AppContext } from "./context.ts";
import { enqueue } from "./jobs.ts";

export type IngestOutcome = "stored" | "duplicate" | "echo" | "forward_echo" | "manual_external" | "ignored_unrelated_outbound";

interface ConversationRow {
  id: string;
  version: number;
  order_references: OrderReference[];
  category: "support" | "info";
  category_source: "auto" | "rule" | "person";
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/i;
/** How long a case takes up a customer's follow-up mail about the same order. */
const FOLLOW_UP_DAYS = 60;

/** The case of a mail thread: its own, or the one a later thread was joined to. */
async function conversationForThread(tx: Tx, ws: string, connectionId: string, threadKey: string): Promise<ConversationRow | null> {
  return one<ConversationRow>(
    tx,
    `SELECT id, version, order_references, category, category_source FROM conversations
      WHERE workspace_id = $1 AND id = coalesce(
        (SELECT id FROM conversations WHERE workspace_id = $1 AND connection_id = $2 AND external_thread_key = $3),
        (SELECT conversation_id FROM conversation_threads WHERE workspace_id = $1 AND connection_id = $2 AND external_thread_key = $3))
      FOR UPDATE`,
    [ws, connectionId, threadKey],
  );
}

/** Most recent request of the same customer that names one of these order numbers. */
async function followUpTarget(q: Queryable, ws: string, connectionId: string, customerAddress: string, orderNumbers: string[]): Promise<string | null> {
  if (!customerAddress || orderNumbers.length === 0) return null;
  const row = await one<{ id: string }>(
    q,
    `SELECT c.id FROM conversations c
      WHERE c.workspace_id = $1 AND c.connection_id = $2 AND lower(c.customer_address) = lower($3) AND c.category = 'support'
        AND c.last_message_at > now() - ($5::int * interval '1 day')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.order_references) r WHERE r->>'value' = ANY($4::text[]))
      ORDER BY c.last_message_at DESC LIMIT 1`,
    [ws, connectionId, customerAddress, orderNumbers, FOLLOW_UP_DAYS],
  );
  return row?.id ?? null;
}

/**
 * Invalidate everything a person approved for this conversation. Called when a
 * new customer message or an external reply makes the approved text stale.
 */
export async function invalidateConversationApprovals(tx: Tx, workspaceId: string, conversationId: string, reason: string): Promise<void> {
  await tx.query(
    "UPDATE approvals SET invalidated_at = now(), invalidation_reason = $3 WHERE workspace_id = $1 AND conversation_id = $2 AND invalidated_at IS NULL",
    [workspaceId, conversationId, reason],
  );
  // Planned (not yet dispatched) sends are stopped. In-flight ones are reconciled, not cancelled.
  await tx.query(
    "UPDATE outbox SET state = 'suppressed', last_error = $3, updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND state = 'planned'",
    [workspaceId, conversationId, reason],
  );
}

/**
 * Store one message idempotently and thread it. Safe to call again for the same
 * message (repeated notification, delta replay, folder move): uniqueness on
 * (workspace, connection, external id) and on the RFC Message-ID absorbs repeats.
 */
export async function ingestMessage(tx: Tx, connection: ChannelConnectionRow, rules: ReadonlyArray<RoutingRule>, message: IngressMessage, categoryRules: ReadonlyArray<CategoryRule> = []): Promise<IngestOutcome> {
  const ws = connection.workspace_id;
  const duplicate = await one(
    tx,
    `SELECT 1 FROM messages WHERE workspace_id = $1 AND connection_id = $2
       AND (external_message_id = $3 OR ($4::text IS NOT NULL AND internet_message_id = $4))`,
    [ws, connection.id, message.externalMessageId, message.internetMessageId ?? null],
  );
  if (duplicate) return "duplicate";

  let kind: "customer" | "echo" | "manual_external" | "platform_notice" = "customer";
  let outboxId: string | null = null;
  if (message.direction === "outbound") {
    const marker = message.headers[OUTBOX_HEADER];
    // A forward a person sent from a case: logged in message_forwards, not a reply to the customer.
    // Never treated as a manual reply (that would withdraw approvals and drafts of the case).
    // Without the marker (if Exchange drops it): a forward-style subject sent only to
    // the addresses of a recent, still unconfirmed forward of this mailbox.
    const recipients = message.to.map((t) => t.address.toLowerCase());
    const forward = marker && /^[0-9a-f-]{36}$/i.test(marker)
      ? await one<{ id: string }>(tx, "SELECT id FROM message_forwards WHERE workspace_id = $1 AND id = $2 AND connection_id = $3", [ws, marker, connection.id])
      : recipients.length > 0 && /^\s*(fwd?|wg)\s*:/i.test(message.subject)
        ? await one<{ id: string }>(
          tx,
          `SELECT id FROM message_forwards WHERE workspace_id = $1 AND connection_id = $2 AND state IN ('sending','sent','uncertain')
             AND created_at > now() - interval '2 days' AND recipients @> $3::text[] ORDER BY created_at DESC LIMIT 1`,
          [ws, connection.id, recipients],
        )
        : null;
    if (forward) {
      await tx.query("UPDATE message_forwards SET state = 'confirmed', external_message_id = $3, last_error = NULL, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND state IN ('sending','sent','uncertain')", [ws, forward.id, message.externalMessageId]);
      return "forward_echo";
    }
    let outbox = marker && /^[0-9a-f-]{36}$/i.test(marker)
      ? await one<{ id: string }>(tx, "SELECT id FROM outbox WHERE workspace_id = $1 AND id = $2 AND connection_id = $3", [ws, marker, connection.id])
      : null;
    if (!outbox && connection.kind !== "microsoft_graph") {
      // Marketplace APIs carry no custom headers: our own reply is recognised by its
      // exact text in the same thread, among sends that are still awaiting confirmation.
      const candidates = await many<{ id: string; body: string; external_message_id: string | null }>(
        tx,
        `SELECT o.id, o.body, o.external_message_id FROM outbox o JOIN conversations c ON c.id = o.conversation_id
         WHERE o.workspace_id = $1 AND o.connection_id = $2 AND c.external_thread_key = $3
           AND (o.external_message_id = $4 OR o.state IN ('dispatching','provider_accepted','delivery_uncertain'))
         ORDER BY (o.external_message_id = $4) DESC NULLS LAST, o.created_at DESC LIMIT 20`,
        [ws, connection.id, message.externalThreadKey, message.externalMessageId],
      );
      // A provider message id returned by the send call is exact; otherwise compare the text.
      outbox = candidates.find((c) => c.external_message_id === message.externalMessageId) ?? candidates.find((c) => sameText(c.body, message.bodyText)) ?? null;
    }
    kind = outbox ? "echo" : "manual_external";
    outboxId = outbox?.id ?? null;
  } else if (BOUNCE_SENDER.test(message.from.address)) {
    kind = "platform_notice";
  }

  let conversation = await conversationForThread(tx, ws, connection.id, message.externalThreadKey);
  if (!conversation) {
    // Our own mail that does not belong to a known case is not a support case.
    if (message.direction === "outbound") return "ignored_unrelated_outbound";
    const route = routeMessage(message, rules, {
      sourcePlatform: connection.default_source_platform,
      merchantAccountId: connection.default_merchant_account_id,
    });
    const customer = message.replyTo[0] ?? message.from;
    // A follow-up from the same customer about the same order joins the case being worked on.
    if (connection.kind === "microsoft_graph" && kind === "customer") {
      const refs = extractOrderReferences(message.subject, newestEmailText(message.bodyText) + "\n" + message.bodyText, route.sourcePlatform as never);
      const target = await followUpTarget(tx, ws, connection.id, customer.address, refs.map((r) => r.value));
      if (target) {
        await tx.query("INSERT INTO conversation_threads (workspace_id, connection_id, external_thread_key, conversation_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [ws, connection.id, message.externalThreadKey, target]);
        conversation = await conversationForThread(tx, ws, connection.id, message.externalThreadKey);
      }
    }
  }
  if (!conversation) {
    const route = routeMessage(message, rules, {
      sourcePlatform: connection.default_source_platform,
      merchantAccountId: connection.default_merchant_account_id,
    });
    const customer = message.replyTo[0] ?? message.from;
    conversation = await one<ConversationRow>(
      tx,
      `INSERT INTO conversations (workspace_id, connection_id, external_thread_key, merchant_account_id, source_platform, routing_rule_id, subject, customer_address, customer_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, connection_id, external_thread_key) DO NOTHING
       RETURNING id, version, order_references, category, category_source`,
      [ws, connection.id, message.externalThreadKey, route.merchantAccountId, route.sourcePlatform, route.ruleId, message.subject.slice(0, 500), customer.address, customer.name ?? null, message.receivedAt],
    );
    conversation ??= await one<ConversationRow>(
      tx,
      "SELECT id, version, order_references, category, category_source FROM conversations WHERE workspace_id = $1 AND connection_id = $2 AND external_thread_key = $3 FOR UPDATE",
      [ws, connection.id, message.externalThreadKey],
    );
  }
  if (!conversation) throw new Error("Konversation konnte nicht angelegt werden.");

  const inserted = await one<{ id: string }>(
    tx,
    `INSERT INTO messages (workspace_id, conversation_id, connection_id, external_message_id, internet_message_id, direction, kind,
       from_address, from_name, to_addresses, reply_to, subject, body_text, headers, alias_keys, has_attachments, outbox_id, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      ws, conversation.id, connection.id, message.externalMessageId, message.internetMessageId ?? null, message.direction, kind,
      message.from.address, message.from.name ?? null, JSON.stringify(message.to), JSON.stringify(message.replyTo), message.subject.slice(0, 1000),
      message.bodyText, JSON.stringify(message.headers), message.aliasKeys, message.hasAttachments, outboxId, message.receivedAt,
    ],
  );
  if (!inserted) return "duplicate";
  const actor = { type: "system" as const, workspaceId: ws };

  if (kind === "echo") {
    // Our own reply is in Sent Items: Exchange stored it. Still not a delivery receipt.
    await tx.query(
      `UPDATE outbox SET state = 'confirmed', external_message_id = $3, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND state IN ('dispatching','provider_accepted','delivery_uncertain')`,
      [ws, outboxId, message.externalMessageId],
    );
    await tx.query("UPDATE conversations SET last_message_at = greatest(last_message_at, $3), updated_at = now() WHERE workspace_id = $1 AND id = $2", [ws, conversation.id, message.receivedAt]);
    await audit(tx, actor, "message.echo_matched", "outbox", outboxId);
    return "echo";
  }

  if (kind === "manual_external") {
    await tx.query(
      "UPDATE conversations SET version = version + 1, status = 'waiting', snooze_until = NULL, last_message_at = greatest(last_message_at, $3), updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [ws, conversation.id, message.receivedAt],
    );
    await invalidateConversationApprovals(tx, ws, conversation.id, "Antwort außerhalb der Anwendung erkannt");
    await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [ws, conversation.id]);
    await audit(tx, actor, "message.manual_external_reply", "conversation", conversation.id);
    return "manual_external";
  }

  // Inbound: a new customer message changes the case and invalidates approvals.
  const latestText = newestEmailText(message.bodyText);
  const platform = (await one<{ source_platform: string }>(tx, "SELECT source_platform FROM conversations WHERE id = $1", [conversation.id]))!.source_platform;
  const found = extractOrderReferences(message.subject, latestText + "\n" + message.bodyText, platform as never);
  const refs = [...conversation.order_references];
  for (const ref of found) if (!refs.some((r) => r.value === ref.value)) refs.push(ref);
  // Request or advertising? A person's decision on the case is never overruled.
  let category = conversation.category;
  // Marketplace channels (eBay, Kaufland, Mirakl) carry only buyer/operator messages, no newsletters: always a request.
  if (kind === "customer" && conversation.category_source !== "person" && connection.kind === "microsoft_graph") {
    const decision = categorizeMail({ from: message.from, subject: message.subject, bodyText: latestText, headers: message.headers, hasOrderReference: found.length > 0 }, categoryRules);
    if (decision.ruleId) {
      await tx.query("UPDATE category_rules SET hits = hits + 1, last_hit_at = now() WHERE workspace_id = $1 AND id = $2", [ws, decision.ruleId]);
    }
    // Once a thread is a request, a later newsletter-looking mail in it does not demote it.
    if (decision.category === "support" || conversation.category === "info" || conversation.version <= 1) {
      category = decision.category;
      await tx.query("UPDATE conversations SET category = $3, category_source = $4, category_reason = $5 WHERE workspace_id = $1 AND id = $2", [ws, conversation.id, decision.category, decision.source, decision.reason.slice(0, 500)]);
    }
  }
  await tx.query(
    `UPDATE conversations SET version = version + 1, latest_inbound_message_id = $3, status = 'open', snooze_until = NULL, order_references = $4,
       last_message_at = greatest(coalesce(last_message_at, $5), $5), updated_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [ws, conversation.id, inserted.id, JSON.stringify(refs.slice(0, 10)), message.receivedAt],
  );
  await invalidateConversationApprovals(tx, ws, conversation.id, "Neue Kundennachricht eingegangen");
  await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [ws, conversation.id]);
  if (kind === "customer" && category === "support") {
    await enqueue(tx, { workspaceId: ws, type: "case.enrich", payload: { conversationId: conversation.id }, dedupeKey: `case.enrich:${conversation.id}` });
  }
  await audit(tx, actor, "message.received", "conversation", conversation.id, { messageId: inserted.id, kind });
  return "stored";
}

/** Persist a sync batch, then the cursors. A crash in between only causes a harmless replay. */
export async function applySyncResult(ctx: AppContext, connection: ChannelConnectionRow, result: SyncResult): Promise<Record<IngestOutcome, number>> {
  const counts: Record<IngestOutcome, number> = { stored: 0, duplicate: 0, echo: 0, forward_echo: 0, manual_external: 0, ignored_unrelated_outbound: 0 };
  const rules = await loadRoutingRules(ctx.db, connection.workspace_id, connection.id);
  const categoryRules = await loadCategoryRules(ctx.db, connection.workspace_id);
  // Oldest first, so the latest inbound message ends up as latest_inbound.
  const ordered = [...result.messages].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const message of ordered) {
    const outcome = await withTx(ctx.db, (tx) => ingestMessage(tx, connection, rules, message, categoryRules));
    counts[outcome]++;
  }
  await withTx(ctx.db, async (tx) => {
    if (result.removedExternalIds.length > 0) {
      await tx.query(
        "UPDATE messages SET removed_remotely_at = now() WHERE workspace_id = $1 AND connection_id = $2 AND external_message_id = ANY($3) AND removed_remotely_at IS NULL",
        [connection.workspace_id, connection.id, result.removedExternalIds],
      );
    }
    for (const [resource, cursor] of Object.entries(result.cursors)) {
      await tx.query(
        `INSERT INTO sync_cursors (workspace_id, connection_id, resource, cursor) VALUES ($1, $2, $3, $4)
         ON CONFLICT (connection_id, resource) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
        [connection.workspace_id, connection.id, resource, cursor],
      );
    }
    await tx.query("UPDATE channel_connections SET last_sync_at = now(), health = 'ok', last_error = NULL WHERE id = $1", [connection.id]);
    if (result.cursorReset) await audit(tx, { type: "system", workspaceId: connection.workspace_id }, "sync.cursor_reset", "channel_connection", connection.id);
  });
  return counts;
}

export async function runMailSync(ctx: AppContext, workspaceId: string, connectionId: string): Promise<Record<IngestOutcome, number> | null> {
  const connection = await loadChannelConnection(ctx.db, workspaceId, connectionId);
  if (connection.paused) return null;
  const cursorRows = await many<{ resource: string; cursor: string }>(ctx.db, "SELECT resource, cursor FROM sync_cursors WHERE connection_id = $1", [connection.id]);
  const cursors = Object.fromEntries(cursorRows.map((r) => [r.resource, r.cursor]));
  try {
    const channel = await channelFor(ctx, ctx.db, connection);
    return await applySyncResult(ctx, connection, await channel.sync(cursors));
  } catch (error) {
    await ctx.db.query("UPDATE channel_connections SET health = 'error', last_error = $2, last_error_at = now() WHERE id = $1", [connection.id, (error as Error).message.slice(0, 1000)]);
    throw error;
  }
}

/**
 * Re-sorts cases that were filed automatically (not by a person, nothing sent) with the
 * current rules, e.g. after an update that introduced advertising detection.
 * Cases that become "info" lose their open drafts; nothing is deleted.
 */
export async function recategorizeAutoCases(db: Queryable): Promise<{ checked: number; info: number }> {
  const rows = await many<{ id: string; workspace_id: string; from_address: string; from_name: string | null; subject: string; body_text: string; headers: Record<string, string>; order_references: unknown[] }>(
    db,
    `SELECT c.id, c.workspace_id, m.from_address, m.from_name, m.subject, m.body_text, m.headers, c.order_references
     FROM conversations c
     JOIN LATERAL (SELECT * FROM messages WHERE conversation_id = c.id AND direction = 'inbound' AND kind = 'customer' ORDER BY received_at LIMIT 1) m ON true
     WHERE c.category_source <> 'person'
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.conversation_id = c.id)
       AND (SELECT count(*) FROM messages x WHERE x.conversation_id = c.id AND x.direction = 'inbound') = 1`,
  );
  const rulesByWs = new Map<string, CategoryRule[]>();
  let info = 0;
  for (const r of rows) {
    if (!rulesByWs.has(r.workspace_id)) rulesByWs.set(r.workspace_id, await loadCategoryRules(db, r.workspace_id));
    const d = categorizeMail(
      { from: { address: r.from_address, name: r.from_name ?? undefined }, subject: r.subject, bodyText: newestEmailText(r.body_text), headers: r.headers ?? {}, hasOrderReference: r.order_references.length > 0 },
      rulesByWs.get(r.workspace_id),
    );
    await db.query("UPDATE conversations SET category = $3, category_source = $4, category_reason = $5 WHERE workspace_id = $1 AND id = $2", [r.workspace_id, r.id, d.category, d.source, d.reason.slice(0, 500)]);
    if (d.category === "info") {
      info++;
      await db.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [r.workspace_id, r.id]);
      await db.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'als Werbung/Info eingeordnet' WHERE workspace_id = $1 AND conversation_id = $2 AND invalidated_at IS NULL", [r.workspace_id, r.id]);
    }
  }
  return { checked: rows.length, info };
}

/**
 * Joins cases that a customer's follow-up mail split off before follow-ups were
 * recognised: same mailbox, same customer, same order, the later case without any
 * send. Its mails, notes and thread move to the earlier case; drafts of both go,
 * because the earlier case now has a newer customer message.
 */
export async function mergeSplitFollowUps(db: Db): Promise<number> {
  const pairs = await many<{ workspace_id: string; source: string; target: string }>(
    db,
    `SELECT DISTINCT ON (s.id) s.workspace_id, s.id AS source, t.id AS target
       FROM conversations s
       JOIN channel_connections cc ON cc.workspace_id = s.workspace_id AND cc.id = s.connection_id AND cc.kind = 'microsoft_graph'
       JOIN conversations t ON t.workspace_id = s.workspace_id AND t.connection_id = s.connection_id AND t.id <> s.id
        AND t.created_at < s.created_at AND t.category = 'support'
        AND lower(t.customer_address) = lower(s.customer_address)
        AND s.created_at - t.last_message_at < ($1::int * interval '1 day')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.order_references) a, jsonb_array_elements(s.order_references) b WHERE a->>'value' = b->>'value')
      WHERE s.category = 'support' AND s.customer_address IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.workspace_id = s.workspace_id AND o.conversation_id = s.id)
      ORDER BY s.id, t.created_at DESC`,
    [FOLLOW_UP_DAYS],
  );
  let merged = 0;
  for (const p of pairs) {
    await withTx(db, async (tx) => {
      // Lock both; skip when the pair changed meanwhile (e.g. merged in an earlier round).
      const rows = await many<{ id: string; external_thread_key: string; order_references: OrderReference[] }>(tx, "SELECT id, external_thread_key, order_references FROM conversations WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE", [p.workspace_id, [p.source, p.target]]);
      const source = rows.find((r) => r.id === p.source);
      const target = rows.find((r) => r.id === p.target);
      if (!source || !target) return;
      if (await one(tx, "SELECT 1 FROM outbox WHERE workspace_id = $1 AND conversation_id = $2", [p.workspace_id, p.source])) return;
      const ws = p.workspace_id;
      await tx.query("UPDATE messages SET conversation_id = $3 WHERE workspace_id = $1 AND conversation_id = $2", [ws, p.source, p.target]);
      await tx.query("UPDATE internal_notes SET conversation_id = $3 WHERE workspace_id = $1 AND conversation_id = $2", [ws, p.source, p.target]);
      await tx.query("UPDATE message_forwards SET conversation_id = $3 WHERE workspace_id = $1 AND conversation_id = $2", [ws, p.source, p.target]);
      await tx.query("UPDATE conversation_threads SET conversation_id = $3 WHERE workspace_id = $1 AND conversation_id = $2", [ws, p.source, p.target]);
      // Refund list: keep what a person entered; the target's own entry wins.
      await tx.query("UPDATE refund_entries SET conversation_id = $3 WHERE workspace_id = $1 AND conversation_id = $2 AND NOT EXISTS (SELECT 1 FROM refund_entries t WHERE t.workspace_id = $1 AND t.conversation_id = $3)", [ws, p.source, p.target]);
      await tx.query("DELETE FROM refund_entries WHERE workspace_id = $1 AND conversation_id = $2", [ws, p.source]);
      const conn = (await one<{ connection_id: string }>(tx, "SELECT connection_id FROM conversations WHERE workspace_id = $1 AND id = $2", [ws, p.source]))!;
      await tx.query("DELETE FROM conversations WHERE workspace_id = $1 AND id = $2", [ws, p.source]);
      await tx.query("INSERT INTO conversation_threads (workspace_id, connection_id, external_thread_key, conversation_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [ws, conn.connection_id, source.external_thread_key, p.target]);
      const refs = [...target.order_references];
      for (const r of source.order_references) if (!refs.some((x) => x.value === r.value)) refs.push(r);
      await tx.query(
        `UPDATE conversations SET version = version + 1, status = 'open', snooze_until = NULL, order_references = $3, updated_at = now(),
           latest_inbound_message_id = (SELECT id FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'inbound' AND kind = 'customer' ORDER BY received_at DESC LIMIT 1),
           last_message_at = (SELECT max(received_at) FROM messages WHERE workspace_id = $1 AND conversation_id = $2)
         WHERE workspace_id = $1 AND id = $2`,
        [ws, p.target, JSON.stringify(refs.slice(0, 10))],
      );
      await invalidateConversationApprovals(tx, ws, p.target, "Folgemail des Kunden zugeordnet");
      await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [ws, p.target]);
      await audit(tx, { type: "system", workspaceId: ws }, "conversation.follow_up_merged", "conversation", p.target, { from: p.source });
      merged++;
    });
  }
  return merged;
}
