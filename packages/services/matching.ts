import type { OrderLookupResult, OrderRecord, OrderScopeRule, ReferenceQuery } from "../core/contracts.ts";
import { toReferenceQuery, type OrderReference } from "../core/references.ts";
import { many, one, withTx, type Tx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { loadErpConnection, orderProviderFor, type MerchantAccountRow } from "./connections.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { invalidateConversationApprovals } from "./ingestion.ts";
import { enqueue } from "./jobs.ts";

export type MatchStatus = "unique" | "ambiguous" | "missing" | "no_reference" | "no_account" | "error";

interface ConvRow {
  id: string;
  workspace_id: string;
  merchant_account_id: string | null;
  order_references: OrderReference[];
}

export class RetryableError extends Error {}

async function storeLink(
  tx: Tx,
  conv: ConvRow,
  status: MatchStatus,
  result: OrderLookupResult | null,
  refs: ReadonlyArray<string>,
  linkedBy: "auto" | "user",
  userId: string | null,
): Promise<void> {
  await tx.query("UPDATE order_links SET is_current = false WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [conv.workspace_id, conv.id]);
  const unique = result?.status === "unique" ? result : null;
  await tx.query(
    `INSERT INTO order_links (workspace_id, conversation_id, merchant_account_id, status, references_tried, candidates, external_order_id, matched_by, linked_by, linked_by_user_id, error, snapshot, retrieved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      conv.workspace_id, conv.id, conv.merchant_account_id, status, JSON.stringify(refs),
      JSON.stringify(result?.status === "ambiguous" ? result.candidates : []),
      unique?.order.id ?? null, unique?.matchedBy ?? null, linkedBy, userId,
      result?.status === "error" ? result.error : result?.status === "missing" && result.rejectedFilters?.length ? `weclapp kennt einen Suchfilter nicht (${result.rejectedFilters.join(", ")}), dort wurde nicht gesucht.`
        : result?.status === "missing" && result.outOfScopeMatches ? `${result.outOfScopeMatches} Treffer gehören zu einem anderen Verkäuferkonto.` : null,
      unique ? JSON.stringify(unique.order) : null, unique ? unique.order.retrievedAt : null,
    ],
  );
  // Changed order evidence makes earlier approvals stale.
  await tx.query("UPDATE conversations SET order_match_status = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [conv.workspace_id, conv.id, status]);
  await invalidateConversationApprovals(tx, conv.workspace_id, conv.id, "Bestellzuordnung geändert");
}

/**
 * Order numbers are unique in the merchant's weclapp, so a case without a
 * merchant account (or whose account finds nothing) searches all of weclapp.
 */
export const ALL_ORDERS: OrderScopeRule = { field: "none", value: "" };

/** The one merchant account whose weclapp rule fits the order, if exactly one does. */
async function accountForOrder(tx: Tx, workspaceId: string, order: OrderRecord): Promise<string | null> {
  const accounts = await many<MerchantAccountRow>(tx, "SELECT * FROM merchant_accounts WHERE workspace_id = $1 AND NOT paused", [workspaceId]);
  const fits = accounts.filter((a) => {
    switch (a.order_scope_field) {
      case "salesChannel": return order.salesChannel === a.order_scope_value;
      case "customerId": return order.customerId === a.order_scope_value;
      case "ecommerceConnectionId": return order.ecommerceConnectionId === a.order_scope_value;
      case "tag": return order.tags.includes(a.order_scope_value);
      default: return false;
    }
  });
  return fits.length === 1 ? fits[0]!.id : null;
}

/**
 * Match a conversation to exactly one weclapp order by the numbers in the mail.
 * Missing reference, several candidates or an error stay visible for manual
 * clarification; nothing falls back to a looser (non-exact) match. A unique hit
 * on a case without an account also fills in the account whose rule fits.
 */
export async function enrichConversation(ctx: AppContext, workspaceId: string, conversationId: string, opts: { manualReference?: string; actor?: Actor } = {}): Promise<MatchStatus> {
  const conv = await one<ConvRow>(ctx.db, "SELECT id, workspace_id, merchant_account_id, order_references FROM conversations WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId]);
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  // A number typed by staff may be any of the three; a number from the mail is looked up where its label says.
  const manual = opts.manualReference?.trim();
  const queries: ReferenceQuery[] = manual ? (["order", "invoice", "tracking"] as const).map((kind) => ({ value: manual, kind })) : conv.order_references.map(toReferenceQuery);
  const refs = [...new Set(queries.map((q) => q.value))];
  const linkedBy = opts.actor?.type === "user" ? "user" : "auto";
  const userId = opts.actor ? actorId(opts.actor) : null;

  const finish = async (status: MatchStatus, result: OrderLookupResult | null) => {
    await withTx(ctx.db, async (tx) => {
      if (result?.status === "unique" && !conv.merchant_account_id) {
        const accountId = await accountForOrder(tx, workspaceId, result.order);
        if (accountId) {
          await tx.query("UPDATE conversations SET merchant_account_id = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId, accountId]);
          conv.merchant_account_id = accountId;
        }
      }
      await storeLink(tx, conv, status, result, refs, linkedBy, userId);
      await audit(tx, opts.actor ?? { type: "system", workspaceId }, "order.matched", "conversation", conversationId, { status, references: refs });
    });
    return status;
  };

  if (refs.length === 0) return finish("no_reference", null);
  const erp = await loadErpConnection(ctx.db, workspaceId);
  if (!erp) return finish("error", { status: "error", error: "Keine weclapp-Verbindung konfiguriert.", retryable: false });

  const account = conv.merchant_account_id
    ? await one<MerchantAccountRow>(ctx.db, "SELECT * FROM merchant_accounts WHERE workspace_id = $1 AND id = $2", [workspaceId, conv.merchant_account_id])
    : null;
  let result: OrderLookupResult;
  try {
    const provider = await orderProviderFor(ctx, ctx.db, erp);
    result = account ? await provider.findOrders(queries, { field: account.order_scope_field, value: account.order_scope_value }) : await provider.findOrders(queries, ALL_ORDERS);
    if (account && result.status === "missing") result = await provider.findOrders(queries, ALL_ORDERS);
  } catch (error) {
    result = { status: "error", error: (error as Error).message, retryable: false };
  }
  if (result.status === "error") {
    await ctx.db.query("UPDATE erp_connections SET status = 'error', last_error = $2 WHERE id = $1", [erp.id, result.error]);
    await finish("error", result);
    if (result.retryable && !opts.actor) throw new RetryableError(result.error);
    return "error";
  }
  return finish(result.status, result);
}

/** Staff action: link by an order reference or pick one of the ambiguous candidates. */
export async function linkOrderManually(ctx: AppContext, actor: Actor, conversationId: string, input: { reference?: string; candidateId?: string }): Promise<MatchStatus> {
  requireRole(actor, ["owner", "agent"]);
  if (input.candidateId) {
    const conv = await one(ctx.db, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId]);
    if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    const link = await one<{ candidates: Array<{ id: string }> }>(ctx.db, "SELECT candidates FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [actor.workspaceId, conversationId]);
    if (!link?.candidates.some((c) => c.id === input.candidateId)) throw new ServiceError(400, "INVALID", "Kandidat gehört nicht zu diesem Fall.");
    const erp = await loadErpConnection(ctx.db, actor.workspaceId);
    if (!erp) throw new ServiceError(409, "NO_ERP", "Keine weclapp-Verbindung konfiguriert.");
    const result = await (await orderProviderFor(ctx, ctx.db, erp)).getOrder(input.candidateId, ALL_ORDERS);
    const convRow = (await one<ConvRow>(ctx.db, "SELECT id, workspace_id, merchant_account_id, order_references FROM conversations WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId]))!;
    const status: MatchStatus = result.status === "unique" ? "unique" : result.status === "error" ? "error" : "missing";
    await withTx(ctx.db, async (tx) => {
      await storeLink(tx, convRow, status, result, [input.candidateId!], "user", actorId(actor));
      await audit(tx, actor, "order.linked_manually", "conversation", conversationId, { candidateId: input.candidateId, status });
    });
    return status;
  }
  if (!input.reference?.trim()) throw new ServiceError(400, "INVALID", "Bestellnummer fehlt.");
  return enrichConversation(ctx, actor.workspaceId, conversationId, { manualReference: input.reference, actor });
}

/**
 * Staff action: read the linked order again from weclapp (e.g. to see a return
 * created after the case came in). Keeps the link; when nothing but the
 * retrieval time changed, approvals stay valid.
 */
export async function refreshOrderLink(ctx: AppContext, actor: Actor, conversationId: string): Promise<{ status: MatchStatus; changed: boolean }> {
  requireRole(actor, ["owner", "agent"]);
  const conv = await one<ConvRow>(ctx.db, "SELECT id, workspace_id, merchant_account_id, order_references FROM conversations WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId]);
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const link = await one<{ id: string; external_order_id: string | null; references_tried: string[]; matched_by: string | null; linked_by: "auto" | "user"; linked_by_user_id: string | null; snapshot: OrderRecord | null }>(
    ctx.db, "SELECT id, external_order_id, references_tried, matched_by, linked_by, linked_by_user_id, snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [actor.workspaceId, conversationId],
  );
  if (!link?.external_order_id) throw new ServiceError(409, "NO_ORDER", "Dem Fall ist keine Bestellung zugeordnet.");
  const erp = await loadErpConnection(ctx.db, actor.workspaceId);
  if (!erp) throw new ServiceError(409, "NO_ERP", "Keine weclapp-Verbindung konfiguriert.");
  const result = await (await orderProviderFor(ctx, ctx.db, erp)).getOrder(link.external_order_id, ALL_ORDERS);
  if (result.status === "error") throw new ServiceError(502, "ERP_ERROR", `weclapp: ${result.error}`);
  if (result.status !== "unique") throw new ServiceError(409, "ORDER_GONE", "Die Bestellung ist in weclapp nicht mehr zu finden. Bitte neu zuordnen.");
  // jsonb does not keep key order, so compare a canonical form (sorted keys, without the retrieval time).
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  const strip = (o: OrderRecord | null) => (o ? JSON.stringify(canonical({ ...o, retrievedAt: undefined })) : null);
  const changed = strip(link.snapshot) !== strip(result.order);
  await withTx(ctx.db, async (tx) => {
    if (changed) {
      const keep: OrderLookupResult = { ...result, matchedBy: link.matched_by ?? result.matchedBy };
      await storeLink(tx, conv, "unique", keep, link.references_tried, link.linked_by, link.linked_by_user_id);
    } else {
      await tx.query("UPDATE order_links SET snapshot = $3, retrieved_at = $4 WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, link.id, JSON.stringify(result.order), result.order.retrievedAt]);
    }
    await audit(tx, actor, "order.refreshed", "conversation", conversationId, { changed });
  });
  return { status: "unique", changed };
}

export async function setConversationAccount(ctx: AppContext, actor: Actor, conversationId: string, merchantAccountId: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  await withTx(ctx.db, async (tx) => {
    const account = await one(tx, "SELECT 1 FROM merchant_accounts WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, merchantAccountId]);
    if (!account) throw new ServiceError(400, "INVALID", "Verkäuferkonto gehört nicht zu diesem Arbeitsbereich.");
    const res = await tx.query(
      "UPDATE conversations SET merchant_account_id = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [actor.workspaceId, conversationId, merchantAccountId],
    );
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
    await invalidateConversationApprovals(tx, actor.workspaceId, conversationId, "Verkäuferkonto geändert");
    await enqueue(tx, { workspaceId: actor.workspaceId, type: "case.enrich", payload: { conversationId }, dedupeKey: `case.enrich:${conversationId}` });
    await audit(tx, actor, "conversation.account_set", "conversation", conversationId, { merchantAccountId });
  });
}
