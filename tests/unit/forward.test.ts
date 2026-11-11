import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardMode, forwardSubject, forwardText, isRelayAddress, maskAddresses, parseRecipients } from "../../packages/core/forward.ts";

describe("forwarding a mail", () => {
  it("parses typed recipients, de-duplicates and names wrong ones", () => {
    assert.deepEqual(parseRecipients("Einkauf@Lieferant.example, buchhaltung@firma.example; einkauf@lieferant.example"), { valid: ["einkauf@lieferant.example", "buchhaltung@firma.example"], invalid: [] });
    assert.deepEqual(parseRecipients(["<a@b.example>", "kein-at", "x@y"]), { valid: ["a@b.example"], invalid: ["kein-at", "x@y"] });
  });

  it("forwards plain mails as original, marketplace relay mails as text only", () => {
    assert.equal(forwardMode("email", ["kunde@example.invalid"]), "original");
    assert.equal(forwardMode("shopify", ["kunde@example.invalid"]), "original");
    assert.equal(forwardMode("amazon", ["kunde@example.invalid"]), "text");
    assert.equal(forwardMode("ebay", []), "text");
    assert.equal(forwardMode("email", ["abc123@marketplace.amazon.de"]), "text", "a relay sender wins over a wrong routing default");
    assert.equal(isRelayAddress("x@members.ebay.de"), true);
    assert.equal(isRelayAddress("x@amazon.de"), false);
  });

  it("builds the subject once", () => {
    assert.equal(forwardSubject("Bestellung 123"), "Fwd: Bestellung 123");
    assert.equal(forwardSubject("AW: WG: Fwd: Bestellung 123"), "Fwd: Bestellung 123");
    assert.equal(forwardSubject(""), "Fwd: (ohne Betreff)");
  });

  it("removes every address from the text of a relay forward", () => {
    assert.equal(maskAddresses("Antwort an abc+1@marketplace.amazon.de oder kunde@example.invalid."), "Antwort an [Adresse entfernt] oder [Adresse entfernt].");
    const text = forwardText({ comment: "Bitte prüfen", platform: "amazon", receivedAt: "2026-11-10T09:00:00Z", subject: "Frage von abc@marketplace.amazon.de", direction: "inbound", body: "Hallo, Dose kaputt. Mail: abc@marketplace.amazon.de", leftOut: ["video.mp4"] });
    assert.match(text, /^Bitte prüfen\n\n---------- Weitergeleitete Nachricht/);
    assert.match(text, /Von: Kunde über Amazon/);
    assert.doesNotMatch(text, /@/);
    assert.match(text, /Nicht mitgesendet \(zu groß\): video\.mp4/);
  });
});
