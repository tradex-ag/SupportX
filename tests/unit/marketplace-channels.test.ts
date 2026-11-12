import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { EbayMessageChannel } from "../../packages/connectors/ebay/message-channel.ts";
import { buildEbayAuthorizeUrl, EBAY_MESSAGE_SCOPES, exchangeEbayCode, fetchEbayUsername } from "../../packages/connectors/ebay/oauth.ts";
import { kauflandSignatureBase, signKauflandRequest } from "../../packages/connectors/kaufland/signing.ts";
import { KauflandTicketsChannel } from "../../packages/connectors/kaufland/tickets-channel.ts";
import { sameText } from "../../packages/connectors/marketplace-common.ts";
import { MiraklInboxChannel } from "../../packages/connectors/mirakl/inbox-channel.ts";
import { startFakeEbay, startFakeKaufland, startFakeMirakl, type FakeEbay, type FakeKaufland, type FakeMirakl } from "../../packages/testing/fake-marketplaces.ts";

const KFL = { clientKey: "client-key-test", secretKey: "secret-key-test" };

describe("Kaufland signing", () => {
  it("builds the documented signature base and a hex HMAC", () => {
    const base = kauflandSignatureBase({ method: "post", url: "https://sellerapi.kaufland.com/v2/tickets/1/messages", body: '{"text":"x"}', timestamp: 1700000000 });
    assert.equal(base, 'POST\nhttps://sellerapi.kaufland.com/v2/tickets/1/messages\n{"text":"x"}\n1700000000');
    const sig = signKauflandRequest({ method: "GET", url: "https://sellerapi.kaufland.com/v2/tickets", body: "", timestamp: 1, secretKey: "k" });
    assert.match(sig, /^[0-9a-f]{64}$/);
  });
});

