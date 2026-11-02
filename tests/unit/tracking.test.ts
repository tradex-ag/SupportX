import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackingHref } from "../../packages/core/tracking.ts";

describe("trackingHref", () => {
  const n = "00340434695312134859";
  it("puts the parcel number into the link", () => {
    assert.equal(trackingHref("https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=", n), `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}`);
    assert.equal(trackingHref("https://carrier.example/track/{trackingNumber}", n), `https://carrier.example/track/${n}`);
    assert.equal(trackingHref("https://carrier.example/t?id=%s", n), `https://carrier.example/t?id=${n}`);
    assert.equal(trackingHref("https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html", n), `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}`);
    assert.equal(trackingHref("https://tracking.dpd.de/", "01234567890123"), "https://tracking.dpd.de/status/de_DE/parcel/01234567890123");
  });
  it("leaves complete or unknown links alone", () => {
    const full = `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}`;
    assert.equal(trackingHref(full, n), full);
    assert.equal(trackingHref("https://unknown-carrier.example/track", n), "https://unknown-carrier.example/track");
    assert.equal(trackingHref(undefined, n), undefined);
    assert.equal(trackingHref("javascript:alert(1)", n), undefined);
  });
});
