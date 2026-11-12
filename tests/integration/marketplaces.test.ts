import assert from "node:assert/strict";
import { getMessageAttachment, listMessageAttachments } from "../../packages/services/attachments.ts";
import { after, afterEach, describe, it } from "node:test";
import { completeEbayConsent, createEbayConnection, createKauflandConnection, createMiraklConnection, setMiraklBackgroundSync, setSendEnabled, startEbayConsent, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { enqueue } from "../../packages/services/jobs.ts";
import { getSettings } from "../../packages/services/cases.ts";
import { approveDraft, dispatchOutbox, queueReply, reconcileOutbox } from "../../packages/services/replies.ts";
import { drainJobs, scheduleTick } from "../../packages/services/worker.ts";
import { many, one } from "../../packages/storage/db.ts";
import { buildServer } from "../../apps/server/app.ts";
import { signEbayNotice, startFakeEbay, startFakeKaufland, startFakeMirakl } from "../../packages/testing/fake-marketplaces.ts";
import { closeDb, createHarness, currentDraft, drainWithDrafts, seedWorkspace, type Harness, type SeededWorkspace } from "./harness.ts";

let h: Harness | null = null;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const c of closers.splice(0)) await c();
});
after(() => closeDb());

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (e: ServiceError) => e.code === code);
}

async function sync(s: SeededWorkspace, connectionId: string): Promise<void> {
  await enqueue(h!.ctx.db, { workspaceId: s.workspaceId, type: "mail.sync", payload: { connectionId }, dedupeKey: `mail.sync:${connectionId}` });
  await drainWithDrafts(h!, 200);
}

const KFL = { clientKey: "client-key-test", secretKey: "secret-key-test" };

describe("Kaufland tickets end to end", () => {
  it("ingests a ticket, keeps drafts only by default and recognises the sent reply as echo", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    const fake = await startFakeKaufland(KFL);
    closers.push(() => fake.close());
    fake.addTicket({ id_ticket: "T1", id_order: "M3KX7Q2", buyer: { firstname: "Erika", lastname: "Muster" } });
    fake.addMessage("T1", "buyer", "Wo bleibt meine Bestellung?", new Date(Date.now() - 600_000));
    const id = await createKauflandConnection(h.ctx, s.owner, { displayName: "Kaufland DE", ...KFL, baseUrl: fake.baseUrl });

    await sync(s, id);
    const conv = (await one<{ id: string; source_platform: string; order_references: Array<{ value: string }>; customer_name: string }>(h.ctx.db, "SELECT * FROM conversations WHERE connection_id = $1", [id]))!;
    assert.equal(conv.source_platform, "kaufland");
    assert.equal(conv.customer_name, "Erika Muster");
    assert.ok(conv.order_references.some((r) => r.value === "M3KX7Q2"), "order id from the ticket is used for the weclapp lookup");
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.ok(draft, "a draft was prepared");

    // Default: no route verified, sending off for the connection.
    const approvalId = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    await rejectsWith(queueReply(h.ctx, s.agent, approvalId), "SEND_BLOCKED");
    assert.equal(fake.posted.length, 0);

    await verifyReplyRoute(h.ctx, s.owner, id, { sourcePlatform: "kaufland", evidenceNote: "Testantwort im Ticket T1 im Seller Portal sichtbar" });
    await setSendEnabled(h.ctx, s.owner, id, true);
    const outboxId = await queueReply(h.ctx, s.agent, approvalId);
    assert.equal(await dispatchOutbox(h.ctx, s.workspaceId, outboxId), "provider_accepted");
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0]!.ticketId, "T1");

    await sync(s, id);
    const echo = await one<{ kind: string }>(h.ctx.db, "SELECT kind FROM messages WHERE outbox_id = $1", [outboxId]);
    assert.equal(echo?.kind, "echo", "own reply is not a manual external reply");
    assert.equal((await one<{ state: string }>(h.ctx.db, "SELECT state FROM outbox WHERE id = $1", [outboxId]))!.state, "confirmed");
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM conversations WHERE connection_id = $1", [id])).length, 1);
  });

  it("confirms a timed-out send by reconciliation without resending", async () => {
    h = await createHarness({ sendMode: "enabled", graphTimeoutMs: 150 });
    const s = await seedWorkspace(h);
    const fake = await startFakeKaufland({ ...KFL, hangMs: 400 });
    closers.push(() => fake.close());
    fake.addTicket({ id_ticket: "T9", id_order: "M1AAA11", buyer: { firstname: "A", lastname: "B" } });
    fake.addMessage("T9", "buyer", "Frage", new Date(Date.now() - 600_000));
    const id = await createKauflandConnection(h.ctx, s.owner, { displayName: "Kaufland", ...KFL, baseUrl: fake.baseUrl });
    await sync(s, id);
    const conv = (await one<{ id: string }>(h.ctx.db, "SELECT id FROM conversations WHERE connection_id = $1", [id]))!;
    const draft = (await currentDraft(h, s, conv.id))!;
    await verifyReplyRoute(h.ctx, s.owner, id, { sourcePlatform: "kaufland", evidenceNote: "Testantwort im Ticket sichtbar, 22.10." });
    await setSendEnabled(h.ctx, s.owner, id, true);
    const outboxId = await queueReply(h.ctx, s.agent, await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }));
    fake.setSendFault("timeout_after_send");
    assert.equal(await dispatchOutbox(h.ctx, s.workspaceId, outboxId), "delivery_uncertain");
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(await reconcileOutbox(h.ctx, s.workspaceId, outboxId), "confirmed");
    assert.equal(fake.posted.length, 1, "never sent twice");
  });
});