describe("Kaufland tickets channel (contract against test double)", () => {
  let fake: FakeKaufland;
  const channel = (extra: Partial<ConstructorParameters<typeof KauflandTicketsChannel>[0]> = {}) =>
    new KauflandTicketsChannel({ ...KFL, baseUrl: fake.baseUrl, allowTestEndpoints: true, timeoutMs: 200, ...extra });
  before(async () => {
    fake = await startFakeKaufland({ ...KFL, hangMs: 400 });
    fake.addTicket({ id_ticket: "T1", id_order: "M3KX7Q2", buyer: { firstname: "Erika", lastname: "Muster", email: "Buyer@Relay.Example" } });
    fake.addTicket({ id_ticket: "T2", id_order: "M9ZZ001", storefront: "cz", buyer: { firstname: "Jan", lastname: "Novak" } });
    fake.addMessage("T1", "buyer", "Wo bleibt mein Paket?", new Date(Date.now() - 3_600_000));
    fake.addMessage("T2", "buyer", "Dotaz", new Date(Date.now() - 1_800_000));
  });
  after(() => fake.close());

  it("rejects requests with a wrong secret (signature checked by the double)", async () => {
    const result = await channel({ secretKey: "wrong" }).checkAccess();
    assert.equal(result.ok, false);
  });

  it("maps ticket messages with order reference, buyer and thread key", async () => {
    const result = await channel().sync({});
    const m = result.messages.find((x) => x.externalThreadKey === "kaufland:ticket:T1")!;
    assert.equal(m.direction, "inbound");
    assert.equal(m.from.address, "buyer@relay.example");
    assert.equal(m.from.name, "Erika Muster");
    assert.match(m.subject, /Bestellung M3KX7Q2/);
    assert.ok(m.aliasKeys.includes("kaufland:ticket:T1"));
    assert.ok(result.cursors.messages);
    assert.ok(fake.requests.every((r) => r.startsWith("GET ")), "sync only reads");
  });

  it("pages with at most 30 messages per request (Kaufland: \"limit: max 30\")", async () => {
    const many = await startFakeKaufland(KFL);
    try {
      many.addTicket({ id_ticket: "T9", id_order: "M1000001", buyer: { firstname: "Viel", lastname: "Schreiber" } });
      for (let i = 0; i < 65; i++) many.addMessage("T9", "buyer", `Nachricht ${i}`, new Date(Date.now() - (i + 1) * 60_000));
      const result = await new KauflandTicketsChannel({ ...KFL, baseUrl: many.baseUrl, allowTestEndpoints: true }).sync({});
      assert.equal(result.messages.length, 65);
      const pages = many.requests.filter((r) => r.startsWith("GET /v2/tickets/messages") || r.includes("/tickets/messages?"));
      assert.equal(pages.length, 3);
      assert.ok(pages.every((r) => Number(new URL(`http://x${r.slice(4)}`).searchParams.get("limit")) <= 30));
    } finally {
      await many.close();
    }
  });

  it("filters by storefront on the ticket", async () => {
    const result = await channel({ storefronts: ["de"] }).sync({});
    assert.ok(result.messages.every((m) => m.externalThreadKey !== "kaufland:ticket:T2"));
  });

  it("answers in the ticket as a normal (not interim) message and reconciles by text", async () => {
    const since = new Date();
    const out = await channel().sendReply({ inReplyToExternalId: "1000", externalThreadKey: "kaufland:ticket:T1", bodyText: "Hallo Frau Muster,\n\nIhr Paket ist unterwegs.", outboxMarker: "ob-1" });
    assert.equal(out.state, "provider_accepted");
    assert.equal(fake.posted.at(-1)!.interim_notice, false);
    const found = await channel().reconcileReply("ob-1", since, "kaufland:ticket:T1", "Hallo Frau Muster,\r\nIhr Paket ist unterwegs.  ");
    assert.equal(found.state, "found");
    const missing = await channel().reconcileReply("ob-1", since, "kaufland:ticket:T1", "anderer Text");
    assert.equal(missing.state, "not_found");
  });

  it("reports an ambiguous timeout as uncertain and a 400 as rejected", async () => {
    fake.setSendFault("timeout_after_send");
    const timeout = await channel().sendReply({ inReplyToExternalId: "1000", externalThreadKey: "kaufland:ticket:T1", bodyText: "x", outboxMarker: "ob-2" });
    assert.equal(timeout.state, "uncertain");
    fake.setSendFault("reject_400");
    const rejected = await channel().sendReply({ inReplyToExternalId: "1000", externalThreadKey: "kaufland:ticket:T1", bodyText: "x", outboxMarker: "ob-3" });
    assert.equal(rejected.state, "rejected");
    fake.setSendFault("none");
  });

  it("refuses a thread key of another channel", async () => {
    const out = await channel().sendReply({ inReplyToExternalId: "1", externalThreadKey: "ebay:conversation:1", bodyText: "x", outboxMarker: "ob" });
    assert.equal(out.state, "rejected");
  });

  it("only accepts the official API host for live connections", () => {
    assert.throws(() => new KauflandTicketsChannel({ ...KFL, baseUrl: "https://evil.example/v2" }), /Nicht erlaubter Endpunkt/);
    assert.doesNotThrow(() => new KauflandTicketsChannel(KFL));
  });
});

