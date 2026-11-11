import { AMAZON_MARKETPLACES, amazonMarketplace, maskIdentifier, type AmazonRegion } from "../core/amazon-marketplaces.ts";
import { AmazonListingsClient, type ListingInfo } from "../connectors/amazon/listings.ts";
import { HttpError } from "../connectors/http.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { parseSecret } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * Close a wrong Amazon offer from a case (e.g. the listing shows two bottles,
 * the article is one). Only a signed-in person can do it, always after reading
 * the listing and confirming; never the worker, an automation or the AI.
 */

interface ConnectionRow {
  id: string;
  workspace_id: string;
  region: AmazonRegion;
  seller_id: string;
  marketplace_ids: string[];
  client_id: string;
  secret_id: string;
  api_base_url: string | null;
  token_url: string | null;
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
}

interface AmazonSecret {
  clientSecret: string;
  refreshToken: string;
}

const PENDING_STALE_MS = 5 * 60_000;

async function loadConnection(q: Queryable, workspaceId: string): Promise<ConnectionRow | null> {
  return one<ConnectionRow>(q, "SELECT * FROM amazon_listing_connections WHERE workspace_id = $1", [workspaceId]);
}

async function clientFor(ctx: AppContext, q: Queryable, row: ConnectionRow): Promise<AmazonListingsClient> {
  const secret = parseSecret<AmazonSecret>(await ctx.secrets.read(q, row.workspace_id, row.secret_id), "Amazon");
  try {
    return new AmazonListingsClient({
      region: row.region,
      sellerId: row.seller_id,
      clientId: row.client_id,
      clientSecret: secret.clientSecret,
      refreshToken: secret.refreshToken,
      apiBaseUrl: row.api_base_url ?? undefined,
      tokenUrl: row.token_url ?? undefined,
      allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS,
    });
  } catch (error) {
    throw new ServiceError(409, "NOT_CONNECTED", (error as Error).message);
  }
}

/** What the settings page may see: identifiers masked, secrets only as "hinterlegt". */
export async function getAmazonListingSettings(ctx: AppContext, actor: Actor) {
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) return { configured: false as const, marketplaces: AMAZON_MARKETPLACES };
  return {
    configured: true as const,
    marketplaces: AMAZON_MARKETPLACES,
    region: row.region,
    sellerIdHint: maskIdentifier(row.seller_id),
    clientIdHint: maskIdentifier(row.client_id),
    marketplaceIds: row.marketplace_ids,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
  };
}

export interface AmazonConnectionInput {
  region?: string;
  marketplaceIds?: string[];
  sellerId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** Test doubles only. */
  apiBaseUrl?: string;
  tokenUrl?: string;
}

/**
 * Create or change the access. On a change, fields left empty keep their stored
 * value, so a person can e.g. replace only the refresh token.
 */