describe("Shop Apotheke (Mirakl)", () => {
  it("is read only on demand until the operator's permission is recorded", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const fake = await startFakeMirakl({ apiKey: "mirakl-key" });
    closers.push(() => fake.close());
    fake.addThread({ id: "th-1", topic: "Lieferung", orderId: "SA-100234-A", customerId: "c-77", customerName: "Max Kunde", text: "Wann kommt meine Bestellung?", files: [{ id: "att-9", name: "foto.jpg", data: Buffer.from("jpegdata") }] });
    const id = await createMiraklConnection(h.ctx, s.owner, { displayName: "Shop Apotheke", baseUrl: fake.baseUrl, apiKey: "mirakl-key" });

    await scheduleTick(h.ctx);
    const queued = await many(h.ctx.db, "SELECT 1 FROM jobs WHERE type = 'mail.sync' AND payload->>'connectionId' = $1", [id]);
    assert.equal(queued.length, 0, "no background poll without permission");

    await sync(s, id); // "Jetzt abrufen"
    const conv = await one<{ source_platform: string }>(h.ctx.db, "SELECT source_platform FROM conversations WHERE connection_id = $1", [id]);
    assert.equal(conv?.source_platform, "shop_apotheke");
    const msg = (await one<{ id: string }>(h.ctx.db, "SELECT id FROM messages WHERE connection_id = $1 AND has_attachments", [id]))!;
    const files = await listMessageAttachments(h.ctx, s.agent, msg.id);
    assert.deepEqual(files.map((f) => [f.id, f.name, f.contentType, f.inline]), [["att-9", "foto.jpg", "image/jpeg", true]]);
    const photo = await getMessageAttachment(h.ctx, s.agent, msg.id, "att-9");
    assert.equal(photo.data.toString(), "jpegdata");
    assert.ok(fake.requests.some((r) => r.startsWith("GET /api/inbox/threads/att-9/download")), "M13 download");

    await rejectsWith(setMiraklBackgroundSync(h.ctx, s.owner, id, { allowed: true, evidenceNote: "" }), "INVALID");
    await setMiraklBackgroundSync(h.ctx, s.owner, id, { allowed: true, evidenceNote: "Freigabe per Mail vom Partner-Management, 22.10." });
    await h.ctx.db.query("UPDATE channel_connections SET last_sync_at = NULL WHERE id = $1", [id]);
    await scheduleTick(h.ctx);
    const after = await many(h.ctx.db, "SELECT 1 FROM jobs WHERE type = 'mail.sync' AND payload->>'connectionId' = $1 AND status = 'queued'", [id]);
    assert.equal(after.length, 1);
  });
});

