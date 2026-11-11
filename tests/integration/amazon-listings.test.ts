import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { checkAmazonListingConnection, closeAmazonOffer, deleteAmazonListingConnection, getAmazonListingSettings, lookupAmazonListing, saveAmazonListingConnection } from "../../packages/services/amazon-listings.ts";
import { getCase } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { many, one } from "../../packages/storage/db.ts";
import { startFakeAmazon, type FakeAmazon } from "../../packages/testing/fake-amazon.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness, type SeededWorkspace } from "./harness.ts";

// Synthetic identifiers only.
const APP = { sellerId: "A1TESTSELLER01", clientId: "amzn1.application-oa2-client.test0000000000000000", clientSecret: "amzn1.oa2-cs.v1.test-secret-value", refreshToken: "Atzr|test-refresh-token-value" };
const DE = "A1PA6795UKMFR9";
const FR = "A13V1IB3VIYZZH";

let h: Harness | null = null;
let amz: FakeAmazon | null = null;
afterEach(async () => {
  await h?.close();
  await amz?.close();
  h = null;
  amz = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);

async function setup(): Promise<{ h: Harness; amz: FakeAmazon; s: SeededWorkspace; caseId: string }> {
  h = await createHarness();
  amz = await startFakeAmazon({
    ...APP,
    listings: [
      { sku: "TEST-SKU-1", marketplaceId: DE, asin: "B0TEST0001", itemName: "Testprodukt 500 ml, 2 Flaschen", productType: "HEALTH_PERSONAL_CARE", offers: [{ offerType: "B2C", currency: "EUR", amount: "19.90" }], quantity: 12 },
      { sku: "TEST SKU/2", marketplaceId: DE, asin: "B0TEST0002", itemName: "Testprodukt B", productType: "HEALTH_PERSONAL_CARE", offers: [{ offerType: "B2C", currency: "EUR", amount: "9.90" }, { offerType: "B2B", currency: "EUR", amount: "8.50" }] },
    ],
  });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  return { h, amz, s, caseId: conv.id };
}

const connect = (h: Harness, amz: FakeAmazon, s: SeededWorkspace, extra: Record<string, unknown> = {}) =>
  saveAmazonListingConnection(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], ...APP, apiBaseUrl: amz.url, tokenUrl: amz.tokenUrl, ...extra });

