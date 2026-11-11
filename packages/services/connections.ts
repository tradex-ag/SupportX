import { createHash, randomBytes } from "node:crypto";
import type { CategoryRule } from "../core/category.ts";
import type { MessageChannel, OrderProvider, OrderScopeRule, SourcePlatform } from "../core/contracts.ts";
import type { RoutingRule } from "../core/classify.ts";
import { EbayMessageChannel } from "../connectors/ebay/message-channel.ts";
import { buildEbayAuthorizeUrl, ebayHosts, exchangeEbayCode, fetchEbayUsername, isOfficialEbayHost, type EbayApp } from "../connectors/ebay/oauth.ts";
import { assertAllowedEndpoint } from "../connectors/http.ts";
import { KauflandTicketsChannel } from "../connectors/kaufland/tickets-channel.ts";
import { GraphMailChannel } from "../connectors/microsoft/graph-mail.ts";
import { isOfficialMiraklHost, MiraklInboxChannel } from "../connectors/mirakl/inbox-channel.ts";
import { validateWeclappBaseUrl, WeclappOrderProvider } from "../connectors/weclapp/adapter.ts";
import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { actorFor } from "./auth.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

export type ChannelKind = "microsoft_graph" | "ebay_messages" | "kaufland_tickets" | "mirakl_inbox";

export interface ChannelConnectionRow {
  id: string;
  workspace_id: string;
  kind: ChannelKind;
  display_name: string;
  /** Shape depends on kind; see the *ConnectionSettings interfaces. */
  config: GraphConnectionSettings & EbayConnectionSettings & KauflandConnectionSettings & MiraklConnectionSettings;
  secret_id: string | null;
  default_merchant_account_id: string | null;
  default_source_platform: SourcePlatform;
  send_enabled: boolean;
  paused: boolean;
  health: string;
  last_sync_at: Date | null;
  last_error: string | null;
}

export interface GraphConnectionSettings {
  tenantId: string;
  clientId: string;
  mailbox: string;
  ownAddresses?: string[];
  folders?: string[];
  initialSyncDays?: number;
  graphBaseUrl?: string;
  authorityHost?: string;
  pushNotifications?: boolean;
  clientState?: string;
  subscriptionId?: string;
  subscriptionExpiresAt?: string;
  /** First characters and length of the client secret, as Entra shows them, so admins can match the stored secret. */
  secretHint?: { prefix: string; length: number };
}

/** Shared by the marketplace channels. */
interface PollSettings {
  initialSyncDays?: number;
  /** Minimum seconds between two background syncs of this connection. */
  pollIntervalSec?: number;
}

export interface EbayConnectionSettings extends PollSettings {
  clientId: string;
  ruName: string;
  sandbox?: boolean;
  /** Set by the OAuth callback. */
  sellerUsername?: string;
  grantedScopes?: string[];
  oauthStateHash?: string;
  oauthStateExpiresAt?: string;
  oauthStateUserId?: string;
  /** Test doubles only (ALLOW_TEST_ENDPOINTS). */
  authBaseUrl?: string;
  apiBaseUrl?: string;
  identityBaseUrl?: string;
}

export interface KauflandConnectionSettings extends PollSettings {
  storefronts?: string[];
  baseUrl?: string;
}

export interface MiraklConnectionSettings extends PollSettings {
  baseUrl: string;
  shopId?: string;
  /** Mirakl documents M10/M11 as synchronous only: background polling needs the operator's explicit permission. */
  backgroundSyncAllowed?: boolean;
  backgroundSyncEvidence?: string;
}

/** Secret payload of eBay and Kaufland connections (JSON in the encrypted secrets table). */
export interface EbaySecret {
  clientSecret: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}
interface KauflandSecret {
  clientKey: string;
  secretKey: string;
}

export function parseSecret<T>(secret: string, what: string): T {
  try {
    return JSON.parse(secret) as T;
  } catch {
    throw new Error(`Gespeicherte Zugangsdaten für ${what} sind beschädigt.`);
  }
}

export function ebayApp(row: Pick<ChannelConnectionRow, "config">, clientSecret: string): EbayApp {
  const c = row.config;
  return { clientId: c.clientId, clientSecret, ruName: c.ruName, sandbox: c.sandbox, authBaseUrl: c.authBaseUrl, apiBaseUrl: c.apiBaseUrl, identityBaseUrl: c.identityBaseUrl };
}

export interface ErpConnectionRow {
  id: string;
  workspace_id: string;
  provider: "weclapp";
  display_name: string;
  base_url: string;
  search_fields: string[];
  secret_id: string | null;
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
}

export interface MerchantAccountRow {
  id: string;
  workspace_id: string;
  name: string;
  platform: SourcePlatform;
  order_scope_field: OrderScopeRule["field"];
  order_scope_value: string;
  paused: boolean;
}

/** Builds live adapters from stored configuration. Tests inject fakes here. */
export interface ConnectorFactory {
  channel(row: ChannelConnectionRow, secret: string): MessageChannel;
  orders(row: ErpConnectionRow, secret: string): OrderProvider;
}

