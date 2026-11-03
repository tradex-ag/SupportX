import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderRecord } from "../../packages/core/contracts.ts";
import { deadlineState, normalizeDeadlines } from "../../packages/core/deadline.ts";
import { checkDraft, hasBlockingIssue } from "../../packages/core/draft-check.ts";
import { buildOrderFacts } from "../../packages/core/facts.ts";
import { fillSnippet, openPlaceholders } from "../../packages/core/snippets.ts";

const order: OrderRecord = {
  provider: "weclapp",
  id: "so-1",
  orderNumber: "AU-1",
  orderNumberAtCustomer: "302-1234567-7654321",
  orderDate: "2026-10-14T10:00:00.000Z",
  status: "ORDER_CONFIRMATION_PRINTED",
  tags: [],
  lines: [{ id: "l1", title: "Teekanne", quantity: 1 }],
  shipments: [
    {
      id: "sh1", shipmentNumber: "LS-1", erpStatus: "SHIPPED", statusHistory: [], items: [],
      parcels: [{ id: "p1", trackingId: "00340434", trackingUrl: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=", source: "parcels" }],
    },
  ],
  invoices: [],
  retrievedAt: "2026-10-21T08:00:00.000Z",
};

describe("deadlineState", () => {
  const since = new Date("2026-11-02T08:00:00Z");
  const at = (h: number) => new Date(since.getTime() + h * 3_600_000);
  it("is green, yellow from half the window, red in the last 4 hours and when overdue", () => {
    assert.equal(deadlineState(since, 24, at(2))!.tone, "ok");
    assert.equal(deadlineState(since, 24, at(13))!.tone, "warn");
    assert.equal(deadlineState(since, 24, at(21))!.tone, "bad");
    const over = deadlineState(since, 24, at(27))!;
    assert.equal(over.tone, "bad");
    assert.equal(over.label, "seit 3 Std. überfällig");
    assert.equal(deadlineState(since, 24, at(2))!.label, "noch 22 Std.");
    assert.equal(deadlineState(since, 48, at(46.5))!.label, "noch 1 Std. 30 Min.");
    assert.equal(deadlineState(since, 24, at(23.5))!.label, "noch 30 Min.");
    assert.equal(deadlineState(since, 168, at(0))!.label, "noch 7 Tage");
  });
  it("short windows turn red in the last quarter, not at once", () => {
    assert.equal(deadlineState(since, 4, at(1))!.tone, "ok");
    assert.equal(deadlineState(since, 4, at(3.5))!.tone, "bad");
  });
  it("has no deadline without a waiting message or with 0 hours", () => {
    assert.equal(deadlineState(null, 24), null);
    assert.equal(deadlineState(since, 0), null);
    assert.equal(deadlineState("kein Datum", 24), null);
  });
  it("accepts only known platforms and whole hours 0..168", () => {
    assert.deepEqual(normalizeDeadlines({ amazon: "12", ebay: "" }), { amazon: 12, ebay: 0 });
    assert.equal(normalizeDeadlines({ amazon: 200 }), null);
    assert.equal(normalizeDeadlines({ amazon: 1.5 }), null);
    assert.equal(normalizeDeadlines({ otto: 24 }), null);
    assert.equal(normalizeDeadlines([24]), null);
  });
});

describe("fillSnippet", () => {
  const text = "Guten Tag {Name},\n\nzu {bestellnummer} (Auftrag { Auftragsnummer }) vom {Bestelldatum}: Sendung {Sendungsnummer}\n{Trackinglink}\n\n{Signatur}";
  it("fills name, order and parcel data and the signature", () => {
    const r = fillSnippet(text, { customerName: "Erika Muster", order, signature: "Ihr Team" });
    assert.deepEqual(r.missing, []);
    assert.match(r.text, /Guten Tag Erika Muster,/);
    assert.match(r.text, /zu 302-1234567-7654321 \(Auftrag AU-1\) vom 14\.10\.2026: Sendung 00340434/);
    assert.match(r.text, /piececode=00340434\n\nIhr Team$/, "tracking link carries the parcel number");
    assert.deepEqual(openPlaceholders(r.text), []);
  });
  it("leaves placeholders without a value and names them", () => {
    const r = fillSnippet(text, { customerName: null, order: null, signature: "Ihr Team" });
    assert.deepEqual(r.missing.sort(), ["Auftragsnummer", "Bestelldatum", "Bestellnummer", "Name", "Sendungsnummer", "Trackinglink"]);
    assert.ok(r.text.includes("{Bestellnummer}") && r.text.includes("{Auftragsnummer}"));
    assert.ok(openPlaceholders(r.text).includes("{Name}"));
  });
  it("ignores braces that are no placeholder", () => {
    assert.equal(fillSnippet("Preis {netto}", { customerName: null, order: null, signature: "" }).text, "Preis {netto}");
  });
});

describe("checkDraft: placeholders and marketplace rules", () => {
  const facts = buildOrderFacts(order);
  const base = { citedFactIds: [], facts, order, orderStatus: "unique" as const, allowedLinkPrefixes: ["https://shop.example.invalid/"] };
  const codes = (text: string, sourcePlatform?: string) => checkDraft({ ...base, text, sourcePlatform }).map((i) => i.code);

  it("blocks an open placeholder", () => {
    const issues = checkDraft({ ...base, text: "Guten Tag {Name}, danke." });
    assert.ok(hasBlockingIssue(issues));
    assert.ok(issues.some((i) => i.code === "PLACEHOLDER_OPEN"));
  });
  it("warns about e-mail addresses and phone numbers on marketplaces, not on own mail", () => {
    assert.ok(codes("Schreiben Sie an service@shop.example.invalid", "amazon").includes("MARKETPLACE_CONTACT"));
    assert.ok(codes("Rufen Sie uns an: Tel. 0341 123456", "kaufland").includes("MARKETPLACE_CONTACT"));
    assert.ok(codes("Hotline +49 341 123456", "ebay").includes("MARKETPLACE_CONTACT"));
    assert.ok(!codes("Schreiben Sie an service@shop.example.invalid", "email").includes("MARKETPLACE_CONTACT"));
    assert.ok(!codes("Ihre Bestellung 302-1234567-7654321, Sendung 00340434.", "amazon").includes("MARKETPLACE_CONTACT"), "order and parcel numbers are no phone numbers");
  });
  it("on Amazon warns about review requests and links the order does not need", () => {
    assert.ok(codes("Über eine positive Bewertung würden wir uns freuen.", "amazon").includes("MARKETPLACE_REVIEW"));
    assert.ok(!codes("Über eine positive Bewertung würden wir uns freuen.", "ebay").includes("MARKETPLACE_REVIEW"));
    const link = codes("Mehr unter https://shop.example.invalid/faq", "amazon");
    assert.ok(link.includes("MARKETPLACE_LINK") && !link.includes("UNVERIFIED_LINK"));
    const tracking = facts.find((f) => f.id === "shipment.1.parcel.1")!.text.match(/https:\S+/)![0].replace(/[.,]$/, "");
    assert.ok(!codes(`Ihr Paket: ${tracking}`, "amazon").includes("MARKETPLACE_LINK"), "tracking link from weclapp is fine");
  });
  it("warns about advertising on marketplaces", () => {
    assert.ok(codes("Mit dem Gutscheincode SPAR10 sparen Sie beim nächsten Einkauf in unserem Shop.", "shop_apotheke").includes("MARKETPLACE_MARKETING"));
    assert.ok(!codes("Mit dem Gutscheincode SPAR10 sparen Sie.", "shopify").includes("MARKETPLACE_MARKETING"));
  });
  it("marketplace findings are warnings, never blocks", () => {
    const issues = checkDraft({ ...base, text: "Tel. 0341 123456, bitte 5 Sterne", sourcePlatform: "amazon" });
    assert.ok(issues.length >= 2 && issues.every((i) => i.severity === "warn"));
  });
});