export async function saveAmazonListingConnection(ctx: AppContext, actor: Actor, input: AmazonConnectionInput): Promise<void> {
  requireRole(actor, ["owner"]);
  const t = (v?: string) => v?.trim() || undefined;
  await withTx(ctx.db, async (tx) => {
    const existing = await loadConnection(tx, actor.workspaceId);
    const region = (t(input.region) ?? existing?.region) as AmazonRegion | undefined;
    if (!region || !["eu", "na", "fe"].includes(region)) throw new ServiceError(400, "INVALID", "Bitte die Amazon-Region wählen.");
    const marketplaceIds = input.marketplaceIds ? [...new Set(input.marketplaceIds.map((m) => m.trim()).filter(Boolean))] : existing?.marketplace_ids ?? [];
    if (marketplaceIds.length === 0) throw new ServiceError(400, "INVALID", "Bitte mindestens einen Marktplatz wählen.");
    for (const id of marketplaceIds) {
      const m = amazonMarketplace(id);
      if (!m) throw new ServiceError(400, "INVALID", `Unbekannter Amazon-Marktplatz: ${id}`);
      if (m.region !== region) throw new ServiceError(400, "INVALID", `${m.label} gehört nicht zur gewählten Region.`);
    }
    const sellerId = t(input.sellerId) ?? existing?.seller_id;
    const clientId = t(input.clientId) ?? existing?.client_id;
    const old = existing ? parseSecret<AmazonSecret>(await ctx.secrets.read(tx, actor.workspaceId, existing.secret_id), "Amazon") : null;
    const clientSecret = t(input.clientSecret) ?? old?.clientSecret;
    const refreshToken = t(input.refreshToken) ?? old?.refreshToken;
    if (!sellerId) throw new ServiceError(400, "INVALID", "Verkäufer-ID (Merchant Token) fehlt.");
    if (!clientId) throw new ServiceError(400, "INVALID", "LWA Client-ID fehlt.");
    if (!clientSecret) throw new ServiceError(400, "INVALID", "LWA Client-Secret fehlt.");
    if (!refreshToken) throw new ServiceError(400, "INVALID", "Refresh-Token fehlt.");
    if (!/^Atzr\|/.test(refreshToken)) throw new ServiceError(400, "INVALID", "Das sieht nicht wie ein Amazon-Refresh-Token aus (beginnt mit „Atzr|“).");
    const apiBaseUrl = t(input.apiBaseUrl) ?? existing?.api_base_url ?? null;
    const tokenUrl = t(input.tokenUrl) ?? existing?.token_url ?? null;
    try {
      // Offline check: formats and the endpoint allow-list, no call to Amazon.
      new AmazonListingsClient({ region, sellerId, clientId, clientSecret, refreshToken, apiBaseUrl: apiBaseUrl ?? undefined, tokenUrl: tokenUrl ?? undefined, allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
    } catch (error) {
      throw new ServiceError(400, "INVALID", (error as Error).message);
    }
    const secretChanged = !old || clientSecret !== old.clientSecret || refreshToken !== old.refreshToken;
    const secretId = secretChanged ? await ctx.secrets.store(tx, actor.workspaceId, "amazon_sp_api", JSON.stringify({ clientSecret, refreshToken } satisfies AmazonSecret)) : existing!.secret_id;
    await tx.query(
      `INSERT INTO amazon_listing_connections (workspace_id, region, seller_id, marketplace_ids, client_id, secret_id, api_base_url, token_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id) DO UPDATE SET region = EXCLUDED.region, seller_id = EXCLUDED.seller_id, marketplace_ids = EXCLUDED.marketplace_ids,
         client_id = EXCLUDED.client_id, secret_id = EXCLUDED.secret_id, api_base_url = EXCLUDED.api_base_url, token_url = EXCLUDED.token_url,
         status = 'configured', last_error = NULL, updated_at = now()`,
      [actor.workspaceId, region, sellerId, marketplaceIds, clientId, secretId, apiBaseUrl, tokenUrl],
    );
    if (existing && secretChanged) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, existing.secret_id]);
    await audit(tx, actor, existing ? "amazon_listings.changed" : "amazon_listings.connected", "workspace", actor.workspaceId, { region, marketplaceIds, secretReplaced: !!existing && secretChanged });
  });
}

export async function deleteAmazonListingConnection(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadConnection(tx, actor.workspaceId);
    if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein Amazon-Zugang hinterlegt.");
    await tx.query("DELETE FROM amazon_listing_connections WHERE workspace_id = $1", [actor.workspaceId]);
    await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.secret_id]);
    await audit(tx, actor, "amazon_listings.removed", "workspace", actor.workspaceId);
  });
}

export async function checkAmazonListingConnection(ctx: AppContext, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await loadConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Kein Amazon-Zugang hinterlegt.");
  const result = await (await clientFor(ctx, ctx.db, row)).checkAccess(row.marketplace_ids[0]!);
  await ctx.db.query("UPDATE amazon_listing_connections SET status = $2, last_error = $3, last_checked_at = now() WHERE workspace_id = $1", [actor.workspaceId, result.ok ? "ok" : "error", result.ok ? null : result.detail]);
  return result;
}

// ---------------------------------------------------------------------------
// In the case

