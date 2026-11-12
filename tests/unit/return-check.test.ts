import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WeclappOrderProvider } from "../../packages/connectors/weclapp/adapter.ts";
import { formatMoney, refundNoticeAmount, returnCheck, type ReturnCheckOrder } from "../../packages/core/return-check.ts";
import type { ReturnFact } from "../../packages/core/returns.ts";
import { DEMO, demoWeclappData } from "../../packages/testing/demo-data.ts";
import { startFakeWeclapp } from "../../packages/testing/fake-weclapp.ts";

const ret = (id: string, status: string, items: ReturnFact["items"]): ReturnFact => ({ id, returnNumber: id, erpStatus: status, statusHistory: [], items });
const IN = "INCOMING_MOVED_INTO_STORE";

/** 2 × A at 10.00 and 1 × B at 20.00, shipping 5.00: total 45.00. */
function order(returns: ReturnFact[], extra: Partial<ReturnCheckOrder> = {}): ReturnCheckOrder {
  return {
    lines: [
      { id: "l1", title: "Artikel A", articleId: "art-a", quantity: 2, shippedQuantity: 2, grossAmount: 20 },
      { id: "l2", title: "Artikel B", articleId: "art-b", quantity: 1, shippedQuantity: 1, grossAmount: 20 },
    ],
    shipments: [],
    invoices: [],
    returns,
    grossAmount: 45,
    shippingGrossAmount: 5,
    currency: "EUR",
    amountsRead: true,
    ...extra,
  };
}
const codes = (o: ReturnCheckOrder, notices = [] as Parameters<typeof returnCheck>[1]) => returnCheck(o, notices).findings.map((f) => f.code);

