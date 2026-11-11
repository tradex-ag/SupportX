import { loadConfig } from "../packages/storage/config.ts";
import { one, withTx } from "../packages/storage/db.ts";
import { loadDotEnv } from "../packages/storage/env.ts";
import { migrate } from "../packages/storage/migrate.ts";
import { createUser } from "../packages/services/auth.ts";
import { createContext } from "../packages/services/bootstrap.ts";
import { addRoutingRule, createGraphConnection, createMerchantAccount, upsertWeclappConnection } from "../packages/services/connections.ts";
import type { Actor } from "../packages/services/context.ts";
import { purgeWorkspace } from "../packages/services/purge.ts";
import { DEMO } from "../packages/testing/demo-data.ts";
import { DEMO_AMAZON, DEMO_PORTS } from "./demo-fakes.ts";
import { saveAmazonListingConnection } from "../packages/services/amazon-listings.ts";

/**
 * DEMO ONLY. Creates a clearly labelled workspace with synthetic accounts and
 * connections that point at the local test doubles (scripts/demo-fakes.ts).
 * Reply routes stay unverified and sending stays off, as in a fresh real setup.
 */
export const DEMO_WORKSPACE = "Demo-Händler GmbH (synthetische Daten)";
export const DEMO_USERS = [
  { email: "inhaber@demo-haendler.example.invalid", name: "Demo-Inhaberin", role: "owner" as const },
  { email: "service@demo-haendler.example.invalid", name: "Demo-Servicekraft", role: "agent" as const },
];
export const DEMO_PASSWORD = "demo-passwort-nur-lokal";

export async function seedDemo(opts: { reset?: boolean; log?: (line: string) => void } = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const config = loadConfig();
  if (!config.ALLOW_TEST_ENDPOINTS) throw new Error("Die Demo braucht ALLOW_TEST_ENDPOINTS=true (Testdoubles auf localhost).");
  const ctx = createContext(config);
  try {
    await migrate(ctx.db);
    const existing = await one<{ id: string }>(ctx.db, "SELECT id FROM workspaces WHERE name = $1", [DEMO_WORKSPACE]);
    if (existing && !opts.reset) {
      log(`[demo] Demo-Arbeitsbereich existiert bereits (${existing.id}). Neu anlegen mit --reset.`);
      return;
    }
    const workspaceId = await withTx(ctx.db, async (tx) => {
      if (existing) {
        await purgeWorkspace(tx, existing.id);
      }
      const ws = await one<{ id: string }>(tx, "INSERT INTO workspaces (name, reply_signature, allowed_link_prefixes) VALUES ($1, $2, $3) RETURNING id", [
        DEMO_WORKSPACE,
        "Freundliche Grüße\nIhr Demo-Kundenservice",
        ["https://tracking.demo.invalid/"],
      ]);
      for (const user of DEMO_USERS) {
        const found = await one<{ id: string }>(tx, "SELECT id FROM users WHERE email = $1", [user.email]);
        const userId = found?.id ?? (await createUser(tx, { email: user.email, displayName: user.name, password: DEMO_PASSWORD }));
        await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [ws!.id, userId, user.role]);
      }
      return ws!.id;
    });
    const owner: Actor = { type: "worker", workspaceId };
    const accounts = {
      amazon: await createMerchantAccount(ctx, owner, { name: "Amazon DE (Demo)", platform: "amazon", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.amazon }),
      docmorris: await createMerchantAccount(ctx, owner, { name: "DocMorris Marktplatz (Demo)", platform: "docmorris", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.docmorris }),
      shopify: await createMerchantAccount(ctx, owner, { name: "Eigener Shop (Demo)", platform: "shopify", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.shopify }),
      ebay: await createMerchantAccount(ctx, owner, { name: "eBay (Demo)", platform: "ebay", orderScopeField: "salesChannel", orderScopeValue: DEMO.channels.ebay }),
    };
    await upsertWeclappConnection(ctx, owner, { baseUrl: `http://127.0.0.1:${DEMO_PORTS.weclapp}/webapp/api/v2`, apiToken: DEMO.weclappToken });
    const connectionId = await createGraphConnection(ctx, owner, {
      displayName: "Gemeinsames Servicepostfach (Demo)",
      tenantId: "00000000-0000-0000-0000-000000000000",
      clientId: "11111111-1111-1111-1111-111111111111",
      clientSecret: DEMO.graphSecret,
      mailbox: DEMO.mailbox,
      defaultMerchantAccountId: accounts.shopify,
      defaultSourcePlatform: "shopify",
      graphBaseUrl: `http://127.0.0.1:${DEMO_PORTS.graph}/graph/v1.0`,
      authorityHost: `http://127.0.0.1:${DEMO_PORTS.graph}/login`,
      initialSyncDays: 30,
    });
    await addRoutingRule(ctx, owner, connectionId, { matchType: "from_domain", pattern: DEMO.amazonRelayDomain, sourcePlatform: "amazon", merchantAccountId: accounts.amazon, priority: 10 });
    await addRoutingRule(ctx, owner, connectionId, { matchType: "from_domain", pattern: DEMO.docmorrisDomain, sourcePlatform: "docmorris", merchantAccountId: accounts.docmorris, priority: 10 });
    await saveAmazonListingConnection(ctx, owner, {
      region: "eu", marketplaceIds: ["A1PA6795UKMFR9"], ...DEMO_AMAZON,
      apiBaseUrl: `http://127.0.0.1:${DEMO_PORTS.amazon}`, tokenUrl: `http://127.0.0.1:${DEMO_PORTS.amazon}/auth/o2/token`,
    });
    await addRoutingRule(ctx, owner, connectionId, { matchType: "from_domain", pattern: DEMO.ebayDomain, sourcePlatform: "ebay", merchantAccountId: accounts.ebay, priority: 10 });
    log(`[demo] Demo-Arbeitsbereich angelegt: ${DEMO_WORKSPACE}`);
    for (const user of DEMO_USERS) log(`[demo] Anmeldung ${user.role}: ${user.email} / ${DEMO_PASSWORD}`);
  } finally {
    await ctx.db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv();
  await seedDemo({ reset: process.argv.includes("--reset") });
}
