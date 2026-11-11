import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRefundNotice, refundDue } from "../../packages/core/refund-due.ts";
import type { ReturnOrderInput } from "../../packages/core/returns.ts";

const back: ReturnOrderInput = {
  lines: [{ returnedQuantity: 1 }],
  shipments: [],
  invoices: [{ id: "inv-1", invoiceNumber: "RE-100", type: "SALES_INVOICE" }],
  returns: [{ id: "r-1", returnNumber: "WE-1", erpStatus: "INCOMING_MOVED_INTO_STORE", erpStatusAt: "2026-10-20T09:00:00Z", statusHistory: [{ status: "INCOMING_MOVED_INTO_STORE", at: "2026-10-20T09:00:00Z" }], items: [] }],
};

describe("Erstattung offen", () => {
  it("is due when the goods are booked in and nothing says refunded", () => {
    const r = refundDue({ order: back, subject: "Ergebnis des Antrags für Bestellung 111-0000000-0000001" });
    assert.equal(r.state, "due");
    assert.equal(r.headline, "Erstattung ist jetzt zu machen: Ware zurück (20.10.2026).");
  });

  it("is nothing without a received return", () => {
    assert.equal(refundDue({ order: null }).state, "none");
    assert.equal(refundDue({ order: { ...back, returns: [] , lines: [] } }).state, "none");
    const announced = { ...back, lines: [], returns: [{ ...back.returns![0]!, erpStatus: "NEW", statusHistory: [] }] };
    assert.equal(refundDue({ order: announced }).state, "none", "goods not yet back");
  });

  it("is done with a credit note, an outcome or a refund notice for the same order", () => {
    const credit = { ...back, invoices: [...back.invoices, { id: "cn-1", invoiceNumber: "GS-7", invoiceDate: "2026-10-21", type: "CREDIT_NOTE" }] };
    const a = refundDue({ order: credit });
    assert.equal(a.state, "done");
    assert.match(a.headline, /Gutschrift GS-7 in weclapp vom 21\.10\.2026/);
    assert.equal(refundDue({ order: back, outcome: "partial_refund" }).state, "done");
    assert.equal(refundDue({ order: back, related: [{ subject: "Frage zur Lieferung", outcome: "refund" }] }).state, "done");
    const n = refundDue({ order: back, related: [{ subject: "12.50 EUR Rückerstattung veranlasst – Bestellung 111-0000000-0000001", outcome: null, last_message_at: new Date("2026-10-22T08:00:00Z") }] });
    assert.equal(n.state, "done");
    assert.equal(n.signals[0]!.source, "notice");
    assert.equal(refundDue({ order: back, subject: "12.50 EUR Rückerstattung veranlasst – Bestellung 111-0000000-0000001" }).state, "done", "the notice case itself");
  });

  it("does not take a customer's refund request for a refund", () => {
    assert.equal(isRefundNotice("Bitte um Erstattung"), false);
    assert.equal(isRefundNotice("Wann kommt meine Rückerstattung?"), false);
    assert.equal(isRefundNotice("Refund initiated for order 1"), true);
    assert.equal(refundDue({ order: back, related: [{ subject: "Bitte um Erstattung", outcome: "question" }] }).state, "due");
  });
});