/** Builds the channel adapter for a stored connection. Shared by the default and the test factories. */
export function buildChannel(row: ChannelConnectionRow, secret: string, opts: { allowTestEndpoints: boolean; timeoutMs?: number }): MessageChannel {
  const c = row.config;
  switch (row.kind) {
    case "ebay_messages": {
      const s = parseSecret<EbaySecret>(secret, "eBay");
      return new EbayMessageChannel({
        ...ebayApp(row, s.clientSecret),
        refreshToken: s.refreshToken ?? "",
        grantedScopes: c.grantedScopes ?? [],
        sellerUsername: c.sellerUsername ?? "",
        initialSyncDays: c.initialSyncDays,
        allowTestEndpoints: opts.allowTestEndpoints,
        timeoutMs: opts.timeoutMs,
      });
    }
    case "kaufland_tickets": {
      const s = parseSecret<KauflandSecret>(secret, "Kaufland");
      return new KauflandTicketsChannel({ clientKey: s.clientKey, secretKey: s.secretKey, storefronts: c.storefronts, baseUrl: c.baseUrl, initialSyncDays: c.initialSyncDays, allowTestEndpoints: opts.allowTestEndpoints, timeoutMs: opts.timeoutMs });
    }
    case "mirakl_inbox":
      return new MiraklInboxChannel({ baseUrl: c.baseUrl, apiKey: secret, shopId: c.shopId, initialSyncDays: c.initialSyncDays, allowTestEndpoints: opts.allowTestEndpoints, timeoutMs: opts.timeoutMs });
    default:
      return new GraphMailChannel({
        tenantId: c.tenantId,
        clientId: c.clientId,
        clientSecret: secret,
        mailbox: c.mailbox,
        ownAddresses: c.ownAddresses,
        folders: c.folders,
        initialSyncDays: c.initialSyncDays,
        graphBaseUrl: c.graphBaseUrl,
        authorityHost: c.authorityHost,
        allowTestEndpoints: opts.allowTestEndpoints,
        timeoutMs: opts.timeoutMs,
      });
  }
}

export function defaultConnectorFactory(allowTestEndpoints: boolean): ConnectorFactory {
  return {
    channel: (row, secret) => buildChannel(row, secret, { allowTestEndpoints }),
    orders: (row, secret) =>
      new WeclappOrderProvider({ baseUrl: row.base_url, apiToken: secret, searchFields: row.search_fields, allowTestEndpoints }),
  };
}

export async function loadChannelConnection(q: Queryable, workspaceId: string, connectionId: string): Promise<ChannelConnectionRow> {
  const row = await one<ChannelConnectionRow>(q, "SELECT * FROM channel_connections WHERE workspace_id = $1 AND id = $2", [workspaceId, connectionId]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Verbindung nicht gefunden.");
  return row;
}

export async function channelFor(ctx: AppContext, q: Queryable, row: ChannelConnectionRow): Promise<MessageChannel> {
  if (!row.secret_id) throw new ServiceError(409, "NO_CREDENTIALS", "Für diese Verbindung sind keine Zugangsdaten hinterlegt.");
  const secret = await ctx.secrets.read(q, row.workspace_id, row.secret_id);
  try {
    return ctx.connectors.channel(row, secret);
  } catch (error) {
    // Incomplete setup (e.g. eBay consent missing) is a state, not a server error.
    throw new ServiceError(409, "NOT_CONNECTED", (error as Error).message);
  }
}

export async function loadErpConnection(q: Queryable, workspaceId: string): Promise<ErpConnectionRow | null> {
  return one<ErpConnectionRow>(q, "SELECT * FROM erp_connections WHERE workspace_id = $1 AND provider = 'weclapp'", [workspaceId]);
}

export async function orderProviderFor(ctx: AppContext, q: Queryable, row: ErpConnectionRow): Promise<OrderProvider> {
  if (!row.secret_id) throw new ServiceError(409, "NO_CREDENTIALS", "Für die weclapp-Verbindung ist kein API-Token hinterlegt.");
  return ctx.connectors.orders(row, await ctx.secrets.read(q, row.workspace_id, row.secret_id));
}

export async function loadRoutingRules(q: Queryable, workspaceId: string, connectionId: string): Promise<RoutingRule[]> {
  const rows = await many<{ id: string; priority: number; match_type: RoutingRule["matchType"]; pattern: string; source_platform: SourcePlatform; merchant_account_id: string | null }>(
    q,
    "SELECT id, priority, match_type, pattern, source_platform, merchant_account_id FROM routing_rules WHERE workspace_id = $1 AND connection_id = $2",
    [workspaceId, connectionId],
  );
  return rows.map((r) => ({ id: r.id, priority: r.priority, matchType: r.match_type, pattern: r.pattern, sourcePlatform: r.source_platform, merchantAccountId: r.merchant_account_id }));
}

export async function loadCategoryRules(q: Queryable, workspaceId: string): Promise<CategoryRule[]> {
  const rows = await many<{ id: string; match_type: CategoryRule["matchType"]; pattern: string; category: CategoryRule["category"] }>(
    q, "SELECT id, match_type, pattern, category FROM category_rules WHERE workspace_id = $1", [workspaceId]);
  return rows.map((r) => ({ id: r.id, matchType: r.match_type, pattern: r.pattern, category: r.category }));
}

// ---------------------------------------------------------------------------
// Setup (owner only). Secrets are written once and never returned.

const PLATFORMS: ReadonlyArray<SourcePlatform> = ["email", "amazon", "ebay", "kaufland", "shop_apotheke", "docmorris", "shopify"];

export function assertPlatform(value: string): SourcePlatform {
  if (!PLATFORMS.includes(value as SourcePlatform)) throw new ServiceError(400, "INVALID", `Unbekannte Plattform: ${value}`);
  return value as SourcePlatform;
}

export async function createMerchantAccount(ctx: AppContext, actor: Actor, input: { name: string; platform: string; orderScopeField: string; orderScopeValue: string }): Promise<string> {
  requireRole(actor, ["owner"]);
  const field = input.orderScopeField as OrderScopeRule["field"];
  if (!["salesChannel", "customerId", "ecommerceConnectionId", "tag", "none"].includes(field)) throw new ServiceError(400, "INVALID", "Ungültiges Zuordnungsfeld.");
  if (field !== "none" && !input.orderScopeValue.trim()) throw new ServiceError(400, "INVALID", "Für das Zuordnungsfeld wird ein Wert benötigt.");
  if (!input.name.trim()) throw new ServiceError(400, "INVALID", "Name fehlt.");
  return withTx(ctx.db, async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      "INSERT INTO merchant_accounts (workspace_id, name, platform, order_scope_field, order_scope_value) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [actor.workspaceId, input.name.trim(), assertPlatform(input.platform), field, input.orderScopeValue.trim()],
    );
    await audit(tx, actor, "merchant_account.created", "merchant_account", row!.id, { platform: input.platform, scopeField: field });
    return row!.id;
  });
}

