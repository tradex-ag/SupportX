import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTitles, coloursOf, sizesOf } from "../../packages/core/title-check.ts";

describe("title check", () => {
  it("normalises pack sizes and colours", () => {
    assert.deepEqual(sizesOf("Zimt 60g SD-Dose, auch 0,5 l und 1,2 kg"), ["60 g", "500 ml", "1200 g"]);
    assert.deepEqual(sizesOf("40x40 Kissen, 60 Kps."), ["60 Stück"]);
    assert.deepEqual(coloursOf("die grüne Dose, nicht die braune"), ["grün", "braun"]);
    assert.deepEqual(coloursOf("Grünkohl"), []);
  });

  it("flags a pack size the customer names that is not in the order (the cinnamon case)", () => {
    const hints = checkTitles(
      "Ich habe die grüne Dose Zimt bestellt (70g). Bekommen habe ich die braune Dose (60g).",
      [{ position: 1, title: "Herbaria Zimt gemahlen bio* 60g SD-Dose" }],
    );
    assert.equal(hints.length, 1);
    assert.match(hints[0]!.text, /nennt 70 g.*enthält 60 g/);
  });

  it("flags an order title that differs from the linked article, and stays quiet when all fits", () => {
    const hints = checkTitles("Wo bleibt mein Paket?", [{ title: "Zimt 70 g grüne Dose", articleName: "Zimt 60 g SD-Dose" }]);
    assert.deepEqual(hints.map((h) => h.kind), ["order_vs_article"]);
    assert.deepEqual(checkTitles("Meine Dose 60g ist noch nicht da", [{ title: "Zimt 60g SD-Dose", articleName: "Zimt 60g SD-Dose" }]), []);
    assert.deepEqual(checkTitles("Kaputt angekommen", []), []);
  });
});

describe("quantity check", () => {
  it("reads counts from customer text and titles", async () => {
    const { packCountOf, claimedCountOf } = await import("../../packages/core/title-check.ts");
    assert.equal(packCountOf("Demo-Öl 2 x 100 ml"), 2);
    assert.equal(packCountOf("Demo-Öl 2x100ml"), 2);
    assert.equal(packCountOf("Demo-Tee 3er-Pack"), 3);
    assert.equal(packCountOf("Demo-Tee Doppelpack"), 2);
    assert.equal(packCountOf("Demo-Wasser 6 Flaschen", { containers: true }), 6);
    assert.equal(packCountOf("Demo-Wasser 6 Flaschen"), undefined);
    assert.equal(packCountOf("Kissen 40x40 cm"), undefined);
    assert.equal(packCountOf("Demo-Öl 100 ml"), undefined);
    assert.deepEqual(claimedCountOf("Bestellt waren zwei x 100 ml")?.count, 2);
    assert.equal(claimedCountOf("Nacht x 100 ml"), undefined);
  });

  it("stays quiet when the customer's count matches the order (two positions of one bottle)", () => {
    const lines = [
      { position: 1, title: "Demo-Öl 100ml", articleName: "Demo-Öl 100ml", quantity: 1 },
      { position: 2, title: "Demo-Öl 100ml", articleName: "Demo-Öl 100ml", quantity: 1 },
    ];
    assert.deepEqual(checkTitles("Die Bestellung umfasst 2 x 100 ml Öl, gesendet wurde nur eine Flasche.", lines), []);
  });

  it("flags a customer count above what was sold: maybe the offer shows the wrong quantity", () => {
    const hints = checkTitles("Ich habe 2 x 100 ml bestellt, es kam nur eine Flasche.", [{ position: 1, title: "Demo-Öl 2 x 100 ml", articleName: "Demo-Öl 100 ml", quantity: 1 }]);
    const kinds = hints.map((h) => h.kind);
    assert.ok(kinds.includes("quantity"));
    assert.ok(hints.some((h) => /nennt 2 Stück.*1 Stück.*Angebot/.test(h.text)), "order title vs article");
    assert.ok(hints.some((h) => /Kunde nennt 2 × 100 ml, laut weclapp sind 1 × 100 ml bestellt/.test(h.text)), "customer vs order");
  });

  it("counts a multipack article as several units", () => {
    assert.deepEqual(checkTitles("Bestellt 2 x 100 ml", [{ title: "Demo-Öl Doppelpack 100 ml", articleName: "Demo-Öl 2 x 100 ml", quantity: 1 }]), []);
  });
});
