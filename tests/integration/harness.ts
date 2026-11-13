import { randomBytes } from "node:crypto";
import { GraphMailChannel } from "../../packages/connectors/microsoft/graph-mail.ts";
import { WeclappOrderProvider } from "../../packages/connectors/weclapp/adapter.ts";
import { createUser } from "../../packages/services/auth.ts";
import { createContext } from "../../packages/services/bootstrap.ts";
import { addRoutingRule, buildChannel, createGraphConnection, createMerchantAccount, upsertWeclappConnection, type ConnectorFactory } from "../../packages/services/connections.ts";
import type { Actor, AppContext } from "../../packages/services/context.ts";
import { enqueue } from "../../packages/services/jobs.ts";
import { drainJobs } from "../../packages/services/worker.ts";
import { loadConfig, operatorEbayApp } from "../../packages/storage/config.ts";
import { createPool, many, one, type Db } from "../../packages/storage/db.ts";
import { migrate } from "../../packages/storage/migrate.ts";
import { DEMO, demoInboundMails, demoWeclappData } from "../../packages/testing/demo-data.ts";
import { startFakeGraph, type FakeGraph } from "../../packages/testing/fake-graph.ts";
import { startFakeWeclapp, type FakeWeclapp } from "../../packages/testing/fake-weclapp.ts";

/** Integration tests need a disposable PostgreSQL database; all tables are truncated. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://supportx:supportx@127.0.0.1:5432/supportx_test";

let pool: Db | null = null;
export async function testDb(): Promise<Db> {
  if (!pool) {
    pool = createPool(TEST_DATABASE_URL);
    await migrate(pool);
  }
  const tables = await many<{ tablename: string }>(pool, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  await pool.query(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  return pool;
}
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

export interface Harness {
  ctx: AppContext;
  weclapp: FakeWeclapp;
  graph: FakeGraph;
  close(): Promise<void>;
}

export async function createHarness(opts: { sendMode?: "drafts_only" | "enabled"; graphTimeoutMs?: number; mailbox?: string } = {}): Promise<Harness> {
  const db = await testDb();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ALLOW_TEST_ENDPOINTS: "true",
    SEND_MODE: opts.sendMode ?? "drafts_only",
    AI_PROVIDER: "rules",
  });
  const weclapp = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken });
  const graph = await startFakeGraph({ mailbox: opts.mailbox ?? DEMO.mailbox, clientSecret: DEMO.graphSecret, hangMs: 400 });
  const connectors: ConnectorFactory = {
    channel: (row, secret) =>
      row.kind !== "microsoft_graph" ? buildChannel(row, secret, { allowTestEndpoints: true, timeoutMs: opts.graphTimeoutMs ?? 2000, ebayOperator: operatorEbayApp(config) }) :
      new GraphMailChannel({
        tenantId: row.config.tenantId, clientId: row.config.clientId, clientSecret: secret, mailbox: row.config.mailbox, ownAddresses: row.config.ownAddresses,
        graphBaseUrl: row.config.graphBaseUrl, authorityHost: row.config.authorityHost, allowTestEndpoints: true, timeoutMs: opts.graphTimeoutMs ?? 2000,
      }),
    orders: (row, secret) => new WeclappOrderProvider({ baseUrl: row.base_url, apiToken: secret, searchFields: row.search_fields, allowTestEndpoints: true }),
  };
  const ctx = createContext(config, { db, connectors });
  return { ctx, weclapp, graph, close: async () => { await weclapp.close(); await graph.close(); } };
}

export interface SeededWorkspace {
  workspaceId: string;
  connectionId: string;
  owner: Actor;
  agent: Actor;
  viewer: Actor;
  ownerUserId: string;
  agentEmail: string;
  accounts: Record<"amazon" | "docmorris" | "shopify" | "ebay", string>;
}

export async function seedWorkspace(h: Harness, name = "Testhändler"): Promise<SeededWorkspace> {
  const { ctx } = h;
  const ws = (await one<{ id: string }>(ctx.db, "INSERT INTO workspaces (name, allowed_link_prefixes) VALUES ($1, $2) RETURNING id", [name, ["https://tracking.demo.invalid/"]]))!.id;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const users: Record<string, string> = {};
  for (const role of ["owner", "agent", "viewer"] as const) {
    users[role] = await createUser(ctx.db, { email: `${role}@${slug}.example.invalid`, displayName: `${role} ${name}`, password: "test-passwort-123" });
    await ctx.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [ws, users[role], role]);
  }
  const system: Actor = { type: "worker", workspaceId: ws };
  const accounts = {
    amazon: await createMerchantAccount(ctx, system, { name: "Amazon", platform: "amazon", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.amazon }),
    docmorris: await createMerchantAccount(ctx, system, { name: "DocMorris", platform: "docmorris", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.docmorris }),
    shopify: await createMerchantAccount(ctx, system, { name: "Shop", platform: "shopify", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.shopify }),
    ebay: await createMerchantAccount(ctx, system, { name: "eBay", platform: "ebay", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.ebay }),
  };
  await upsertWeclappConnection(ctx, system, { baseUrl: h.weclapp.baseUrl, apiToken: DEMO.weclappToken });
  const connectionId = await createGraphConnection(ctx, system, {
    displayName: "Service", tenantId: "00000000-0000-0000-0000-000000000000", clientId: "client", clientSecret: DEMO.graphSecret, mailbox: h.graph.mailbox,
    defaultMerchantAccountId: accounts.shopify, defaultSourcePlatform: "shopify", graphBaseUrl: h.graph.graphBaseUrl, authorityHost: h.graph.authorityHost, initialSyncDays: 30,
  });
  for (const [domain, platform] of [[DEMO.amazonRelayDomain, "amazon"], [DEMO.docmorrisDomain, "docmorris"], [DEMO.ebayDomain, "ebay"]] as const) {
    await addRoutingRule(ctx, system, connectionId, { matchType: "from_domain", pattern: domain, sourcePlatform: platform, merchantAccountId: accounts[platform], priority: 10 });
  }
  return {
    workspaceId: ws,
    connectionId,
    owner: { type: "user", userId: users.owner!, workspaceId: ws, role: "owner" },
    agent: { type: "user", userId: users.agent!, workspaceId: ws, role: "agent" },
    viewer: { type: "user", userId: users.viewer!, workspaceId: ws, role: "viewer" },
    ownerUserId: users.owner!,
    agentEmail: `agent@${slug}.example.invalid`,
    accounts,
  };
}

export function loadDemoMails(graph: FakeGraph): Map<string, { id: string; conversationId: string }> {
  const out = new Map<string, { id: string; conversationId: string }>();
  for (const mail of demoInboundMails()) {
    const m = graph.addInbound({ from: mail.from, fromName: mail.fromName, replyTo: mail.replyTo, subject: mail.subject, body: mail.body, conversationId: `conv-${mail.key}`, receivedAt: new Date(Date.now() - mail.hoursAgo * 3_600_000) });
    out.set(mail.key, { id: m.id, conversationId: m.conversationId });
  }
  return out;
}

/**
 * Process all jobs, then act like a person who asks for a reply on every open request
 * (replies are never written on their own), and process those too.
 */