export async function upsertWeclappConnection(ctx: AppContext, actor: Actor, input: { baseUrl: string; apiToken?: string; searchFields?: string[] }): Promise<string> {
  requireRole(actor, ["owner"]);
  let baseUrl: string;
  try {
    baseUrl = validateWeclappBaseUrl(input.baseUrl, ctx.config.ALLOW_TEST_ENDPOINTS);
  } catch (error) {
    throw new ServiceError(400, "INVALID_URL", (error as Error).message);
  }
  const searchFields = input.searchFields?.length ? input.searchFields : ["orderNumberAtCustomer", "orderNumber"];
  return withTx(ctx.db, async (tx) => {
    const existing = await loadErpConnection(tx, actor.workspaceId);
    if (!existing && !input.apiToken) throw new ServiceError(400, "INVALID", "API-Token fehlt.");
    // Store a token the operator created for this purpose. This application never
    // generates or rotates weclapp tokens (rotation can break other integrations).
    const secretId = input.apiToken ? await ctx.secrets.store(tx, actor.workspaceId, "weclapp_api_token", input.apiToken) : existing!.secret_id;
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO erp_connections (workspace_id, provider, display_name, base_url, search_fields, secret_id)
       VALUES ($1, 'weclapp', 'weclapp', $2, $3, $4)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET base_url = EXCLUDED.base_url, search_fields = EXCLUDED.search_fields, secret_id = EXCLUDED.secret_id, status = 'configured', last_error = NULL
       RETURNING id`,
      [actor.workspaceId, baseUrl, searchFields, secretId],
    );
    await audit(tx, actor, "erp_connection.saved", "erp_connection", row!.id, { baseUrl, tokenReplaced: !!input.apiToken });
    return row!.id;
  });
}

export async function createGraphConnection(
  ctx: AppContext,
  actor: Actor,
  input: { displayName: string; tenantId: string; clientId: string; clientSecret: string; mailbox: string; ownAddresses?: string[]; defaultMerchantAccountId?: string | null; defaultSourcePlatform?: string; graphBaseUrl?: string; authorityHost?: string; initialSyncDays?: number; pushNotifications?: boolean },
): Promise<string> {
  requireRole(actor, ["owner"]);
  for (const [key, value] of Object.entries({ tenantId: input.tenantId, clientId: input.clientId, clientSecret: input.clientSecret, mailbox: input.mailbox })) {
    if (!value?.trim()) throw new ServiceError(400, "INVALID", `${key} fehlt.`);
  }
  // Pasted secrets often carry a trailing space or line break, which Entra rejects as an invalid secret.
  const clientSecret = checkedClientSecret(input.clientSecret);
  const settings: GraphConnectionSettings = {
    tenantId: input.tenantId.trim(),
    clientId: input.clientId.trim(),
    mailbox: input.mailbox.trim().toLowerCase(),
    ownAddresses: (input.ownAddresses ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean),
    folders: ["inbox", "sentitems"],
    initialSyncDays: input.initialSyncDays ?? 14,
    clientState: randomBytes(24).toString("base64url"),
    pushNotifications: input.pushNotifications === true,
    secretHint: { prefix: clientSecret.slice(0, 3), length: clientSecret.length },
    ...(input.graphBaseUrl ? { graphBaseUrl: input.graphBaseUrl } : {}),
    ...(input.authorityHost ? { authorityHost: input.authorityHost } : {}),
  };
  try {
    // Validates endpoints and tenant format without contacting Microsoft.
    defaultConnectorFactory(ctx.config.ALLOW_TEST_ENDPOINTS).channel({ config: settings } as ChannelConnectionRow, clientSecret);
  } catch (error) {
    throw new ServiceError(400, "INVALID", (error as Error).message);
  }
  return withTx(ctx.db, async (tx) => {
    const existing = await one(tx, "SELECT 1 FROM channel_connections WHERE workspace_id = $1 AND NOT paused AND config->>'mailbox' = $2", [actor.workspaceId, settings.mailbox]);
    if (existing) throw new ServiceError(409, "DUPLICATE", "Dieses Postfach ist schon verbunden. Für einen neuen Schlüssel bei der bestehenden Verbindung „Schlüssel austauschen“ nutzen.");
    if (input.defaultMerchantAccountId) {
      const ok = await one(tx, "SELECT 1 FROM merchant_accounts WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, input.defaultMerchantAccountId]);
      if (!ok) throw new ServiceError(400, "INVALID", "Verkäuferkonto gehört nicht zu diesem Arbeitsbereich.");
    }
    const secretId = await ctx.secrets.store(tx, actor.workspaceId, "microsoft_client_secret", clientSecret);
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO channel_connections (workspace_id, kind, display_name, config, secret_id, default_merchant_account_id, default_source_platform)
       VALUES ($1, 'microsoft_graph', $2, $3, $4, $5, $6) RETURNING id`,
      [actor.workspaceId, input.displayName.trim() || input.mailbox, JSON.stringify(settings), secretId, input.defaultMerchantAccountId ?? null, assertPlatform(input.defaultSourcePlatform ?? "email")],
    );
    await audit(tx, actor, "channel_connection.created", "channel_connection", row!.id, { mailbox: settings.mailbox });
    return row!.id;
  });
}