describe("eBay OAuth and message channel (contract against test double)", () => {
  let fake: FakeEbay;
  const app = () => ({ clientId: "app-id", clientSecret: "cert-id", ruName: "Shop-RuName", authBaseUrl: fake.baseUrl, apiBaseUrl: fake.baseUrl, identityBaseUrl: fake.baseUrl });
  const channel = () => new EbayMessageChannel({ ...app(), refreshToken: "refresh-1", grantedScopes: [...EBAY_MESSAGE_SCOPES], sellerUsername: "demo_shop", allowTestEndpoints: true, timeoutMs: 200 });
  before(async () => {
    fake = await startFakeEbay({ clientId: "app-id", clientSecret: "cert-id", seller: "demo_shop", authCode: "code-1", refreshToken: "refresh-1", hangMs: 400 });
    fake.addConversation({ id: "C1", title: "Frage zu Artikel 1234", buyer: "kunde_1", text: "Ist das Öl kaltgepresst?", referenceId: "1234", at: new Date(Date.now() - 600_000) });
    fake.addConversation({ id: "E1", title: "eBay-Hinweis", buyer: "ebay", text: "Systemnachricht", type: "FROM_EBAY" });
  });
  after(() => fake.close());

  it("builds a consent URL with prompt=login and only the message scopes", () => {
    const url = new URL(buildEbayAuthorizeUrl({ ...app(), authBaseUrl: undefined }, "state-1"));
    assert.equal(url.origin, "https://auth.ebay.com");
    assert.equal(url.searchParams.get("prompt"), "login");
    assert.equal(url.searchParams.get("redirect_uri"), "Shop-RuName");
    assert.deepEqual(url.searchParams.get("scope")!.split(" "), [...EBAY_MESSAGE_SCOPES]);
  });

  it("exchanges the code and reads the seller username", async () => {
    const tokens = await exchangeEbayCode(app(), "code-1");
    assert.equal(tokens.refreshToken, "refresh-1");
    assert.equal(await fetchEbayUsername(app(), tokens.accessToken), "demo_shop");
  });

  it("reads member conversations only and tells seller from buyer", async () => {
    const result = await channel().sync({});
    assert.equal(result.messages.length, 1);
    const m = result.messages[0]!;
    assert.equal(m.externalThreadKey, "ebay:conversation:C1");
    assert.equal(m.direction, "inbound");
    assert.equal(m.from.address, "ebay:kunde_1");
    assert.equal(m.headers["x-ebay-reference"], "LISTING:1234");
    // The refresh asks for exactly the granted scopes.
    const refresh = fake.tokenRequests.find((f) => f.get("grant_type") === "refresh_token")!;
    assert.deepEqual(refresh.get("scope")!.split(" "), [...EBAY_MESSAGE_SCOPES]);
  });

  it("replies inside the conversation and reconciles our own message", async () => {
    const since = new Date();
    const out = await channel().sendReply({ inReplyToExternalId: "m1", externalThreadKey: "ebay:conversation:C1", bodyText: "Ja, kaltgepresst.", outboxMarker: "ob" });
    assert.equal(out.state, "provider_accepted");
    assert.ok(out.state === "provider_accepted" && out.externalMessageId);
    assert.deepEqual(fake.sent.at(-1), { conversationId: "C1", messageText: "Ja, kaltgepresst." });
    assert.equal((await channel().reconcileReply("ob", since, "ebay:conversation:C1", "Ja, kaltgepresst.")).state, "found");
    const again = await channel().sync({});
    assert.equal(again.messages.find((m) => m.bodyText === "Ja, kaltgepresst.")!.direction, "outbound");
  });

  it("refuses files instead of sending the text without them", async () => {
    const before = fake.sent.length;
    const out = await channel().sendReply({ inReplyToExternalId: "m1", externalThreadKey: "ebay:conversation:C1", bodyText: "Anbei.", outboxMarker: "ob", attachments: [{ name: "a.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-") }] });
    assert.equal(out.state, "rejected");
    assert.equal(fake.sent.length, before);
  });

  it("refuses to start without consent", () => {
    assert.throws(() => new EbayMessageChannel({ ...app(), refreshToken: "", grantedScopes: [], sellerUsername: "", allowTestEndpoints: true }), /nicht verbunden/);
  });
});