describe("eBay consent", () => {
  it("connects only for the owner who started it, once, and then reads messages", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const fake = await startFakeEbay({ clientId: "app-id", clientSecret: "cert-id", seller: "demo_shop", authCode: "code-1", refreshToken: "refresh-1" });
    closers.push(() => fake.close());
    fake.addConversation({ id: "C1", title: "Frage zu Bestellung 12-34567-89012", buyer: "kunde_1", text: "Wo ist mein Paket?" });
    const id = await createEbayConnection(h.ctx, s.owner, { displayName: "eBay", clientId: "app-id", clientSecret: "cert-id", ruName: "RuName", authBaseUrl: fake.baseUrl, apiBaseUrl: fake.baseUrl, identityBaseUrl: fake.baseUrl });

    await scheduleTick(h.ctx);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM jobs WHERE payload->>'connectionId' = $1", [id])).length, 0, "not polled before consent");
    await rejectsWith(startEbayConsent(h.ctx, s.agent, id), "FORBIDDEN");

    const url = new URL(await startEbayConsent(h.ctx, s.owner, id));
    const state = url.searchParams.get("state")!;
    await rejectsWith(completeEbayConsent(h.ctx, s.agent.type === "user" ? s.agent.userId : "", { state, code: "code-1" }), "FORBIDDEN");
    const done = await completeEbayConsent(h.ctx, s.ownerUserId, { state, code: "code-1" });
    assert.equal(done.sellerUsername, "demo_shop");
    await rejectsWith(completeEbayConsent(h.ctx, s.ownerUserId, { state, code: "code-1" }), "INVALID_STATE");

    const settings = await one<{ config: Record<string, unknown> }>(h.ctx.db, "SELECT config FROM channel_connections WHERE id = $1", [id]);
    assert.equal(settings!.config.sellerUsername, "demo_shop");
    assert.equal(settings!.config.oauthStateHash, undefined);
    const secrets = await many(h.ctx.db, "SELECT 1 FROM secrets WHERE workspace_id = $1 AND purpose = 'ebay_oauth'", [s.workspaceId]);
    assert.equal(secrets.length, 1, "old secret replaced, not duplicated");

    await sync(s, id);
    const conv = await one<{ source_platform: string; order_references: Array<{ value: string }> }>(h.ctx.db, "SELECT * FROM conversations WHERE connection_id = $1", [id]);
    assert.equal(conv?.source_platform, "ebay");
    assert.ok(conv!.order_references.some((r) => r.value === "12-34567-89012"));
    assert.ok(fake.requests.every((r) => !r.includes("send_message")), "nothing sent");
  });
});

describe("eBay on the installation's keyset", () => {
  it("lets the merchant connect with one click, without storing or showing the keyset", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const fake = await startFakeEbay({ clientId: "operator-app", clientSecret: "operator-cert", seller: "auwald_shop", authCode: "code-9", refreshToken: "refresh-9" });
    closers.push(() => fake.close());
    fake.addConversation({ id: "C1", title: "Frage zu Bestellung 12-34567-89012", buyer: "kunde_1", text: "Wo ist mein Paket?" });
    const cfg = h.ctx.config as { EBAY_CLIENT_ID?: string; EBAY_CLIENT_SECRET?: string; EBAY_RU_NAME?: string };

    await rejectsWith(createEbayConnection(h.ctx, s.owner, { displayName: "eBay" }), "INVALID");
    Object.assign(cfg, { EBAY_CLIENT_ID: "operator-app", EBAY_CLIENT_SECRET: "operator-cert", EBAY_RU_NAME: "Operator-RuName" });
    assert.equal(((await getSettings(h.ctx, s.owner)) as { ebayOperatorApp?: boolean }).ebayOperatorApp, true);

    const id = await createEbayConnection(h.ctx, s.owner, { displayName: "eBay", authBaseUrl: fake.baseUrl, apiBaseUrl: fake.baseUrl, identityBaseUrl: fake.baseUrl });
    const url = new URL(await startEbayConsent(h.ctx, s.owner, id));
    assert.equal(url.searchParams.get("client_id"), "operator-app");
    assert.equal(url.searchParams.get("redirect_uri"), "Operator-RuName");
    const done = await completeEbayConsent(h.ctx, s.ownerUserId, { state: url.searchParams.get("state")!, code: "code-9" });
    assert.equal(done.sellerUsername, "auwald_shop");

    const row = await one<{ config: Record<string, unknown>; secret_id: string }>(h.ctx.db, "SELECT config, secret_id FROM channel_connections WHERE id = $1", [id]);
    assert.equal(row!.config.operatorApp, true);
    assert.equal(row!.config.clientId, undefined, "the keyset stays in the server configuration");
    const stored = JSON.parse(await h.ctx.secrets.read(h.ctx.db, s.workspaceId, row!.secret_id)) as Record<string, unknown>;
    assert.equal(stored.clientSecret, undefined, "the operator's Cert ID is never copied into a workspace");
    assert.equal(stored.refreshToken, "refresh-9");
    const settingsText = JSON.stringify(await getSettings(h.ctx, s.owner));
    for (const v of ["operator-cert", "Operator-RuName", "refresh-9"]) assert.ok(!settingsText.includes(v), `${v} is not in the settings payload`);

    await sync(s, id);
    const conv = await one<{ source_platform: string }>(h.ctx.db, "SELECT * FROM conversations WHERE connection_id = $1", [id]);
    assert.equal(conv?.source_platform, "ebay");

    // Keyset removed from the server: the connection reports it instead of guessing.
    Object.assign(cfg, { EBAY_CLIENT_ID: undefined, EBAY_CLIENT_SECRET: undefined, EBAY_RU_NAME: undefined });
    await rejectsWith(startEbayConsent(h.ctx, s.owner, id), "EBAY_APP_MISSING");
  });
});