// ---------------------------------------------------------------------------
// Marketplace channels (owner only). Sending stays off until a reply route is verified.

async function insertChannel(
  tx: Queryable,
  actor: Actor,
  input: { kind: ChannelKind; displayName: string; config: object; secretPurpose: string; secret: string; platform: SourcePlatform; defaultMerchantAccountId?: string | null },
  ctx: AppContext,
): Promise<string> {
  if (input.defaultMerchantAccountId) {
    const ok = await one(tx, "SELECT 1 FROM merchant_accounts WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, input.defaultMerchantAccountId]);
    if (!ok) throw new ServiceError(400, "INVALID", "Verkäuferkonto gehört nicht zu diesem Arbeitsbereich.");
  }
  const secretId = await ctx.secrets.store(tx, actor.workspaceId, input.secretPurpose, input.secret);
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO channel_connections (workspace_id, kind, display_name, config, secret_id, default_merchant_account_id, default_source_platform)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.workspaceId, input.kind, input.displayName, JSON.stringify(input.config), secretId, input.defaultMerchantAccountId ?? null, input.platform],
  );
  await audit(tx, actor, "channel_connection.created", "channel_connection", row!.id, { kind: input.kind });
  return row!.id;
}

function required(fields: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(fields)) if (!value?.trim()) throw new ServiceError(400, "INVALID", `${key} fehlt.`);
}

/** Validate settings by building the adapter offline (endpoint allow-list, formats). */
function validateOffline(ctx: AppContext, kind: ChannelKind, config: object, secret: string): void {
  try {
    if (kind === "ebay_messages") {
      const c = config as EbayConnectionSettings;
      for (const host of Object.values(ebayHosts(c))) assertAllowedEndpoint(host, ctx.config.ALLOW_TEST_ENDPOINTS, isOfficialEbayHost);
      return;
    }
    buildChannel({ kind, config } as ChannelConnectionRow, secret, { allowTestEndpoints: ctx.config.ALLOW_TEST_ENDPOINTS });
  } catch (error) {
    throw new ServiceError(400, "INVALID", (error as Error).message);
  }
}

