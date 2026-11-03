import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTopic } from "../../packages/core/topic.ts";
import { trackingComplete } from "../../packages/services/automation.ts";

describe("classifyTopic", () => {
  it("sorts by keyword rules, invoice requests first", () => {
    assert.equal(classifyTopic("Wo bleibt mein Paket? Wann kommt die Bestellung an?"), "parcel_status");
    assert.equal(classifyTopic("Bitte schicken Sie mir die Rechnung für mein Paket."), "invoice");
    assert.equal(classifyTopic("Hallo, schönes Wetter heute."), "other");
  });
});

describe("trackingComplete", () => {
  const status = (n: number) => ({ id: `shipment.${n}.status`, text: "versendet" });
  const parcel = (n: number, url: boolean) => ({ id: `shipment.${n}.parcel.1`, text: url ? "Paket DEMO1, Trackinglink https://t.invalid/1" : "Paket DEMO1" });
  it("needs a tracking link for every shipment", () => {
    assert.equal(trackingComplete([status(1), parcel(1, true)] as never), true);
    assert.equal(trackingComplete([status(1), parcel(1, true), status(2)] as never), false);
    assert.equal(trackingComplete([status(1), parcel(1, false)] as never), false);
    assert.equal(trackingComplete([] as never), false);
    assert.equal(trackingComplete([{ id: "shipments.none", text: "" }] as never), false);
  });
});
