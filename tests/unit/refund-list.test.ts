import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAmount, groupRefunds, parseAmountInput, parseNoticeAmount, refundSource, type RefundCandidate } from "../../packages/core/refund-list.ts";

const base = (over: Partial<RefundCandidate>): RefundCandidate => ({
  conversationId: "00000000-0000-0000-0000-000000000001",
  subject: "Frage",
  platform: "amazon",
  customerName: "Kundin A",
  customerAddress: null,
  outcome: null,
  outcomeNote: null,
  outcomeAt: null,
  lastMessageAt: "2026-11-01T10:00:00.000Z",
  orderReferences: [],
  externalOrderId: null,
  order: null,
  entry: null,
  ...over,
});

const entry = (over: Partial<NonNullable<RefundCandidate["entry"]>>): NonNullable<RefundCandidate["entry"]> => ({
  addedManually: false, removed: false, amountCents: null, currency: null, note: null, creditNoteNumber: null, doneAt: null, doneByName: null, updatedAt: null, ...over,
});

describe("Erstattungsliste", () => {
  it("takes outcome, refund notice and manual adds, and nothing else", () => {
    assert.equal(refundSource(base({ outcome: "refund" })), "outcome");
    assert.equal(refundSource(base({ outcome: "partial_refund" })), "outcome");
    assert.equal(refundSource(base({ subject: "18.30 EUR Rückerstattung veranlasst – Bestellung 302-1" })), "notice");
    assert.equal(refundSource(base({ entry: entry({ addedManually: true }) })), "manual");
    assert.equal(refundSource(base({ subject: "Bitte um Erstattung" })), null, "a customer asking is no refund");
    assert.equal(refundSource(base({ outcome: "replacement" })), null);
    assert.equal(refundSource(base({ outcome: "refund", entry: entry({ removed: true }) })), null, "taken off by a person");
  });

  it("reads the amount of a marketplace notice and what a person types", () => {
    assert.deepEqual(parseNoticeAmount("18.30 EUR Rückerstattung veranlasst – Bestellung 302-1234567-7654321"), { cents: 1830, currency: "EUR" });
    assert.deepEqual(parseNoticeAmount("Rückerstattung durchgeführt: 1.234,56 € für Bestellung 1"), { cents: 123456, currency: "EUR" });
    assert.deepEqual(parseNoticeAmount("Refund initiated: GBP 9.99"), { cents: 999, currency: "GBP" });
    assert.equal(parseNoticeAmount("Rückerstattung veranlasst – Bestellung 302-1234567-7654321"), null);
    assert.equal(parseNoticeAmount("12,50 € Bitte um Erstattung"), null, "not a notice");
    assert.equal(parseAmountInput("12,50"), 1250);
    assert.equal(parseAmountInput("12.5 €"), 1250);
    assert.equal(parseAmountInput("1.234,00"), 123400);
    assert.equal(parseAmountInput(" "), null);
    assert.equal(parseAmountInput("zwölf"), undefined);
    assert.equal(parseAmountInput("-3"), undefined);
    assert.equal(formatAmount(1830).replace(/\s/g, " "), "18,30 €");
  });

  it("puts the customer case and the marketplace notice of one order together", () => {
    const customer = base({
      conversationId: "00000000-0000-0000-0000-00000000000a", outcome: "partial_refund", outcomeAt: "2026-11-02T08:00:00.000Z",
      externalOrderId: "so-1", orderReferences: [{ value: "302-1234567-7654321", kind: "order" }],
      order: {
        orderNumber: "AU-1", orderNumberAtCustomer: "302-1234567-7654321",
        lines: [{ title: "Tee 100 g", quantity: 2, returnedQuantity: 1 }, { title: "Honig", quantity: 1 }],
        invoices: [{ id: "cn", invoiceNumber: "GS-7", type: "CREDIT_NOTE" }, { id: "re", invoiceNumber: "RE-1", type: "STANDARD_INVOICE" }],
      },
    });
    const notice = base({
      conversationId: "00000000-0000-0000-0000-00000000000b", subject: "12.50 EUR Rückerstattung veranlasst – Bestellung 302-1234567-7654321",
      customerName: null, platform: "amazon", orderReferences: [{ value: "302-1234567-7654321", kind: "order" }], lastMessageAt: "2026-11-03T08:00:00.000Z",
    });
    const other = base({ conversationId: "00000000-0000-0000-0000-00000000000c", outcome: "refund", orderReferences: [{ value: "999", kind: "order" }] });
    const list = groupRefunds([notice, other, customer]);
    assert.equal(list.length, 2);
    const g = list.find((i) => i.conversationIds.length === 2)!;
    assert.equal(g.orderNumber, "AU-1");
    assert.equal(g.marketplaceOrderNumber, "302-1234567-7654321");
    assert.equal(g.kind, "partial");
    assert.deepEqual(g.amount, { cents: 1250, currency: "EUR", from: "notice" });
    assert.deepEqual(g.items, [{ title: "Tee 100 g", quantity: 1 }], "only what came back");
    assert.equal(g.itemsFrom, "return");
    assert.deepEqual(g.creditNotes, ["GS-7"]);
    assert.equal(g.customer, "Kundin A");
    assert.deepEqual(g.cases.map((c) => c.source).sort(), ["notice", "outcome"]);
    assert.equal(g.done, null);
    // An amount a person entered wins over the notice.
    const entered = groupRefunds([{ ...notice, entry: entry({ amountCents: 1999, currency: "EUR", updatedAt: "2026-11-04T00:00:00Z" }) }, customer]);
    assert.deepEqual(entered[0]!.amount, { cents: 1999, currency: "EUR", from: "entered" });
  });

  it("is done when one case of the group is ticked, open ones come first and oldest first", () => {
    const a = base({ conversationId: "00000000-0000-0000-0000-0000000000a1", outcome: "refund", orderReferences: [{ value: "A", kind: "order" }], outcomeAt: "2026-11-05T00:00:00Z" });
    const b = base({ conversationId: "00000000-0000-0000-0000-0000000000b1", outcome: "refund", orderReferences: [{ value: "B", kind: "order" }], outcomeAt: "2026-11-01T00:00:00Z" });
    const c = base({ conversationId: "00000000-0000-0000-0000-0000000000c1", outcome: "refund", orderReferences: [{ value: "C", kind: "order" }], entry: entry({ doneAt: "2026-11-06T00:00:00Z", doneByName: "Mitarbeiterin", creditNoteNumber: "GS-9" }) });
    const c2 = base({ conversationId: "00000000-0000-0000-0000-0000000000c2", subject: "Refund issued for order C", orderReferences: [{ value: "c", kind: "order" }] });
    const list = groupRefunds([c, a, c2, b]);
    assert.deepEqual(list.map((i) => i.conversationIds[0]), [b.conversationId, a.conversationId, c.conversationId]);
    assert.deepEqual(list[2]!.done, { at: "2026-11-06T00:00:00Z", by: "Mitarbeiterin", creditNoteNumber: "GS-9" });
    assert.equal(list[2]!.conversationIds.length, 2, "order numbers compare without case");
  });

  it("keeps cases without order number on their own and ignores tracking numbers", () => {
    const a = base({ conversationId: "00000000-0000-0000-0000-0000000000d1", outcome: "refund", orderReferences: [{ value: "TRACK1", kind: "tracking" }] });
    const b = base({ conversationId: "00000000-0000-0000-0000-0000000000d2", outcome: "refund", orderReferences: [{ value: "TRACK1", kind: "tracking" }] });
    assert.equal(groupRefunds([a, b]).length, 2);
  });
});