export async function createKauflandConnection(
  ctx: AppContext,
  actor: Actor,
  input: { displayName: string; clientKey: string; secretKey: string; storefronts?: string[]; defaultMerchantAccountId?: string | null; baseUrl?: string; initialSyncDays?: number },
): Promise<string> {
  requireRole(actor, ["owner"]);
  required({ clientKey: input.clientKey, secretKey: input.secretKey });
  const config: KauflandConnectionSettings = {
    storefronts: (input.storefronts ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
    initialSyncDays: input.initialSyncDays ?? 14,
    // Bounded polling: no ticket push is documented.
    pollIntervalSec: 300,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  };
  const secret = JSON.stringify({ clientKey: input.clientKey.trim(), secretKey: input.secretKey.trim() } satisfies KauflandSecret);
  validateOffline(ctx, "kaufland_tickets", config, secret);
  return withTx(ctx.db, (tx) =>
    insertChannel(tx, actor, { kind: "kaufland_tickets", displayName: input.displayName.trim() || "Kaufland", config, secretPurpose: "kaufland_api_keys", secret, platform: "kaufland", defaultMerchantAccountId: input.defaultMerchantAccountId }, ctx),
  );
}

export async function createMiraklConnection(
  ctx: AppContext,
  actor: Actor,
  input: { displayName: string; baseUrl: string; apiKey: string; shopId?: string; defaultMerchantAccountId?: string | null; initialSyncDays?: number },
): Promise<string> {
  requireRole(actor, ["owner"]);
  required({ baseUrl: input.baseUrl, apiKey: input.apiKey });
  const config: MiraklConnectionSettings = {
    baseUrl: input.baseUrl.trim(),
    ...(input.shopId?.trim() ? { shopId: input.shopId.trim() } : {}),
    initialSyncDays: input.initialSyncDays ?? 14,
    backgroundSyncAllowed: false,
    pollIntervalSec: 900,
  };
  validateOffline(ctx, "mirakl_inbox", config, input.apiKey.trim());
  return withTx(ctx.db, (tx) =>
    insertChannel(tx, actor, { kind: "mirakl_inbox", displayName: input.displayName.trim() || "Shop Apotheke", config, secretPurpose: "mirakl_api_key", secret: input.apiKey.trim(), platform: "shop_apotheke", defaultMerchantAccountId: input.defaultMerchantAccountId }, ctx),
  );
}

/**
 * Mirakl documents its inbox reads as "synchronous only". Background polling is
 * switched on only with a recorded note of the operator's permission; without it
 * the inbox is read when someone clicks "Jetzt abrufen".
 */
export async function setMiraklBackgroundSync(ctx: AppContext, actor: Actor, connectionId: string, input: { allowed: boolean; evidenceNote?: string }): Promise<void> {
  requireRole(actor, ["owner"]);
  if (input.allowed && (input.evidenceNote?.trim().length ?? 0) < 10) throw new ServiceError(400, "INVALID", "Bitte festhalten, wo der Betreiber den Hintergrundabruf erlaubt hat (mindestens 10 Zeichen).");
  await withTx(ctx.db, async (tx) => {
    const row = await loadChannelConnection(tx, actor.workspaceId, connectionId);
    if (row.kind !== "mirakl_inbox") throw new ServiceError(400, "INVALID", "Nur für Mirakl-Verbindungen.");
    const patch = input.allowed ? { backgroundSyncAllowed: true, backgroundSyncEvidence: input.evidenceNote!.trim() } : { backgroundSyncAllowed: false };
    await tx.query("UPDATE channel_connections SET config = config || $3::jsonb WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId, JSON.stringify(patch)]);
    await audit(tx, actor, input.allowed ? "mirakl.background_sync_allowed" : "mirakl.background_sync_disabled", "channel_connection", connectionId);
  });
}

export async function createEbayConnection(
  ctx: AppContext,
  actor: Actor,
  input: { displayName: string; clientId: string; clientSecret: string; ruName: string; sandbox?: boolean; defaultMerchantAccountId?: string | null; initialSyncDays?: number; authBaseUrl?: string; apiBaseUrl?: string; identityBaseUrl?: string },
): Promise<string> {
  requireRole(actor, ["owner"]);
  required({ clientId: input.clientId, clientSecret: input.clientSecret, ruName: input.ruName });
  const config: EbayConnectionSettings = {
    clientId: input.clientId.trim(),
    ruName: input.ruName.trim(),
    sandbox: input.sandbox === true,
    initialSyncDays: input.initialSyncDays ?? 14,
    pollIntervalSec: 300,
    ...(input.authBaseUrl ? { authBaseUrl: input.authBaseUrl } : {}),
    ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
    ...(input.identityBaseUrl ? { identityBaseUrl: input.identityBaseUrl } : {}),
  };
  validateOffline(ctx, "ebay_messages", config, "");
  const secret = JSON.stringify({ clientSecret: input.clientSecret.trim() } satisfies EbaySecret);
  return withTx(ctx.db, (tx) =>
    insertChannel(tx, actor, { kind: "ebay_messages", displayName: input.displayName.trim() || "eBay", config, secretPurpose: "ebay_oauth", secret, platform: "ebay", defaultMerchantAccountId: input.defaultMerchantAccountId }, ctx),
  );
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Start the eBay consent. The state is single-use, bound to this user and valid for 15 minutes. */
export async function startEbayConsent(ctx: AppContext, actor: Actor, connectionId: string): Promise<string> {
  requireRole(actor, ["owner"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Die eBay-Anmeldung startet nur ein Mensch.");
  const row = await loadChannelConnection(ctx.db, actor.workspaceId, connectionId);
  if (row.kind !== "ebay_messages" || !row.secret_id) throw new ServiceError(400, "INVALID", "Keine eBay-Verbindung.");
  const state = randomBytes(32).toString("base64url");
  await ctx.db.query("UPDATE channel_connections SET config = config || $3::jsonb WHERE workspace_id = $1 AND id = $2", [
    actor.workspaceId,
    connectionId,
    JSON.stringify({ oauthStateHash: hashState(state), oauthStateExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), oauthStateUserId: actor.userId }),
  ]);
  const secret = parseSecret<EbaySecret>(await ctx.secrets.read(ctx.db, row.workspace_id, row.secret_id), "eBay");
  return buildEbayAuthorizeUrl(ebayApp(row, secret.clientSecret), state);
}

/**
 * OAuth callback: exchange the code, read the seller username and store the
 * refresh token encrypted. The signed-in owner who started the consent must be
 * the one finishing it.
 */
export async function completeEbayConsent(ctx: AppContext, userId: string, input: { state: string; code: string }, fetchImpl?: typeof fetch): Promise<{ workspaceId: string; connectionId: string; sellerUsername: string }> {
  if (!input.state || !input.code) throw new ServiceError(400, "INVALID", "eBay-Antwort unvollständig.");
  const row = await one<ChannelConnectionRow>(ctx.db, "SELECT * FROM channel_connections WHERE kind = 'ebay_messages' AND config->>'oauthStateHash' = $1", [hashState(input.state)]);
  if (!row) throw new ServiceError(400, "INVALID_STATE", "Die eBay-Anmeldung ist unbekannt oder wurde schon verwendet. Bitte neu starten.");
  const actor = userId === row.config.oauthStateUserId ? await actorFor(ctx.db, userId, row.workspace_id).catch(() => null) : null;
  if (!actor) {
    throw new ServiceError(403, "FORBIDDEN", "Bitte die eBay-Anmeldung im selben angemeldeten Konto abschließen, in dem sie gestartet wurde.");
  }
  requireRole(actor, ["owner"]);
  // Single use: clear the state before talking to eBay.
  await ctx.db.query("UPDATE channel_connections SET config = config - 'oauthStateHash' - 'oauthStateExpiresAt' - 'oauthStateUserId' WHERE id = $1", [row.id]);
  if (!row.config.oauthStateExpiresAt || new Date(row.config.oauthStateExpiresAt).getTime() < Date.now()) {
    throw new ServiceError(400, "INVALID_STATE", "Die eBay-Anmeldung ist abgelaufen. Bitte neu starten.");
  }
  const old = parseSecret<EbaySecret>(await ctx.secrets.read(ctx.db, row.workspace_id, row.secret_id!), "eBay");
  const app = { ...ebayApp(row, old.clientSecret), fetchImpl };
  const tokens = await exchangeEbayCode(app, input.code);
  if (!tokens.refreshToken) throw new ServiceError(502, "NO_REFRESH_TOKEN", "eBay lieferte keinen Refresh-Token.");
  const sellerUsername = await fetchEbayUsername(app, tokens.accessToken);
  await withTx(ctx.db, async (tx) => {
    const secretId = await ctx.secrets.store(tx, row.workspace_id, "ebay_oauth", JSON.stringify({ clientSecret: old.clientSecret, refreshToken: tokens.refreshToken, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } satisfies EbaySecret));
    await tx.query(
      "UPDATE channel_connections SET secret_id = $3, config = config || $4::jsonb, health = 'unknown', last_error = NULL WHERE workspace_id = $1 AND id = $2",
      [row.workspace_id, row.id, secretId, JSON.stringify({ sellerUsername, grantedScopes: tokens.scopes })],
    );
    await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [row.workspace_id, row.secret_id]);
    await audit(tx, actor, "ebay.connected", "channel_connection", row.id, { sellerUsername });
  });
  return { workspaceId: row.workspace_id, connectionId: row.id, sellerUsername };
}

export async function addRoutingRule(ctx: AppContext, actor: Actor, connectionId: string, input: { matchType: string; pattern: string; sourcePlatform: string; merchantAccountId?: string | null; priority?: number }): Promise<string> {
  requireRole(actor, ["owner"]);
  if (!["from_domain", "from_address", "to_address", "subject_contains"].includes(input.matchType)) throw new ServiceError(400, "INVALID", "Ungültiger Regeltyp.");
  if (!input.pattern.trim()) throw new ServiceError(400, "INVALID", "Muster fehlt.");
  return withTx(ctx.db, async (tx) => {
    await loadChannelConnection(tx, actor.workspaceId, connectionId);
    const row = await one<{ id: string }>(
      tx,
      "INSERT INTO routing_rules (workspace_id, connection_id, priority, match_type, pattern, source_platform, merchant_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [actor.workspaceId, connectionId, input.priority ?? 100, input.matchType, input.pattern.trim().toLowerCase(), assertPlatform(input.sourcePlatform), input.merchantAccountId || null],
    );
    await audit(tx, actor, "routing_rule.created", "routing_rule", row!.id, { matchType: input.matchType, pattern: input.pattern, sourcePlatform: input.sourcePlatform });
    return row!.id;
  });
}

export async function deleteRoutingRule(ctx: AppContext, actor: Actor, ruleId: string): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const res = await tx.query("DELETE FROM routing_rules WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, ruleId]);
    if (res.rowCount === 0) throw new ServiceError(404, "NOT_FOUND", "Regel nicht gefunden.");
    await audit(tx, actor, "routing_rule.deleted", "routing_rule", ruleId);
  });
}

/**
 * Record that a controlled reply over this connection reached the right external
 * thread for a platform (e.g. DocMorris). Required before sending is possible.
 */
export async function verifyReplyRoute(ctx: AppContext, actor: Actor, connectionId: string, input: { sourcePlatform: string; evidenceNote: string }): Promise<void> {
  requireRole(actor, ["owner"]);
  if (input.evidenceNote.trim().length < 10) throw new ServiceError(400, "INVALID", "Bitte den Nachweis der Testantwort beschreiben (mindestens 10 Zeichen).");
  await withTx(ctx.db, async (tx) => {
    await loadChannelConnection(tx, actor.workspaceId, connectionId);
    const platform = assertPlatform(input.sourcePlatform);
    await tx.query("UPDATE reply_route_verifications SET revoked_at = now() WHERE connection_id = $1 AND source_platform = $2 AND revoked_at IS NULL", [connectionId, platform]);
    await tx.query(
      "INSERT INTO reply_route_verifications (workspace_id, connection_id, source_platform, verified_by, evidence_note) VALUES ($1, $2, $3, $4, $5)",
      [actor.workspaceId, connectionId, platform, actor.type === "user" ? actor.userId : null, input.evidenceNote.trim()],
    );
    await audit(tx, actor, "reply_route.verified", "channel_connection", connectionId, { sourcePlatform: platform });
  });
}

export async function revokeReplyRoute(ctx: AppContext, actor: Actor, connectionId: string, sourcePlatform: string): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    await loadChannelConnection(tx, actor.workspaceId, connectionId);
    await tx.query("UPDATE reply_route_verifications SET revoked_at = now() WHERE workspace_id = $1 AND connection_id = $2 AND source_platform = $3 AND revoked_at IS NULL", [actor.workspaceId, connectionId, sourcePlatform]);
    await audit(tx, actor, "reply_route.revoked", "channel_connection", connectionId, { sourcePlatform });
  });
}