describe("Amazon-Angebot aus dem Fall deaktivieren", () => {
  it("stores the access encrypted, shows identifiers only masked and changes single fields on click", async () => {
    const { h, amz, s } = await setup();
    await code(connect(h, amz, { ...s, owner: s.agent }), "FORBIDDEN");
    await code(saveAmazonListingConnection(h.ctx, s.owner, { region: "eu", marketplaceIds: ["ATVPDKIKX0DER"], ...APP }), "INVALID");
    await code(saveAmazonListingConnection(h.ctx, s.owner, { region: "eu", marketplaceIds: [DE], ...APP, refreshToken: "not-a-token" }), "INVALID");
    await connect(h, amz, s);

    const view = await getAmazonListingSettings(h.ctx, s.viewer);
    const text = JSON.stringify(view);
    assert.equal(view.configured, true);
    for (const secret of [APP.clientSecret, APP.refreshToken, APP.clientId, APP.sellerId]) assert.ok(!text.includes(secret), "no stored credential in the settings view");
    assert.ok(view.configured && view.clientIdHint.startsWith("amzn1.") && view.clientIdHint.includes("…"));
    const stored = await one<{ ciphertext: Buffer }>(h.ctx.db, "SELECT s.ciphertext FROM secrets s JOIN amazon_listing_connections a ON a.secret_id = s.id");
    assert.ok(!stored!.ciphertext.toString("utf8").includes("Atzr|"), "refresh token encrypted at rest");

    // "Ändern": only the marketplaces, credentials stay; the secret is not rewritten.
    const before = await one<{ secret_id: string }>(h.ctx.db, "SELECT secret_id FROM amazon_listing_connections");
    await saveAmazonListingConnection(h.ctx, s.owner, { marketplaceIds: [DE, FR] });
    const afterChange = await one<{ secret_id: string; marketplace_ids: string[] }>(h.ctx.db, "SELECT secret_id, marketplace_ids FROM amazon_listing_connections");
    assert.equal(afterChange!.secret_id, before!.secret_id);
    assert.deepEqual(afterChange!.marketplace_ids, [DE, FR]);
    // A new refresh token replaces the secret and removes the old one.
    await saveAmazonListingConnection(h.ctx, s.owner, { refreshToken: "Atzr|other-token" });
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM secrets WHERE purpose = 'amazon_sp_api'")).length, 1);

    const check = await checkAmazonListingConnection(h.ctx, s.owner);
    assert.equal(check.ok, false, "the fake only knows the original refresh token");
    assert.match(check.detail, /Refresh-Token/);
    await saveAmazonListingConnection(h.ctx, s.owner, { refreshToken: APP.refreshToken });
    assert.deepEqual((await checkAmazonListingConnection(h.ctx, s.owner)).ok, true);

    await deleteAmazonListingConnection(h.ctx, s.owner);
    assert.equal((await getAmazonListingSettings(h.ctx, s.owner)).configured, false);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM secrets WHERE purpose = 'amazon_sp_api'")).length, 0);
  });

  it("reads the listing first, closes it only on confirmation and records who did it in the case", async () => {
    const { h, amz, s, caseId } = await setup();
    await code(lookupAmazonListing(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE }), "NOT_CONNECTED");
    await connect(h, amz, s);
    assert.deepEqual((await getCase(h.ctx, s.agent, caseId)).amazonListings, { marketplaceIds: [DE] });

    const listing = await lookupAmazonListing(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE });
    assert.equal(listing.asin, "B0TEST0001");
    assert.equal(listing.itemName, "Testprodukt 500 ml, 2 Flaschen");
    assert.equal(listing.canClose, true);
    assert.equal(amz.requests.filter((r) => r.method === "PATCH").length, 0, "looking changes nothing");

    await code(lookupAmazonListing(h.ctx, s.agent, caseId, { sku: "UNKNOWN", marketplaceId: DE }), "LISTING_NOT_FOUND");
    await code(lookupAmazonListing(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: FR }), "INVALID");
    await code(lookupAmazonListing(h.ctx, s.viewer, caseId, { sku: "TEST-SKU-1", marketplaceId: DE }), "FORBIDDEN");
    await code(closeAmazonOffer(h.ctx, s.viewer, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true }), "FORBIDDEN");
    await code(closeAmazonOffer(h.ctx, { type: "worker", workspaceId: s.workspaceId }, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true }), "FORBIDDEN");
    await code(closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: false }), "CONFIRM_REQUIRED");
    await code(closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true, expectedAsin: "B0OTHER" }), "LISTING_CHANGED");
    assert.equal(amz.requests.filter((r) => r.method === "PATCH").length, 0);

    const result = await closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true, expectedAsin: "B0TEST0001" });
    assert.equal(result.state, "accepted");
    const patch = amz.requests.find((r) => r.method === "PATCH")!;
    const body = patch.body as { productType: string; patches: Array<{ op: string; path: string; value: Array<Record<string, unknown>> }> };
    assert.equal(body.productType, "HEALTH_PERSONAL_CARE");
    assert.equal(body.patches[0]!.op, "merge");
    assert.equal(body.patches[0]!.path, "/attributes/purchasable_offer");
    assert.deepEqual(Object.keys(body.patches[0]!.value[0]!).sort(), ["audience", "currency", "end_at", "marketplace_id"], "only the end date, price and stock untouched");
    assert.ok(String((body.patches[0]!.value[0]!.end_at as { value: string }).value) < new Date().toISOString().slice(0, 10), "end date in the past");

    const after = await lookupAmazonListing(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE });
    assert.equal(after.canClose, false);

    const data = await getCase(h.ctx, s.agent, caseId);
    const actions = data.listingActions as Array<{ state: string; sku: string; asin: string; requested_by: string; submission_id: string }>;
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.state, "accepted");
    assert.equal(actions[0]!.asin, "B0TEST0001");
    assert.ok(actions[0]!.submission_id);
    assert.match(actions[0]!.requested_by, /agent/);
    assert.ok((data.history as Array<{ action: string }>).some((x) => x.action === "amazon.offer_close_accepted"));
  });

  it("closes consumer and business offer together and encodes the SKU", async () => {
    const { h, amz, s, caseId } = await setup();
    await connect(h, amz, s);
    const r = await closeAmazonOffer(h.ctx, s.owner, caseId, { sku: "TEST SKU/2", marketplaceId: DE, confirm: true });
    assert.equal(r.state, "accepted");
    const patch = amz.requests.find((x) => x.method === "PATCH")!;
    assert.ok(patch.path.includes("/TEST%20SKU%2F2?"));
    const value = (patch.body as { patches: Array<{ value: Array<{ audience: string }> }> }).patches[0]!.value;
    assert.deepEqual(value.map((v) => v.audience).sort(), ["ALL", "B2B"]);
  });

  it("keeps a rejection with Amazon's reasons and an interrupted request as uncertain, never as done", async () => {
    const { h, amz, s, caseId } = await setup();
    await connect(h, amz, s);
    amz.fault.patch = "invalid";
    const rejected = await closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true });
    assert.equal(rejected.state, "rejected");
    assert.match(rejected.issues[0]!.message, /purchasable_offer/);

    amz.fault.patch = "reset";
    const uncertain = await closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true });
    assert.equal(uncertain.state, "uncertain");

    amz.fault.patch = "forbidden";
    await assert.rejects(closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST SKU/2", marketplaceId: DE, confirm: true }), /Product Listing/);

    const states = (await many<{ state: string }>(h.ctx.db, "SELECT state FROM listing_actions ORDER BY created_at")).map((r) => r.state);
    assert.deepEqual(states, ["rejected", "uncertain", "rejected"]);
  });

  it("refuses a second request while one is pending and keeps workspaces apart", async () => {
    const { h, amz, s, caseId } = await setup();
    await connect(h, amz, s);
    await h.ctx.db.query(
      "INSERT INTO listing_actions (workspace_id, conversation_id, action, marketplace_id, sku, state, requested_by) VALUES ($1, $2, 'close_offer', $3, 'TEST-SKU-1', 'pending', $4)",
      [s.workspaceId, caseId, DE, s.ownerUserId],
    );
    await code(closeAmazonOffer(h.ctx, s.agent, caseId, { sku: "TEST-SKU-1", marketplaceId: DE, confirm: true }), "IN_PROGRESS");
    assert.equal(amz.requests.filter((r) => r.method === "PATCH").length, 0);

    // Another workspace sees neither the access nor this case.
    const other = await seedWorkspace(h, "Anderer Händler");
    assert.equal((await getAmazonListingSettings(h.ctx, other.owner)).configured, false);
    await code(lookupAmazonListing(h.ctx, other.owner, caseId, { sku: "TEST-SKU-1", marketplaceId: DE }), "NOT_FOUND");
    await connect(h, amz, other);
    await code(closeAmazonOffer(h.ctx, other.owner, caseId, { sku: "TEST SKU/2", marketplaceId: DE, confirm: true }), "NOT_FOUND");
  });
});
