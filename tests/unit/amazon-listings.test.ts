import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmazonListingsClient, closeOfferPatch, closingDate, isOfficialAmazonHost, parseListing } from "../../packages/connectors/amazon/listings.ts";
import { AMAZON_MARKETPLACES, maskIdentifier } from "../../packages/core/amazon-marketplaces.ts";

// Synthetic payload in the documented getListingsItem shape (v2021-08-01).
const SAMPLE = {
  sku: "TEST-SKU-1",
  summaries: [
    { marketplaceId: "A13V1IB3VIYZZH", asin: "B0FR", productType: "X", status: [], itemName: "fr" },
    { marketplaceId: "A1PA6795UKMFR9", asin: "B0TEST0001", productType: "HEALTH_PERSONAL_CARE", conditionType: "new_new", status: ["BUYABLE", "DISCOVERABLE"], itemName: "Testprodukt" },
  ],
  offers: [
    { marketplaceId: "A1PA6795UKMFR9", offerType: "B2C", price: { currencyCode: "EUR", amount: "19.90" } },
    { marketplaceId: "A1PA6795UKMFR9", offerType: "B2B", price: { currencyCode: "EUR", amount: "17.00" }, audience: { value: "B2B", displayName: "Business" } },
    { marketplaceId: "A13V1IB3VIYZZH", offerType: "B2C", price: { currencyCode: "EUR", amount: "21.00" } },
  ],
  fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 3 }],
  issues: [{ code: "18027", message: "Bild fehlt", severity: "WARNING" }],
};

describe("Amazon Listings Items API", () => {
  it("parses the listing of one marketplace", () => {
    const l = parseListing(SAMPLE, "A1PA6795UKMFR9");
    assert.equal(l.asin, "B0TEST0001");
    assert.equal(l.productType, "HEALTH_PERSONAL_CARE");
    assert.deepEqual(l.status, ["BUYABLE", "DISCOVERABLE"]);
    assert.deepEqual(l.offers.map((o) => [o.offerType, o.audience, o.currency]), [["B2C", "ALL", "EUR"], ["B2B", "B2B", "EUR"]]);
    assert.deepEqual(l.fulfillment, [{ channel: "DEFAULT", quantity: 3 }]);
    assert.equal(l.issues[0]!.severity, "WARNING");
  });

  it("closes with a past end date and nothing else", () => {
    const now = new Date("2026-11-11T00:30:00Z");
    assert.equal(closingDate(now), "2026-11-10");
    const patch = closeOfferPatch(parseListing(SAMPLE, "A1PA6795UKMFR9"), now);
    assert.deepEqual(patch, {
      productType: "HEALTH_PERSONAL_CARE",
      patches: [{ op: "merge", path: "/attributes/purchasable_offer", value: [
        { marketplace_id: "A1PA6795UKMFR9", currency: "EUR", audience: "ALL", end_at: { value: "2026-11-10" } },
        { marketplace_id: "A1PA6795UKMFR9", currency: "EUR", audience: "B2B", end_at: { value: "2026-11-10" } },
      ] }],
    });
    assert.throws(() => closeOfferPatch({ ...parseListing(SAMPLE, "A1PA6795UKMFR9"), productType: undefined }, now));
  });

  it("accepts only official Amazon hosts for live credentials", () => {
    assert.ok(isOfficialAmazonHost(new URL("https://sellingpartnerapi-eu.amazon.com")));
    assert.ok(isOfficialAmazonHost(new URL("https://api.amazon.com/auth/o2/token")));
    assert.ok(!isOfficialAmazonHost(new URL("https://sellingpartnerapi-eu.amazon.com.evil.example")));
    const base = { region: "eu" as const, sellerId: "A1", clientId: "c", clientSecret: "s", refreshToken: "Atzr|x" };
    assert.throws(() => new AmazonListingsClient({ ...base, apiBaseUrl: "https://example.invalid", allowTestEndpoints: false }), /Nicht erlaubter Endpunkt/);
    assert.throws(() => new AmazonListingsClient({ ...base, apiBaseUrl: "http://127.0.0.1:1", allowTestEndpoints: false }), /Nicht erlaubter Endpunkt/);
    assert.doesNotThrow(() => new AmazonListingsClient({ ...base, allowTestEndpoints: false }));
  });

  it("masks identifiers and knows each marketplace's region", () => {
    assert.equal(maskIdentifier("amzn1.application-oa2-client.abcdef1234"), "amzn1.…1234");
    assert.equal(maskIdentifier("short"), "•••••");
    assert.equal(new Set(AMAZON_MARKETPLACES.map((m) => m.id)).size, AMAZON_MARKETPLACES.length);
    assert.equal(AMAZON_MARKETPLACES.find((m) => m.country === "DE")!.region, "eu");
  });
});