export async function setSendEnabled(ctx: AppContext, actor: Actor, connectionId: string, enabled: boolean): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    await loadChannelConnection(tx, actor.workspaceId, connectionId);
    await tx.query("UPDATE channel_connections SET send_enabled = $3 WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId, enabled]);
    await audit(tx, actor, enabled ? "sending.enabled" : "sending.disabled", "channel_connection", connectionId);
  });
}

/**
 * One click per marketplace: allow or stop replies for this platform over this
 * connection. Allowing records the owner's click as the reply-route check and
 * turns sending on for the connection; every single reply still needs its own
 * approval in the case. Stopping revokes the route (and, for a marketplace API
 * connection that serves only this platform, turns sending off).
 */
export async function setPlatformSending(ctx: AppContext, actor: Actor, connectionId: string, sourcePlatform: string, enabled: boolean): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    const row = await loadChannelConnection(tx, actor.workspaceId, connectionId);
    const platform = assertPlatform(sourcePlatform);
    await tx.query("UPDATE reply_route_verifications SET revoked_at = now() WHERE workspace_id = $1 AND connection_id = $2 AND source_platform = $3 AND revoked_at IS NULL", [actor.workspaceId, connectionId, platform]);
    if (enabled) {
      await tx.query(
        "INSERT INTO reply_route_verifications (workspace_id, connection_id, source_platform, verified_by, evidence_note) VALUES ($1, $2, $3, $4, $5)",
        [actor.workspaceId, connectionId, platform, actor.type === "user" ? actor.userId : null, "Versand per Klick auf der Marktplatz-Karte freigeschaltet. Die erste Antwort im Marktplatz kontrollieren."],
      );
      await tx.query("UPDATE channel_connections SET send_enabled = true WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId]);
    } else if (row.kind !== "microsoft_graph") {
      await tx.query("UPDATE channel_connections SET send_enabled = false WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId]);
    }
    await audit(tx, actor, enabled ? "sending.platform_enabled" : "sending.platform_disabled", "channel_connection", connectionId, { sourcePlatform: platform });
  });
}

