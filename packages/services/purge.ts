import type { Tx } from "../storage/db.ts";

/**
 * Deletes all data of one workspace in dependency order (used by the demo reset
 * and by operators who need to remove a tenant). Users stay; memberships go.
 */
export async function purgeWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  const steps = [
    "UPDATE conversations SET latest_inbound_message_id = NULL WHERE workspace_id = $1",
    "DELETE FROM message_forwards WHERE workspace_id = $1",
    "DELETE FROM outbox WHERE workspace_id = $1",
    "DELETE FROM approvals WHERE workspace_id = $1",
    "DELETE FROM drafts WHERE workspace_id = $1",
    "DELETE FROM order_links WHERE workspace_id = $1",
    "DELETE FROM internal_notes WHERE workspace_id = $1",
    "DELETE FROM messages WHERE workspace_id = $1",
    "DELETE FROM case_presence WHERE workspace_id = $1",
    "DELETE FROM conversations WHERE workspace_id = $1",
    "DELETE FROM reply_snippets WHERE workspace_id = $1",
    "DELETE FROM routing_rules WHERE workspace_id = $1",
    "DELETE FROM reply_route_verifications WHERE workspace_id = $1",
    "DELETE FROM sync_cursors WHERE workspace_id = $1",
    "DELETE FROM channel_connections WHERE workspace_id = $1",
    "DELETE FROM erp_connections WHERE workspace_id = $1",
    "DELETE FROM merchant_accounts WHERE workspace_id = $1",
    "DELETE FROM jobs WHERE workspace_id = $1",
    "DELETE FROM workspaces WHERE id = $1",
  ];
  for (const sql of steps) await tx.query(sql, [workspaceId]);
}