describe("eBay account deletion notifications", () => {
  it("answers the challenge, rejects unsigned notices and deletes the user's cases", async () => {
    h = await createHarness();
    const token = "verify_Token-0123456789abcdefghijkl";
    (h.ctx.config as { EBAY_DELETION_VERIFICATION_TOKEN?: string }).EBAY_DELETION_VERIFICATION_TOKEN = token;
    const s = await seedWorkspace(h);
    const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n-1", data: { username: "Kunde_1", userId: "u9" } } });
    const signed = signEbayNotice(body, "kid-7");
    const fake = await startFakeEbay({ clientId: "app-id", clientSecret: "cert-id", seller: "demo_shop", authCode: "code-1", refreshToken: "refresh-1", publicKeys: { "kid-7": signed.key } });
    closers.push(() => fake.close());
    fake.addConversation({ id: "C1", title: "Frage", buyer: "kunde_1", text: "Wo ist mein Paket?" });
    fake.addConversation({ id: "C2", title: "Andere Frage", buyer: "kunde_2", text: "Gibt es das in rot?" });
    const id = await createEbayConnection(h.ctx, s.owner, { displayName: "eBay", clientId: "app-id", clientSecret: "cert-id", ruName: "RuName", authBaseUrl: fake.baseUrl, apiBaseUrl: fake.baseUrl, identityBaseUrl: fake.baseUrl });
    const state = new URL(await startEbayConsent(h.ctx, s.owner, id)).searchParams.get("state")!;
    await completeEbayConsent(h.ctx, s.ownerUserId, { state, code: "code-1" });
    await sync(s, id);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM conversations WHERE connection_id = $1", [id])).length, 2);

    const app = await buildServer(h.ctx);
    try {
      const path = "/webhooks/ebay/account-deletion";
      const challenge = await app.inject({ method: "GET", url: `${path}?challenge_code=abc` });
      assert.equal(challenge.statusCode, 200);
      const { createHash } = await import("node:crypto");
      assert.equal(challenge.json().challengeResponse, createHash("sha256").update(`abc${token}${h.ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, "")}${path}`).digest("hex"));

      const unsigned = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/json" }, payload: body });
      assert.equal(unsigned.statusCode, 412);
      const forged = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "x-ebay-signature": signed.header }, payload: body.replace("Kunde_1", "Kunde_2") });
      assert.equal(forged.statusCode, 412);
      assert.equal((await many(h.ctx.db, "SELECT 1 FROM conversations WHERE connection_id = $1", [id])).length, 2, "nothing deleted without a valid signature");

      const ok = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "x-ebay-signature": signed.header }, payload: body });
      assert.equal(ok.statusCode, 204);
      const left = await many<{ customer_address: string }>(h.ctx.db, "SELECT customer_address FROM conversations WHERE connection_id = $1", [id]);
      assert.deepEqual(left.map((r) => r.customer_address), ["ebay:kunde_2"]);
      const auditRow = await one<{ details: Record<string, unknown> }>(h.ctx.db, "SELECT details FROM audit_events WHERE action = 'ebay.account_deleted'");
      assert.equal(auditRow!.details.deletedCases, 1);
      assert.ok(!JSON.stringify(auditRow!.details).toLowerCase().includes("kunde_1"), "the eBay name is not kept in the audit log");
    } finally {
      await app.close();
    }
  });

  it("is switched off without a verification token", async () => {
    h = await createHarness();
    const app = await buildServer(h.ctx);
    try {
      assert.equal((await app.inject({ method: "GET", url: "/webhooks/ebay/account-deletion?challenge_code=abc" })).statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