function checkedClientSecret(raw: string): string {
  const secret = raw.trim();
  if (!secret) throw new ServiceError(400, "INVALID", "clientSecret fehlt.");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret)) {
    throw new ServiceError(400, "INVALID", "Das ist die „Geheime ID“ aus Entra, nicht der „Wert“. Bitte in Entra die Spalte „Wert“ kopieren (etwa 40 Zeichen, meist mit ~). Ist der Wert nur noch als „abc***“ zu sehen, einen neuen Schlüssel anlegen.");
  }
  return secret;
}

/** Replaces the client secret of a Microsoft connection, e.g. after rotation in Entra. */
export async function replaceConnectionSecret(ctx: AppContext, actor: Actor, connectionId: string, rawSecret: string): Promise<void> {
  requireRole(actor, ["owner"]);
  const clientSecret = checkedClientSecret(rawSecret);
  await withTx(ctx.db, async (tx) => {
    const row = await loadChannelConnection(tx, actor.workspaceId, connectionId);
    if (row.kind !== "microsoft_graph") throw new ServiceError(400, "INVALID", "Nur für Microsoft-Postfächer. Marktplatz-Zugänge bitte löschen und neu verbinden.");
    const secretId = await ctx.secrets.store(tx, actor.workspaceId, "microsoft_client_secret", clientSecret);
    const config = { ...row.config, secretHint: { prefix: clientSecret.slice(0, 3), length: clientSecret.length } };
    await tx.query("UPDATE channel_connections SET secret_id = $3, config = $4, health = 'unknown', last_error = NULL, last_error_at = NULL WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId, secretId, JSON.stringify(config)]);
    if (row.secret_id) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.secret_id]);
    await audit(tx, actor, "connection.secret_replaced", "channel_connection", connectionId);
  });
}