async function assertCase(q: Queryable, workspaceId: string, conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const ok = await one(q, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId]);
  if (!ok) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
}

function checkedTarget(row: ConnectionRow | null, input: { sku: string; marketplaceId: string }): { row: ConnectionRow; sku: string; marketplaceId: string } {
  if (!row) throw new ServiceError(409, "NOT_CONNECTED", "Kein Amazon-Zugang hinterlegt. Bitte in den Einstellungen unter „Amazon-Angebote“ eintragen.");
  const sku = input.sku?.trim() ?? "";
  if (!sku || sku.length > 200) throw new ServiceError(400, "INVALID", "Bitte die Amazon-SKU (Händler-SKU) angeben.");
  if (!row.marketplace_ids.includes(input.marketplaceId)) throw new ServiceError(400, "INVALID", "Dieser Marktplatz ist für den Amazon-Zugang nicht freigegeben.");
  return { row, sku, marketplaceId: input.marketplaceId };
}

export interface ListingView extends ListingInfo {
  /** Buyable now and has an offer that can be closed. */
  canClose: boolean;
}

function view(listing: ListingInfo): ListingView {
  return { ...listing, canClose: listing.offers.length > 0 && listing.status.includes("BUYABLE") };
}

/** Read the listing as Amazon has it now, so the person sees what would be closed. Changes nothing. */
export async function lookupAmazonListing(ctx: AppContext, actor: Actor, conversationId: string, input: { sku: string; marketplaceId: string }): Promise<ListingView> {
  requireRole(actor, ["owner", "agent"]);
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const { row, sku, marketplaceId } = checkedTarget(await loadConnection(ctx.db, actor.workspaceId), input);
  try {
    const listing = await (await clientFor(ctx, ctx.db, row)).getListing(sku, marketplaceId);
    if (!listing) throw new ServiceError(404, "LISTING_NOT_FOUND", `Unter der SKU „${sku}“ gibt es in diesem Konto auf ${amazonMarketplace(marketplaceId)?.label ?? marketplaceId} kein Angebot.`);
    return view(listing);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "AMAZON_ERROR", (error as Error).message);
  }
}

export interface CloseOfferResult {
  state: "accepted" | "rejected" | "uncertain";
  sku: string;
  asin?: string;
  submissionId?: string;
  issues: Array<{ code: string; message: string; severity: string }>;
}

/**
 * Close the offer. Needs confirm=true from the confirmation dialog and the ASIN
 * the person saw, so a listing that changed in between is not closed blindly.
 */
