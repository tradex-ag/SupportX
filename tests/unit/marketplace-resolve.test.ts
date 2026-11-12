import { test } from "node:test";
import assert from "node:assert/strict";
import { amazonResolveLink, isSellerCentralUrl, marketplaceResolve } from "../../packages/core/marketplace-resolve.ts";

const mail = (extra = "") => `Nachricht:

Bitte dann um eine Erstattung.

Nachricht anzeigen <https://sellercentral.amazon.de/nms/sellermobile/redirect/61dc?nt=X>
Fall lösen <https://sellercentral.amazon.de/nms/redirect/5b97?nt=X>${extra}`;

test("Amazon mail: the 'Fall lösen' link comes before 'Nachricht anzeigen'", () => {
  assert.deepEqual(amazonResolveLink(mail()), { url: "https://sellercentral.amazon.de/nms/redirect/5b97?nt=X", label: "Fall lösen" });
  assert.deepEqual(amazonResolveLink("View message <https://sellercentral.amazon.co.uk/nms/redirect/1?nt=Y>"), { url: "https://sellercentral.amazon.co.uk/nms/redirect/1?nt=Y", label: "Nachricht anzeigen" });
});

test("only Seller Central over https is opened", () => {
  assert.equal(amazonResolveLink("Fall lösen <https://evil.example/nms/redirect/1>"), null);
  assert.equal(amazonResolveLink("Fall lösen <http://sellercentral.amazon.de/x>"), null);
  assert.equal(amazonResolveLink("Fall lösen <https://sellercentral.amazon.de.evil.example/x>"), null);
  assert.equal(isSellerCentralUrl("https://sellercentral-europe.amazon.com/x"), true);
});

test("open at Amazon: newest buyer mail after our last answer", () => {
  const r = marketplaceResolve("amazon", [
    { direction: "inbound", kind: "customer", body_text: mail(), received_at: "2026-11-04T17:32:00Z" },
    { direction: "outbound", kind: "reply", body_text: "Antwort", received_at: "2026-11-11T12:08:00Z" },
    { direction: "inbound", kind: "customer", body_text: mail(), received_at: "2026-11-11T17:24:00Z" },
  ]);
  assert.deepEqual(r, { platform: "amazon", state: "open", url: "https://sellercentral.amazon.de/nms/redirect/5b97?nt=X", label: "Fall lösen" });
});

test("answered through the relay: nothing left at Amazon", () => {
  assert.deepEqual(marketplaceResolve("amazon", [
    { direction: "inbound", kind: "customer", body_text: mail(), received_at: "2026-11-04T17:32:00Z" },
    { direction: "outbound", kind: "own_copy", body_text: "Antwort", received_at: "2026-11-05T08:00:00Z" },
  ]), { platform: "amazon", state: "answered" });
});

test("no link in the mail, other platforms, no buyer mail", () => {
  assert.deepEqual(marketplaceResolve("amazon", [{ direction: "inbound", kind: "customer", body_text: "Hallo", received_at: "2026-11-04T17:32:00Z" }]), { platform: "amazon", state: "no_link" });
  assert.equal(marketplaceResolve("email", [{ direction: "inbound", kind: "customer", body_text: mail(), received_at: "2026-11-04T17:32:00Z" }]), null);
  assert.equal(marketplaceResolve("amazon", []), null);
});
