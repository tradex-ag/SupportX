import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WeclappOrderProvider } from "../../packages/connectors/weclapp/adapter.ts";
import type { OrderRecord } from "../../packages/core/contracts.ts";
import { buildOrderFacts } from "../../packages/core/facts.ts";
import { returnSummary } from "../../packages/core/returns.ts";
import { DEMO, demoWeclappData } from "../../packages/testing/demo-data.ts";
import { startFakeWeclapp } from "../../packages/testing/fake-weclapp.ts";

const ref = (value: string) => ({ value, kind: "order" as const });
const ALL = { field: "none" as const, value: "" };

async function lookup(number: string, opts: { forbidden?: string[]; rejectFilters?: string[] } = {}): Promise<OrderRecord> {
  const fake = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken, ...opts });
  try {
    const provider = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: DEMO.weclappToken, searchFields: ["orderNumberAtCustomer"], allowTestEndpoints: true });
    const result = await provider.findOrders([ref(number)], ALL);
    assert.equal(result.status, "unique");
    if (result.status !== "unique") throw new Error("not unique");
    assert.ok(fake.requests.every((r) => r.startsWith("GET ")), "adapter only reads");
    return result.order;
  } finally {
    await fake.close();
  }
}

describe("weclapp customer returns", () => {
  it("reads a booked-in return with its reason and shows it as goods back", async () => {
    const order = await lookup("DM-2026-000123");
    assert.equal(order.returns?.length, 1);
    const ret = order.returns![0]!;
    assert.equal(ret.returnNumber, "WE-7001");
    assert.equal(ret.erpStatus, "INCOMING_MOVED_INTO_STORE");
    assert.deepEqual(ret.items, [{ orderLineId: "soi-3", title: "Demo-Pflegecreme 50 ml", quantity: 1, reason: "Ware beschädigt" }]);
    const rs = returnSummary(order);
    assert.equal(rs.state, "received");
    assert.equal(rs.tone, "good");
    assert.equal(rs.label, "Ware zurück (23.10.2026)");
    assert.ok(buildOrderFacts(order).some((f) => f.id === "return.1" && f.text.includes("Ware eingegangen und eingelagert")));
  });

  it("finds a return linked only through the outgoing shipment and says the goods are not back yet", async () => {
    const order = await lookup("1002");
    assert.equal(order.returns?.length, 1);
    assert.equal(order.returns![0]!.items[0]!.reason, "Farbe gefällt nicht");
    const rs = returnSummary(order);
    assert.equal(rs.state, "announced");
    assert.match(rs.advice, /Wareneingang abwarten/);
  });

  it("ignores goods receipts that are not customer returns", async () => {
    const order = await lookup("302-1234567-7654321");
    assert.deepEqual(order.returns, []);
    assert.equal(returnSummary(order).state, "none");
    assert.ok(buildOrderFacts(order).some((f) => f.id === "returns.none"));
  });

  it("keeps the order when the user may not read goods receipts, and says returns are not checkable", async () => {
    const order = await lookup("DM-2026-000123", { forbidden: ["incomingGoods"] });
    assert.equal(order.shipments.length, 1);
    assert.deepEqual(order.returns, []);
    assert.match(order.returnsError ?? "", /Wareneingänge/);
    const rs = returnSummary({ ...order, lines: order.lines.map((l) => ({ ...l, returnedQuantity: 0 })) });
    assert.equal(rs.state, "unknown");
    assert.equal(rs.label, "Retoure nicht prüfbar");
    assert.ok(!buildOrderFacts(order).some((f) => f.id === "returns.none"), "no 'no return' claim when reading failed");
  });

  it("reports refused filters instead of claiming there is no return", async () => {
    const order = await lookup("1002", { rejectFilters: ["incomingGoods.salesOrders.id-eq", "incomingGoods.relatedShipmentId-eq"] });
    assert.match(order.returnsError ?? "", /lehnt die Abfrage der Retouren ab/);
    assert.equal(returnSummary(order).state, "unknown");
  });
});

describe("returnSummary", () => {
  const base = { lines: [{ returnedQuantity: 0 }], shipments: [{}], invoices: [] as Array<{ id: string; invoiceNumber?: string; type?: string }> };
  const ret = (status: string) => ({ id: "r", returnNumber: "WE-1", erpStatus: status, statusHistory: [{ status, at: "2026-11-01T09:00:00.000Z" }], items: [] });

  it("warns when a credit note already exists", () => {
    const rs = returnSummary({ ...base, invoices: [{ id: "c", invoiceNumber: "GS-1", type: "CREDIT_NOTE" }], returns: [ret("INCOMING_MOVED_INTO_STORE")] });
    assert.equal(rs.state, "received");
    assert.equal(rs.tone, "warn");
    assert.match(rs.advice, /Gutschrift GS-1/);
  });

  it("marks old snapshots without return data as not checked", () => {
    assert.equal(returnSummary(base).state, "unknown");
    assert.equal(returnSummary(base).label, "Retoure nicht geprüft");
  });

  it("treats only cancelled returns as cancelled, and a return label alone as no return", () => {
    assert.equal(returnSummary({ ...base, returns: [ret("INCOMING_CANCELLED")] }).state, "cancelled");
    const labelOnly = returnSummary({ ...base, shipments: [{ returnLabels: 1 }], returns: [] });
    assert.equal(labelOnly.state, "none");
    assert.match(labelOnly.advice, /Retourenlabel/);
  });
});
