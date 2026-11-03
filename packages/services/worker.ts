import { autoInvoice } from "./invoices.ts";
import { AiProviderError } from "../ai/index.ts";
import { many } from "../storage/db.ts";
import { reopenDueFollowUps } from "./cases.ts";
import type { AppContext } from "./context.ts";
import { runMailSync } from "./ingestion.ts";
import { claimJob, completeJob, enqueue, failJob, type JobRow } from "./jobs.ts";
import { enrichConversation, RetryableError } from "./matching.ts";
import type { ReplyDecision } from "../core/contracts.ts";
import { DispatchRetry, dispatchOutbox, generateDraft, reconcileOutbox, sweepStaleDispatches } from "./replies.ts";
import { HttpError } from "../connectors/http.ts";
import { GraphMailChannel } from "../connectors/microsoft/graph-mail.ts";
import { channelFor, loadChannelConnection } from "./connections.ts";

/**
 * Optional Graph change notifications. They only trigger a delta sync; the
 * delta round remains the source of truth. Needs a public HTTPS PUBLIC_BASE_URL.
 */
async function maintainSubscription(ctx: AppContext, workspaceId: string, connectionId: string): Promise<void> {
  const row = await loadChannelConnection(ctx.db, workspaceId, connectionId);
  if (row.kind !== "microsoft_graph" || !row.config.pushNotifications || row.paused) return;
  if (!ctx.config.PUBLIC_BASE_URL.startsWith("https://")) throw new HttpError("Change Notifications benötigen eine öffentliche HTTPS-Adresse (PUBLIC_BASE_URL).", 0, false);
  const channel = await channelFor(ctx, ctx.db, row);
  if (!(channel instanceof GraphMailChannel)) return;
  const result = await channel.upsertSubscription({
    existingId: row.config.subscriptionId,
    notificationUrl: `${ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/microsoft/${row.id}`,
    clientState: row.config.clientState!,
    // Renewed daily; well inside the documented maximum for message subscriptions.
    minutes: 2 * 24 * 60,
  });
  await ctx.db.query(
    "UPDATE channel_connections SET config = config || $3::jsonb WHERE workspace_id = $1 AND id = $2",
    [workspaceId, connectionId, JSON.stringify({ subscriptionId: result.id, subscriptionExpiresAt: result.expiresAt })],
  );
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError || error instanceof DispatchRetry) return true;
  if (error instanceof AiProviderError) return error.retryable;
  if (error instanceof HttpError) return error.retryable;
  return true;
}

/** Each job carries its workspace id; handlers reload all data within that scope. */
export async function runJob(ctx: AppContext, job: JobRow): Promise<void> {
  const ws = job.workspace_id;
  const p = job.payload as Record<string, string>;
  if (!ws) throw new Error(`Job ${job.id} ohne Arbeitsbereich.`);
  switch (job.type) {
    case "mail.sync":
      await runMailSync(ctx, ws, p.connectionId!);
      return;
    case "case.enrich":
      await enrichConversation(ctx, ws, p.conversationId!);
      // Invoice requests: only when the workspace switched it on (no AI, fixed template).
      await autoInvoice(ctx, ws, p.conversationId!);
      return;
    case "case.draft":
      await generateDraft(ctx, ws, p.conversationId!, p.decision as ReplyDecision | undefined);
      return;
    case "outbox.dispatch":
      await dispatchOutbox(ctx, ws, p.outboxId!);
      return;
    case "outbox.reconcile": {
      const result = await reconcileOutbox(ctx, ws, p.outboxId!);
      // Exchange can take a moment to file the sent copy: look again a few times, never resend.
      if ((result === "still_uncertain" || result === "accepted_unconfirmed") && job.attempts < job.max_attempts) throw new RetryableError("Gesendetes Exemplar noch nicht gefunden.");
      return;
    }
    case "mail.subscription":
      await maintainSubscription(ctx, ws, p.connectionId!);
      return;
  }
}

/** Process ready jobs until none is left (used by the worker loop and by tests). */
export async function drainJobs(ctx: AppContext, opts: { maxJobs?: number; log?: (line: string) => void } = {}): Promise<number> {
  let processed = 0;
  while (processed < (opts.maxJobs ?? 1000)) {
    const job = await claimJob(ctx.db);
    if (!job) break;
    processed++;
    try {
      await runJob(ctx, job);
      await completeJob(ctx.db, job.id);
      opts.log?.(`Job ${job.type} erledigt`);
    } catch (error) {
      const message = (error as Error).message;
      opts.log?.(`Job ${job.type} #${job.id} fehlgeschlagen: ${message}`);
      await failJob(ctx.db, job, message, isRetryable(error));
    }
  }
  return processed;
}

/** Periodic triggers: mailbox reconciliation for active connections and the dispatch sweeper. */
export async function scheduleTick(ctx: AppContext): Promise<void> {
  const due = await many<{ id: string; workspace_id: string }>(
    ctx.db,
    `SELECT id, workspace_id FROM channel_connections
     WHERE NOT paused AND secret_id IS NOT NULL
       -- eBay only after the seller's consent; Mirakl only with the operator's permission for background reads.
       AND (kind <> 'ebay_messages' OR config ? 'sellerUsername')
       AND (kind <> 'mirakl_inbox' OR (config->>'backgroundSyncAllowed')::boolean IS TRUE)
       AND (last_sync_at IS NULL OR last_sync_at < now() - (greatest($1::int, coalesce((config->>'pollIntervalSec')::int, 0)) * interval '1 second'))
       -- After a failure wait 15 minutes; "Zugriff prüfen" or a new secret clears the error at once.
       AND (health <> 'error' OR last_error_at IS NULL OR last_error_at < now() - interval '15 minutes')`,
    [ctx.config.MAIL_SYNC_INTERVAL_SEC],
  );
  for (const row of due) {
    await enqueue(ctx.db, { workspaceId: row.workspace_id, type: "mail.sync", payload: { connectionId: row.id }, dedupeKey: `mail.sync:${row.id}`, maxAttempts: 3 });
  }
  const renew = await many<{ id: string; workspace_id: string }>(
    ctx.db,
    `SELECT id, workspace_id FROM channel_connections
     WHERE NOT paused AND kind = 'microsoft_graph' AND (config->>'pushNotifications')::boolean IS TRUE
       AND (config->>'subscriptionExpiresAt' IS NULL OR (config->>'subscriptionExpiresAt')::timestamptz < now() + interval '1 day')`,
  );
  for (const row of renew) {
    await enqueue(ctx.db, { workspaceId: row.workspace_id, type: "mail.subscription", payload: { connectionId: row.id }, dedupeKey: `mail.subscription:${row.id}`, maxAttempts: 3, delayMs: 0 });
  }
  await sweepStaleDispatches(ctx);
  await reopenDueFollowUps(ctx);
}