export async function closeAmazonOffer(ctx: AppContext, actor: Actor, conversationId: string, input: { sku: string; marketplaceId: string; confirm: boolean; expectedAsin?: string }): Promise<CloseOfferResult> {
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Ein Amazon-Angebot deaktiviert nur ein Mensch, nie eine Automatik.");
  requireRole(actor, ["owner", "agent"]);
  if (input.confirm !== true) throw new ServiceError(400, "CONFIRM_REQUIRED", "Bitte das Deaktivieren im Dialog bestätigen.");
  await assertCase(ctx.db, actor.workspaceId, conversationId);
  const { row, sku, marketplaceId } = checkedTarget(await loadConnection(ctx.db, actor.workspaceId), input);
  const client = await clientFor(ctx, ctx.db, row);

  let listing: ListingInfo | null;
  try {
    listing = await client.getListing(sku, marketplaceId);
  } catch (error) {
    throw new ServiceError(502, "AMAZON_ERROR", (error as Error).message);
  }
  if (!listing) throw new ServiceError(404, "LISTING_NOT_FOUND", `Unter der SKU „${sku}“ gibt es kein Angebot mehr.`);
  if (input.expectedAsin && listing.asin && input.expectedAsin !== listing.asin) throw new ServiceError(409, "LISTING_CHANGED", "Das Angebot bei Amazon hat sich geändert. Bitte neu prüfen.");
  if (listing.offers.length === 0) throw new ServiceError(409, "NO_OFFER", "Dieses Angebot hat bei Amazon keinen Verkaufspreis mehr, es ist schon geschlossen.");
  if (!listing.productType) throw new ServiceError(409, "NO_PRODUCT_TYPE", "Amazon nennt keinen Produkttyp für dieses Angebot. Bitte in Seller Central deaktivieren.");

  // Reserve: one request at a time per offer. A pending row older than 5 minutes means the process died mid-request.
  const actionId = await withTx(ctx.db, async (tx) => {
    await tx.query(
      "UPDATE listing_actions SET state = 'uncertain', error = 'Keine Antwort erhalten (Abbruch).', finished_at = now() WHERE workspace_id = $1 AND platform = 'amazon' AND marketplace_id = $2 AND sku = $3 AND state = 'pending' AND created_at < $4",
      [actor.workspaceId, marketplaceId, sku, new Date(ctx.now().getTime() - PENDING_STALE_MS)],
    );
    const res = await tx.query<{ id: string }>(
      `INSERT INTO listing_actions (workspace_id, conversation_id, action, marketplace_id, sku, asin, item_name, state, requested_by)
       VALUES ($1, $2, 'close_offer', $3, $4, $5, $6, 'pending', $7) ON CONFLICT DO NOTHING RETURNING id`,
      [actor.workspaceId, conversationId, marketplaceId, sku, listing!.asin ?? null, listing!.itemName?.slice(0, 500) ?? null, actor.userId],
    );
    if (!res.rows[0]) throw new ServiceError(409, "IN_PROGRESS", "Für dieses Angebot läuft gerade schon eine Anfrage.");
    return res.rows[0].id;
  });

  let result: CloseOfferResult;
  let error: string | null = null;
  try {
    const patch = await client.closeOffer(listing, ctx.now());
    const accepted = patch.status === "ACCEPTED" || patch.status === "VALID";
    result = { state: accepted ? "accepted" : "rejected", sku, asin: listing.asin, submissionId: patch.submissionId, issues: patch.issues };
    if (!accepted) error = patch.issues.map((i) => i.message).filter(Boolean).join("; ") || `Amazon-Status ${patch.status}`;
  } catch (e) {
    const uncertain = e instanceof HttpError && e.uncertain;
    error = (e as Error).message;
    result = { state: uncertain ? "uncertain" : "rejected", sku, asin: listing.asin, issues: [] };
  }
  await withTx(ctx.db, async (tx) => {
    await tx.query("UPDATE listing_actions SET state = $3, submission_id = $4, issues = $5, error = $6, finished_at = now() WHERE workspace_id = $1 AND id = $2", [
      actor.workspaceId, actionId, result.state, result.submissionId ?? null, JSON.stringify(result.issues), error,
    ]);
    await audit(tx, actor, `amazon.offer_close_${result.state}`, "conversation", conversationId, { sku, marketplaceId, asin: listing!.asin, submissionId: result.submissionId, listingActionId: actionId });
  });
  if (result.state === "rejected" && result.issues.length === 0) throw new ServiceError(502, "AMAZON_ERROR", error ?? "Amazon hat die Änderung abgelehnt.");
  return result;
}

export async function listCaseListingActions(q: Queryable, workspaceId: string, conversationId: string) {
  return many(
    q,
    `SELECT a.id, a.platform, a.action, a.marketplace_id, a.sku, a.asin, a.item_name, a.state, a.submission_id, a.issues, a.error, a.created_at, a.finished_at, u.display_name AS requested_by
       FROM listing_actions a JOIN users u ON u.id = a.requested_by
      WHERE a.workspace_id = $1 AND a.conversation_id = $2 ORDER BY a.created_at`,
    [workspaceId, conversationId],
  );
}

/** For the case view: is the button available, and for which marketplaces. No credentials. */
export async function caseAmazonListingAccess(q: Queryable, workspaceId: string): Promise<{ marketplaceIds: string[] } | null> {
  const row = await one<{ marketplace_ids: string[] }>(q, "SELECT marketplace_ids FROM amazon_listing_connections WHERE workspace_id = $1", [workspaceId]);
  return row ? { marketplaceIds: row.marketplace_ids } : null;
}
