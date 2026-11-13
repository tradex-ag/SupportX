import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OWN_COPY_REASON, SYSTEM_NOTICE_REASON, categorizeMail, systemNoticeOf } from "../../packages/core/category.ts";

const mail = (over: Partial<Parameters<typeof categorizeMail>[0]> = {}) => ({
  from: { address: "kunde@example.invalid" }, subject: "Frage", bodyText: "Hallo", headers: {}, hasOrderReference: false, ...over,
});

describe("request or advertising", () => {
  it("files a marketplace promotion to partners as info", () => {
    const d = categorizeMail(mail({
      from: { address: "marketplace@partner-shop.example.invalid" },
      subject: "Singles Day 2026 – Jetzt für unsere Voucher-Aktionen anmelden!",
      bodyText: "Liebe Marketplace-Partner,\nder Singles Day steht vor der Tür! Die Voucher-Aktionen stehen ab sofort unter Promotions zur Anmeldung bereit.",
    }));
    assert.equal(d.category, "info");
    assert.match(d.reason, /Anrede an Händler/);
  });

  it("files English partner news and bulk mail headers as info", () => {
    assert.equal(categorizeMail(mail({ subject: "Top brands in demand on our marketplace", bodyText: "Dear partner, these brands sell well." })).category, "info");
    assert.equal(categorizeMail(mail({ headers: { "list-unsubscribe": "<https://x.invalid/u>" }, bodyText: "Unser neues Sortiment" })).category, "info");
  });

  it("keeps customer requests, even with promo words or a newsletter footer", () => {
    assert.equal(categorizeMail(mail({ subject: "Wo bleibt meine Bestellung?", bodyText: "Ich habe beim Singles Day bestellt, wann kommt mein Paket?" })).category, "support");
    assert.equal(categorizeMail(mail({ subject: "Rückfrage", bodyText: "Newsletter abbestellen hat nicht geklappt", hasOrderReference: true })).category, "support");
    assert.equal(categorizeMail(mail({ subject: "Produktfrage", bodyText: "Ist das Mittel auch für Kinder geeignet?" })).category, "support");
  });

  it("lets the operator's sender rules win, address before domain", () => {
    const rules = [
      { matchType: "from_domain" as const, pattern: "shop.example.invalid", category: "info" as const },
      { matchType: "from_address" as const, pattern: "support@shop.example.invalid", category: "support" as const },
    ];
    assert.equal(categorizeMail(mail({ from: { address: "news@mail.shop.example.invalid" } }), rules).category, "info");
    const d = categorizeMail(mail({ from: { address: "support@shop.example.invalid" }, bodyText: "Liebe Partner, Webinar" }), rules);
    assert.equal(d.category, "support");
    assert.equal(d.source, "rule");
  });
});

describe("own copies from Amazon", () => {
  const amazon = { address: "donotreply@amazon.com", name: "Amazon.de" };
  it("sorts out the copy of a message we sent, even with an order number in it", () => {
    const d = categorizeMail({ from: amazon, subject: "Deine E-Mail an Erika", bodyText: "[Amazon.com] Sehr geehrte(r) Demo-Händler,\nHier ist eine Kopie der E-Mail, die du an Erika gesendet hast.\nBestellnummer 302-1234567-7654321", headers: {}, hasOrderReference: true });
    assert.equal(d.category, "info");
    assert.equal(d.reason, OWN_COPY_REASON);
    assert.equal(categorizeMail({ from: amazon, subject: "Your e-mail to Max", bodyText: "Here is a copy of the e-mail you sent to Max.", headers: {}, hasOrderReference: true }).category, "info");
  });
  it("keeps a real buyer message a request", () => {
    const d = categorizeMail({ from: { address: "kunde@marketplace.amazon.de" }, subject: "Frage zur Bestellung", bodyText: "Ich habe eine Kopie der Rechnung gebraucht, die Sie mir gesendet haben.", headers: {}, hasOrderReference: true });
    assert.equal(d.category, "support");
  });
});

describe("marketplace system notices", () => {
  it("files seller notices from the bare amazon domain as info, despite order number and refund words", () => {
    for (const [address, subject] of [
      ["donotreply@amazon.com", "Dein SAFE-T-Antrag 10000-20000-3000000 wurde für die Bestellung 302-0000000-0000001 eingereicht"],
      ["seller-notification@amazon.de", "Benachrichtigung zur Rücksendegenehmigung für die Bestellung 302-0000000-0000002"],
      ["seller-notification@amazon.de", "9.99 EUR Rückerstattung veranlasst – Bestellung 302-0000000-0000003"],
    ] as const) {
      const d = categorizeMail(mail({ from: { address }, subject, bodyText: "Wir haben eine Rückerstattung veranlasst. Rücksendung: ja", hasOrderReference: true }));
      assert.equal(d.category, "info", subject);
      assert.equal(d.reason, SYSTEM_NOTICE_REASON);
    }
  });

  it("keeps buyer mails relayed by the marketplace and claims against us as requests", () => {
    assert.equal(systemNoticeOf({ from: { address: "abc123@marketplace.amazon.de" }, subject: "Frage zur Bestellung" }), null);
    assert.equal(categorizeMail(mail({ from: { address: "abc123@marketplace.amazon.de" }, subject: "Rücksendung", hasOrderReference: true })).category, "support");
    assert.equal(systemNoticeOf({ from: { address: "atoz-guarantee-no-reply@amazon.de" }, subject: "A-bis-z-Garantieantrag für Bestellung 302-0000000-0000004" }), null);
    assert.equal(systemNoticeOf({ from: { address: "x@notamazon.de" }, subject: "Hinweis" }), null);
  });

  it("lets an operator rule overrule the built-in notice detection", () => {
    const rules = [{ matchType: "from_address" as const, pattern: "donotreply@amazon.com", category: "support" as const }];
    assert.equal(categorizeMail(mail({ from: { address: "donotreply@amazon.com" }, subject: "Hinweis" }), rules).category, "support");
  });
});