/**
 * Removes a connection, e.g. a duplicate or one set up with a wrong secret, together with the cases it imported.
 * Refused once anything was sent through it, so the send record stays complete.
 */
export async function deleteConnection(ctx: AppContext, actor: Actor, connectionId: string): Promise<{ deletedCases: number }> {
  requireRole(actor, ["owner"]);
  return withTx(ctx.db, async (tx) => {
    const row = await loadChannelConnection(tx, actor.workspaceId, connectionId);
    const sent = await one(tx, "SELECT 1 FROM outbox o JOIN conversations c ON c.workspace_id = o.workspace_id AND c.id = o.conversation_id WHERE c.workspace_id = $1 AND c.connection_id = $2 LIMIT 1", [actor.workspaceId, connectionId]);
    if (sent) throw new ServiceError(409, "IN_USE", "Über diese Verbindung wurde schon etwas verschickt. Sie kann nur pausiert werden.");
    const cases = await tx.query<{ id: string }>("SELECT id FROM conversations WHERE workspace_id = $1 AND connection_id = $2", [actor.workspaceId, connectionId]);
    const ids = cases.rows.map((r) => r.id);
    await tx.query("DELETE FROM jobs WHERE workspace_id = $1 AND status IN ('queued','failed') AND (payload->>'connectionId' = $2 OR payload->>'conversationId' = ANY($3::text[]))", [actor.workspaceId, connectionId, ids]);
    await tx.query("DELETE FROM conversations WHERE workspace_id = $1 AND connection_id = $2", [actor.workspaceId, connectionId]);
    await tx.query("DELETE FROM channel_connections WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId]);
    if (row.secret_id) await tx.query("DELETE FROM secrets WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, row.secret_id]);
    await audit(tx, actor, "channel_connection.deleted", "channel_connection", connectionId, { mailbox: row.config.mailbox, deletedCases: ids.length });
    return { deletedCases: ids.length };
  });
}

export async function setConnectionPaused(ctx: AppContext, actor: Actor, connectionId: string, paused: boolean): Promise<void> {
  requireRole(actor, ["owner"]);
  await withTx(ctx.db, async (tx) => {
    await loadChannelConnection(tx, actor.workspaceId, connectionId);
    await tx.query("UPDATE channel_connections SET paused = $3 WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId, paused]);
    await audit(tx, actor, paused ? "connection.paused" : "connection.resumed", "channel_connection", connectionId);
  });
}

export async function checkChannel(ctx: AppContext, actor: Actor, connectionId: string): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await loadChannelConnection(ctx.db, actor.workspaceId, connectionId);
  const result = await (await channelFor(ctx, ctx.db, row)).checkAccess();
  await ctx.db.query("UPDATE channel_connections SET health = $3, last_error = $4, last_error_at = CASE WHEN $3 = 'error' THEN now() END WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, connectionId, result.ok ? "ok" : "error", result.ok ? null : result.detail]);
  return result;
}

export async function checkErp(ctx: AppContext, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  requireRole(actor, ["owner"]);
  const row = await loadErpConnection(ctx.db, actor.workspaceId);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Keine weclapp-Verbindung konfiguriert.");
  const result = await (await orderProviderFor(ctx, ctx.db, row)).checkAccess();
  await ctx.db.query("UPDATE erp_connections SET status = $2, last_error = $3, last_checked_at = now() WHERE id = $1", [row.id, result.ok ? "ok" : "error", result.ok ? null : result.detail]);
  return result;
}