describe("Retourenprüfung: Stückzahl", () => {
  it("nothing to check without a return", () => {
    const c = returnCheck(order([]));
    assert.equal(c.applicable, false);
    assert.deepEqual(c.findings, []);
  });

  it("full return: all units back, shipping belongs to the expected refund", () => {
    const c = returnCheck(order([ret("R1", IN, [{ orderLineId: "l1", quantity: 2 }, { orderLineId: "l2", quantity: 1 }])]));
    assert.equal(c.complete, true);
    assert.equal(c.receivedUnits, 3);
    assert.deepEqual(c.findings.map((f) => f.code), ["complete"]);
    assert.deepEqual({ goods: c.amounts!.goods, expected: c.amounts!.expected, maximum: c.amounts!.maximum }, { goods: 40, expected: 45, maximum: 45 });
  });

  it("partial return: names what is missing and leaves shipping out", () => {
    const c = returnCheck(order([ret("R1", IN, [{ orderLineId: "l1", quantity: 1 }])]));
    assert.equal(c.complete, false);
    const partial = c.findings.find((f) => f.code === "partial")!;
    assert.equal(partial.tone, "warn");
    assert.match(partial.text, /1 von 3 Stück zurück/);
    assert.match(partial.text, /1 × „Artikel A“, 1 × „Artikel B“/);
    assert.equal(c.amounts!.goods, 10);
    assert.equal(c.amounts!.expected, 10);
  });

  it("announced but not booked in counts as nothing back yet", () => {
    const c = returnCheck(order([ret("R1", "NEW", [{ orderLineId: "l1", quantity: 2 }])]));
    assert.equal(c.applicable, true);
    assert.equal(c.receivedUnits, 0);
    assert.equal(c.lines[0]!.announced, 2);
    assert.equal(c.amounts, undefined);
  });

  it("more units in returns than ordered, across two returns: likely a duplicate", () => {
    const o = order([ret("R1", IN, [{ orderLineId: "l1", quantity: 2 }]), ret("R2", "NEW", [{ orderLineId: "l1", quantity: 2 }])]);
    const f = returnCheck(o).findings.find((x) => x.code === "duplicate_return")!;
    assert.equal(f.tone, "bad");
    assert.match(f.text, /bestellt 2, in Retouren 4 \(R1, R2\)/);
    assert.match(f.text, /Höchstens 2 Stück erstatten/);
    // The goods value never counts more than ordered.
    assert.equal(returnCheck(o).amounts!.goods, 20);
  });

  it("more booked in than shipped", () => {
    const o = order([ret("R1", IN, [{ orderLineId: "l1", quantity: 2 }])]);
    const c = returnCheck({ ...o, lines: [{ ...o.lines[0]!, shippedQuantity: 1 }, o.lines[1]!] });
    assert.ok(c.findings.some((f) => f.code === "more_than_shipped" && f.tone === "bad"));
  });

  it("an item that is not on the order is flagged, matched by article when the line is missing", () => {
    const c = returnCheck(order([ret("R1", IN, [{ articleId: "art-b", title: "Artikel B", quantity: 1 }, { articleId: "art-x", title: "Fremder Artikel", quantity: 1 }])]));
    assert.equal(c.lines[1]!.received, 1, "matched by article");
    const foreign = c.findings.find((f) => f.code === "foreign_item")!;
    assert.equal(foreign.tone, "bad");
    assert.match(foreign.text, /„Fremder Artikel“, das nicht zu dieser Bestellung gehört/);
  });

  it("cancelled returns do not count", () => {
    const c = returnCheck(order([ret("R1", "INCOMING_CANCELLED", [{ orderLineId: "l1", quantity: 2 }])]));
    assert.equal(c.applicable, false);
  });

  it("order line quantity that disagrees with the return records", () => {
    const o = order([ret("R1", IN, [{ orderLineId: "l1", quantity: 1 }])]);
    const c = returnCheck({ ...o, lines: [{ ...o.lines[0]!, returnedQuantity: 2 }, o.lines[1]!] });
    assert.ok(c.findings.some((f) => f.code === "erp_quantity_mismatch" && f.tone === "warn"));
  });

  it("returned quantity on the order without return records still counts (old snapshots)", () => {
    const o = order([]);
    const c = returnCheck({ ...o, returns: undefined, lines: [{ ...o.lines[0]!, returnedQuantity: 1 }, o.lines[1]!] });
    assert.equal(c.applicable, true);
    assert.equal(c.receivedUnits, 1);
  });
});

