import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WeclappOrderProvider, mapOrder } from "../../packages/connectors/weclapp/adapter.ts";
import { checkShipmentWeight, formatKg, weightChecks, weightHints, type WeightOrder } from "../../packages/core/weight-check.ts";
import { DEMO, demoWeclappData } from "../../packages/testing/demo-data.ts";
import { startFakeWeclapp } from "../../packages/testing/fake-weclapp.ts";

/** Two positions of the same 100 ml bottle, one shipment: the "one bottle missing" case with neutral data. */
function order(packageKg?: number, unit: number | null = 0.25): WeightOrder {
  const unitKg = unit ?? undefined;
  return {
    weightsRead: true,
    lines: [
      { id: "l1", title: "Demo-Öl 100 ml", quantity: 1, grossWeightKg: unitKg },
      { id: "l2", title: "Demo-Öl 100 ml", quantity: 1, grossWeightKg: unitKg },
    ],
    shipments: [{ id: "s1", shipmentNumber: "LS-1", weightKg: packageKg, items: [{ orderLineId: "l1", quantity: 1 }, { orderLineId: "l2", quantity: 1 }], parcels: [{}] }],
  };
}

describe("weight check", () => {
  it("flags a parcel lighter than its contents alone", () => {
    const [c] = weightChecks(order(0.3));
    assert.equal(c!.state, "too_light");
    assert.equal(c!.tone, "bad");
    assert.equal(c!.expectedKg, 0.5);
    assert.equal(c!.actualKg, 0.3);
    assert.equal(c!.percent, 60);
    assert.match(c!.advice, /spricht dafür, dass etwas fehlt/);
    assert.equal(weightHints(order(0.3)).length, 1);
  });

  it("accepts packaging on top, but never calls a fitting weight proof", () => {
    const c = checkShipmentWeight(order(0.62), order(0.62).shipments[0]!);
    assert.equal(c.state, "fits");
    assert.match(c.advice, /kein|nicht/);
    assert.deepEqual(weightHints(order(0.62)), []);
    // Small measuring tolerance below the article sum still fits.
    assert.equal(weightChecks(order(0.48))[0]!.state, "fits");
  });

  it("recognises a package weight copied from the articles", () => {
    assert.equal(weightChecks(order(0.5))[0]!.state, "same_as_articles");
  });

  it("flags a much heavier parcel", () => {
    assert.equal(weightChecks(order(2.5))[0]!.state, "too_heavy");
  });

  it("says clearly when data is missing instead of guessing", () => {
    assert.equal(weightChecks(order(undefined))[0]!.state, "no_package_weight");
    const noArticle = weightChecks(order(0.3, null))[0]!;
    assert.equal(noArticle.state, "no_article_weight");
    assert.match(noArticle.advice, /Demo-Öl 100 ml/);
    assert.equal(weightChecks({ ...order(0.3), weightsRead: undefined })[0]!.state, "not_read");
    assert.deepEqual(weightChecks({ ...order(0.3), shipments: [] }), []);
  });

  it("sums parcels and refuses a partial parcel weight", () => {
    const o = order(undefined);
    const parcels = { ...o.shipments[0]!, parcels: [{ weightKg: 0.2 }, { weightKg: 0.1 }] };
    assert.equal(checkShipmentWeight(o, parcels).state, "too_light");
    assert.equal(checkShipmentWeight(o, { ...parcels, parcels: [{ weightKg: 0.2 }, {}] }).state, "no_package_weight");
  });

  it("uses only the items of the shipment, so a partial delivery is compared with its own contents", () => {
    const o = order(0.31);
    const partial = { ...o.shipments[0]!, items: [{ orderLineId: "l1", quantity: 1 }] };
    assert.equal(checkShipmentWeight(o, partial).state, "fits");
  });

  it("formats kilograms the German way", () => {
    assert.equal(formatKg(0.5), "0,50 kg");
    assert.equal(formatKg(1.234), "1,234 kg");
  });
});

describe("weclapp weights", () => {
  it("maps article, shipment and parcel weights from decimal strings in kg", () => {
    const rec = mapOrder(
      { id: "o1", orderItems: [{ id: "i1", articleId: "a1", title: "X", quantity: "2" }] },
      [{ id: "s1", mainSalesOrderId: "o1", packageWeight: "0.42", shipmentItems: [{ salesOrderItemId: "i1", quantity: "2" }], parcels: [{ id: "p1", trackingId: "T1", weight: "0.4" }] }],
      [],
      "2026-11-11T10:00:00.000Z",
      [{ id: "a1", name: "X", articleGrossWeight: "0.35", articleNetWeight: "0.3" }],
    );
    assert.equal(rec.weightsRead, true);
    assert.equal(rec.lines[0]!.grossWeightKg, 0.35);
    assert.equal(rec.lines[0]!.netWeightKg, 0.3);
    assert.equal(rec.shipments[0]!.weightKg, 0.42);
    assert.equal(rec.shipments[0]!.parcels[0]!.weightKg, 0.4);
    // Empty or zero weights are "unknown", not 0 kg.
    const empty = mapOrder({ id: "o2", orderItems: [{ id: "i2", articleId: "a2", quantity: "1" }] }, [{ id: "s2", packageWeight: "0", parcels: [] }], [], "2026-11-11T10:00:00.000Z", [{ id: "a2", articleGrossWeight: "" }]);
    assert.equal(empty.lines[0]!.grossWeightKg, undefined);
    assert.equal(empty.shipments[0]!.weightKg, undefined);
    assert.equal(mapOrder({ id: "o3" }, [], [], "x", [], undefined, false).weightsRead, undefined);
  });

  it("reads weights through the read-only adapter and finds the light parcel in the demo data", async () => {
    const fake = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken });
    try {
      const provider = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: DEMO.weclappToken, searchFields: ["orderNumber"], allowTestEndpoints: true });
      const mugs = await provider.findOrders([{ value: "AU-10003", kind: "order" }], { field: "none", value: "" });
      assert.equal(mugs.status, "unique");
      if (mugs.status !== "unique") return;
      assert.deepEqual(weightChecks(mugs.order).map((c) => c.state), ["too_light"]);
      const teapot = await provider.findOrders([{ value: "AU-10001", kind: "order" }], { field: "none", value: "" });
      if (teapot.status !== "unique") throw new Error("not unique");
      // LS-5001: 0.9 kg teapot in two parcels of 0.6 + 0.55 kg; LS-5002 has no package weight.
      assert.deepEqual(weightChecks(teapot.order).map((c) => c.state), ["fits", "no_article_weight"]);
      assert.ok(fake.requests.every((r) => r.startsWith("GET ")));
    } finally {
      await fake.close();
    }
  });
});
