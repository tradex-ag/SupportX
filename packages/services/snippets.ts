import { many, one, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * Text blocks of a workspace ("Textbausteine"). Everyone in the team may use them;
 * owners and agents may write them. Placeholders are filled per case (see core/snippets.ts).
 */
export interface SnippetRow { id: string; title: string; body: string; updated_at: string }

const UUID = /^[0-9a-f-]{36}$/i;

export async function listSnippets(ctx: AppContext, actor: Actor): Promise<SnippetRow[]> {
  return many<SnippetRow>(ctx.db, "SELECT id, title, body, updated_at FROM reply_snippets WHERE workspace_id = $1 ORDER BY lower(title)", [actor.workspaceId]);
}

export async function getSnippet(ctx: AppContext, actor: Actor, snippetId: string): Promise<SnippetRow> {
  if (!UUID.test(snippetId)) throw new ServiceError(404, "NOT_FOUND", "Textbaustein nicht gefunden.");
  const row = await one<SnippetRow>(ctx.db, "SELECT id, title, body, updated_at FROM reply_snippets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, snippetId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Textbaustein nicht gefunden.");
  return row;
}

/** Creates (without id) or changes a text block. */
export async function saveSnippet(ctx: AppContext, actor: Actor, input: { id?: string; title?: string; body?: string }): Promise<SnippetRow> {
  requireRole(actor, ["owner", "agent"]);
  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!title || title.length > 120) throw new ServiceError(400, "INVALID", "Bitte einen Namen mit höchstens 120 Zeichen eingeben.");
  if (!body || body.length > 10_000) throw new ServiceError(400, "INVALID", "Der Text ist leer oder länger als 10.000 Zeichen.");
  return withTx(ctx.db, async (tx) => {
    let row: SnippetRow | null;
    if (input.id) {
      if (!UUID.test(input.id)) throw new ServiceError(404, "NOT_FOUND", "Textbaustein nicht gefunden.");
      row = await one<SnippetRow>(
        tx,
        "UPDATE reply_snippets SET title = $3, body = $4, updated_by = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING id, title, body, updated_at",
        [actor.workspaceId, input.id, title, body, actorId(actor)],
      );
      if (!row) throw new ServiceError(404, "NOT_FOUND", "Textbaustein nicht gefunden.");
    } else {
      const count = await one<{ n: number }>(tx, "SELECT count(*)::int AS n FROM reply_snippets WHERE workspace_id = $1", [actor.workspaceId]);
      if ((count?.n ?? 0) >= 500) throw new ServiceError(400, "INVALID", "Höchstens 500 Textbausteine je Arbeitsbereich.");
      row = await one<SnippetRow>(
        tx,
        "INSERT INTO reply_snippets (workspace_id, title, body, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id, title, body, updated_at",
        [actor.workspaceId, title, body, actorId(actor)],
      );
    }
    await audit(tx, actor, input.id ? "snippet.updated" : "snippet.created", "workspace", actor.workspaceId, { snippetId: row!.id, title });
    return row!;
  });
}

export async function deleteSnippet(ctx: AppContext, actor: Actor, snippetId: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(snippetId)) throw new ServiceError(404, "NOT_FOUND", "Textbaustein nicht gefunden.");
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query("DELETE FROM reply_snippets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, snippetId]);
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Textbaustein nicht gefunden.");
    await audit(tx, actor, "snippet.deleted", "workspace", actor.workspaceId, { snippetId });
  });
}