describe("Retourenprüfung: Beträge und Versandkosten", () => {
  const full = [ret("R1", IN, [{ orderLineId: "l1", quantity: 2 }, { orderLineId: "l2", quantity: 1 }])];
  const partial = [ret("R1", IN, [{ orderLineId: "l1", quantity: 1 }])];
  const credit = (amount: number, shipping = 0) => ({ invoices: [{ id: "cn", invoiceNumber: "GS-1", type: "CREDIT_NOTE", grossAmount: amount, shippingGrossAmount: shipping }] });

  it("credit note matching goods and shipping on a full return", () => {
    const c = returnCheck(order(full, credit(45, 5)));
    const f = c.findings.find((x) => x.code === "credit_matches")!;
    assert.equal(f.tone, "good");
    assert.match(f.text, /Gutschrift GS-1 45,00 € passt zur Retoure \(Ware und Versandkosten\)/);
    assert.equal(c.amounts!.creditedShipping, 5);
  });

  it("full return refunded without shipping costs", () => {
    const f = returnCheck(order(full, credit(40))).findings.find((x) => x.code === "shipping_missing")!;
    assert.equal(f.tone, "warn");
    assert.match(f.text, /Versandkosten von 5,00 € nicht/);
  });

  it("partial return refunded with shipping costs", () => {
    assert.ok(codes(order(partial, credit(15))).includes("shipping_on_partial"));
  });

  it("more than the order total is a bad sign; negative credit note amounts count as their value", () => {
    const f = returnCheck(order(full, credit(-50))).findings.find((x) => x.code === "over_credited")!;
    assert.equal(f.tone, "bad");
    assert.match(f.text, /50,00 € ist höher als die ganze Bestellung \(45,00 €\)/);
  });

  it("higher or lower than the returned goods", () => {
    assert.ok(codes(order(partial, credit(12))).includes("credit_higher"));
    const lower = returnCheck(order(partial, credit(6))).findings.find((x) => x.code === "credit_lower")!;
    assert.match(lower.text, /Rücksendekosten oder Wertminderung abgezogen/);
  });

  it("marketplace refund notices are compared like credit notes", () => {
    const notice = refundNoticeAmount("18,30 EUR Rückerstattung veranlasst – Bestellung 302-1234567-7654321")!;
    assert.deepEqual(notice.amount, 18.3);
    const f = returnCheck(order(partial), [notice]).findings.find((x) => x.text.startsWith("Marktplatz-Erstattung"))!;
    assert.equal(f.code, "credit_higher");
    assert.ok(codes(order(full), [{ amount: 45, subject: "x" }]).includes("credit_matches"));
  });

  it("spreads an order discount over the lines", () => {
    // Lines 40.00, shipping 5.00, but the order total is 41.00: 10 % order discount on the goods.
    const c = returnCheck(order(partial, { grossAmount: 41 }));
    assert.equal(c.lines[0]!.unitGross, 9);
    assert.equal(c.amounts!.goods, 9);
  });

  it("snapshots without amounts say so instead of guessing", () => {
    const c = returnCheck(order(partial, { amountsRead: undefined, grossAmount: undefined }));
    assert.equal(c.amounts, undefined);
    assert.ok(c.findings.some((f) => f.code === "amounts_unknown" && f.tone === "neutral"));
  });
});

describe("Erstattungsbetrag aus Marktplatz-Meldungen", () => {
  it("reads amounts with currency, ignores order numbers", () => {
    assert.equal(refundNoticeAmount("18.30 EUR Rückerstattung veranlasst – Bestellung 302-1234567-7654321")?.amount, 18.3);
    assert.equal(refundNoticeAmount("Rückerstattung über 1.234,56 € veranlasst")?.amount, 1234.56);
    assert.equal(refundNoticeAmount("Rückerstattung veranlasst – Bestellung 302-1234567-7654321"), undefined);
    assert.equal(refundNoticeAmount("Erstattung 12.50 veranlasst"), undefined, "no currency, no amount");
  });

  it("formats money in German", () => {
    assert.equal(formatMoney(1234.5, "EUR"), "1.234,50 €");
    assert.equal(formatMoney(3, "CHF"), "3,00 CHF");
  });
});

describe("weclapp amounts", () => {
  it("reads line, shipping and order amounts and the currency name (GET only)", async () => {
    const fake = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken });
    try {
      const provider = new WeclappOrderProvider({ baseUrl: fake.baseUrl, apiToken: DEMO.weclappToken, searchFields: ["orderNumberAtCustomer"], allowTestEndpoints: true });
      const result = await provider.findOrders([{ value: "DM-2026-000123", kind: "order" }], { field: "none", value: "" });
      if (result.status !== "unique") throw new Error("not unique");
      const o = result.order;
      assert.equal(o.grossAmount, 30.7);
      assert.equal(o.shippingGrossAmount, 4.9);
      assert.equal(o.currency, "EUR");
      assert.equal(o.amountsRead, true);
      assert.equal(o.lines[0]!.grossAmount, 25.8);
      assert.ok(fake.requests.every((r) => r.startsWith("GET ")));
      const c = returnCheck(o);
      assert.equal(c.receivedUnits, 1);
      assert.equal(c.baseUnits, 2);
      assert.equal(c.amounts!.goods, 12.9);
      assert.equal(c.amounts!.expected, 12.9, "partial return: shipping not included");
      assert.ok(c.findings.some((f) => f.code === "partial"));
    } finally {
      await fake.close();
    }
  });
});
