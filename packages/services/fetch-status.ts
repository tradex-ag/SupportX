import { DISPLAY_SYNC_MIN_SEC, isStale } from "../core/fetch-freshness.ts";
import { many } from "../storage/db.ts";
import type { Actor, AppContext } from "./context.ts";
import { enqueue } from "./jobs.ts";

export interface FetchState {
  id: string;
  kind: string;
  displayName: string;
  lastSyncAt: string | null;
  /** Read by the worker on a timer. False for Mirakl until the operator's permission is recorded. */
  background: boolean;
  /** Not read for longer than STALE_AFTER_HOURS. */
  stale: boolean;
  /** A read is queued or running right now. */
  fetching: boolean;
  health: string;
}

/**
 * Called by the SupportX inbox while it is on screen.
 *
 * Mirakl documents its inbox reads (M10/M11) as "synchronous only — at each page
 * that includes an inbox display". The SupportX inbox is such a page, so while a
 * person has it open, Mirakl connections without background permission are read
 * here, at most every DISPLAY_SYNC_MIN_SEC per connection. Nothing is read on a
 * timer when nobody looks; that stays reserved for `backgroundSyncAllowed`.
 *
 * Returns the read state of every active connection for the stale warning.
 */
export async function inboxDisplayed(ctx: AppContext, actor: Actor, opts: { trigger?: boolean } = {}): Promise<{ connections: FetchState[] }> {
  if (opts.trigger !== false) {
    const due = await many<{ id: string }>(
      ctx.db,
      `SELECT id FROM channel_connections
       WHERE workspace_id = $1 AND kind = 'mirakl_inbox' AND NOT paused AND secret_id IS NOT NULL
         AND (config->>'backgroundSyncAllowed')::boolean IS NOT TRUE
         AND (last_sync_at IS NULL OR last_sync_at < now() - ($2::int * interval '1 second'))
         -- After a failure wait 15 minutes, like the worker does.
         AND (health <> 'error' OR last_error_at IS NULL OR last_error_at < now() - interval '15 minutes')`,
      [actor.workspaceId, DISPLAY_SYNC_MIN_SEC],
    );
    for (const row of due) {
      await enqueue(ctx.db, { workspaceId: actor.workspaceId, type: "mail.sync", payload: { connectionId: row.id, trigger: "inbox_display" }, dedupeKey: `mail.sync:${row.id}`, maxAttempts: 3 });
    }
  }
  const rows = await many<{ id: string; kind: string; display_name: string; last_sync_at: Date | null; background: boolean; fetching: boolean; health: string }>(
    ctx.db,
    `SELECT c.id, c.kind, c.display_name, c.last_sync_at, c.health,
            (c.kind <> 'mirakl_inbox' OR (c.config->>'backgroundSyncAllowed')::boolean IS TRUE) AS background,
            EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'mail.sync:' || c.id::text AND j.status IN ('queued','running')) AS fetching
     FROM channel_connections c
     WHERE c.workspace_id = $1 AND NOT c.paused AND c.secret_id IS NOT NULL
       AND (c.kind <> 'ebay_messages' OR c.config ? 'sellerUsername')
     ORDER BY c.display_name`,
    [actor.workspaceId],
  );
  const now = new Date();
  return {
    connections: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      displayName: r.display_name,
      lastSyncAt: r.last_sync_at ? r.last_sync_at.toISOString() : null,
      background: r.background,
      stale: isStale(r.last_sync_at, now),
      fetching: r.fetching,
      health: r.health,
    })),
  };
}