describe("Mirakl inbox channel (contract against test double)", () => {
  let fake: FakeMirakl;
  const channel = () => new MiraklInboxChannel({ baseUrl: fake.baseUrl, apiKey: "mirakl-key", allowTestEndpoints: true, timeoutMs: 200 });
  before(async () => {
    fake = await startFakeMirakl({ apiKey: "mirakl-key", hangMs: 400 });
    fake.addThread({ id: "th-1", topic: "Lieferung", orderId: "SA-100234-A", customerId: "c-77", customerName: "Max Kunde", text: "Wann kommt meine Bestellung?", at: new Date(Date.now() - 600_000) });
    fake.addThread({ id: "th-2", topic: "Rückfrage Betreiber", orderId: "SA-100235-A", customerId: "c-78", customerName: "Operator", text: "Bitte Tracking nachreichen.", from: "OPERATOR_USER", at: new Date(Date.now() - 300_000) });
  });
  after(() => fake.close());

  it("maps threads with order entity and participants", async () => {
    const result = await channel().sync({});
    const m = result.messages.find((x) => x.externalThreadKey === "mirakl:thread:th-1")!;
    assert.equal(m.direction, "inbound");
    assert.equal(m.from.address, "mirakl:customer:c-77");
    assert.match(m.subject, /Bestellung SA-100234-A/);
    assert.ok(result.cursors.threads);
  });

  it("answers the customer with the participant id from the thread", async () => {
    const msgId = fake.threads[0]!.messages[0]!.id;
    const out = await channel().sendReply({ inReplyToExternalId: msgId, externalThreadKey: "mirakl:thread:th-1", bodyText: "Morgen.", outboxMarker: "ob" });
    assert.equal(out.state, "provider_accepted");
    assert.deepEqual(fake.replies.at(-1)!.to, [{ type: "CUSTOMER", id: "c-77" }]);
  });

  it("sends approved PDFs as multipart files", async () => {
    const msgId = fake.threads[0]!.messages[0]!.id;
    const out = await channel().sendReply({ inReplyToExternalId: msgId, externalThreadKey: "mirakl:thread:th-1", bodyText: "Anleitung anbei.", outboxMarker: "ob", attachments: [{ name: "Retouren.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 x") }] });
    assert.equal(out.state, "provider_accepted");
    assert.deepEqual(fake.replies.at(-1)!.files, [{ name: "Retouren.pdf", type: "application/pdf", size: 10 }]);
  });

  it("answers an operator message to the operator, never to the customer", async () => {
    const msgId = fake.threads[1]!.messages[0]!.id;
    await channel().sendReply({ inReplyToExternalId: msgId, externalThreadKey: "mirakl:thread:th-2", bodyText: "Tracking folgt.", outboxMarker: "ob" });
    assert.deepEqual(fake.replies.at(-1)!.to, [{ type: "OPERATOR" }]);
  });

  it("rejects when the answered message is unknown", async () => {
    const out = await channel().sendReply({ inReplyToExternalId: "nope", externalThreadKey: "mirakl:thread:th-1", bodyText: "x", outboxMarker: "ob" });
    assert.equal(out.state, "rejected");
  });

  it("only accepts *.mirakl.net instances for live connections", () => {
    assert.throws(() => new MiraklInboxChannel({ baseUrl: "https://example.com", apiKey: "k" }), /Nicht erlaubter Endpunkt/);
    assert.doesNotThrow(() => new MiraklInboxChannel({ baseUrl: "https://betreiber.mirakl.net", apiKey: "k" }));
  });
});

describe("text matching for marketplace echoes", () => {
  it("ignores whitespace and line-ending differences only", () => {
    assert.ok(sameText("A\r\n\r\nB  c", "A\nB c"));
    assert.ok(!sameText("A B", "A C"));
  });
});

describe("provider error text", () => {
  it("names the fields of a validation error, not just 'Validation Failed'", async () => {
    const { requestJson, HttpError } = await import("../../packages/connectors/http.ts");
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "Validation Failed", errors: [{ property: "embedded", message: "This value should be of type array." }] }), { status: 400 })) as typeof fetch;
    await assert.rejects(requestJson(new URL("https://sellerapi.kaufland.com/v2/tickets/1"), { method: "GET", headers: {}, timeoutMs: 1000, fetchImpl }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.match(error.message, /Validation Failed: embedded: This value should be of type array\./);
      return true;
    });
  });
});