export async function drainWithDrafts(h: Harness, maxJobs = 500): Promise<void> {
  await drainJobs(h.ctx, { maxJobs });
  const open = await h.ctx.db.query<{ id: string; workspace_id: string }>(
    `SELECT c.id, c.workspace_id FROM conversations c
      WHERE c.category = 'support' AND c.latest_inbound_message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.conversation_id = c.id AND d.inbound_message_id = c.latest_inbound_message_id)`,
  );
  for (const c of open.rows) {
    await enqueue(h.ctx.db, { workspaceId: c.workspace_id, type: "case.draft", payload: { conversationId: c.id }, dedupeKey: `case.draft:${c.id}:test` });
  }
  await drainJobs(h.ctx, { maxJobs });
}

/** Run a mailbox sync through the job queue and process everything that follows (enrich, then the requested drafts). */
export async function syncAndDrain(h: Harness, s: SeededWorkspace): Promise<void> {
  await enqueue(h.ctx.db, { workspaceId: s.workspaceId, type: "mail.sync", payload: { connectionId: s.connectionId }, dedupeKey: `mail.sync:${s.connectionId}` });
  await drainWithDrafts(h);
}

export async function caseByThread(h: Harness, s: SeededWorkspace, threadKey: string) {
  return (await one<{ id: string; version: number; order_match_status: string; latest_inbound_message_id: string; status: string; merchant_account_id: string | null }>(
    h.ctx.db,
    "SELECT * FROM conversations WHERE workspace_id = $1 AND (external_thread_key = $2 OR id = (SELECT conversation_id FROM conversation_threads WHERE workspace_id = $1 AND external_thread_key = $2))",
    [s.workspaceId, threadKey],
  ))!;
}

export async function currentDraft(h: Harness, s: SeededWorkspace, conversationId: string) {
  return one<{ id: string; version: number; body: string; status: string; issues: Array<{ severity: string; code: string }>; facts: Array<{ id: string }>; risks: string[]; cited_fact_ids: string[] }>(
    h.ctx.db,
    "SELECT * FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited') ORDER BY created_at DESC LIMIT 1",
    [s.workspaceId, conversationId],
  );
}
