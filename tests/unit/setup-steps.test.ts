import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSetup, microsoftSetup, weclappSetup, type SetupInput } from "../../apps/web/src/setup-steps.ts";

const empty: SetupInput = { connections: [], accounts: [], rules: [], routes: [], erp: null };
const conn = (id: string, kind: string, extra: Partial<SetupInput["connections"][number]> = {}) =>
  ({ id, kind, health: "ok", paused: false, last_error: null, default_source_platform: "email", config: {}, ...extra });

test("nothing set up: every card starts with its first step, none is connected", () => {
  for (const m of ["kaufland", "ebay", "shop_apotheke"] as const) {
    const s = marketSetup(m, empty);
    assert.equal(s.connected, false);
    assert.equal(s.next?.key, "connect");
  }
  const amazon = marketSetup("amazon", empty);
  assert.equal(amazon.steps[0]!.external, true);
  assert.equal(amazon.next?.key, "external", "the step at the marketplace comes first");
  assert.equal(amazon.next?.action, "confirm");
  assert.equal(microsoftSetup(empty).next?.key, "connect");
  assert.equal(weclappSetup(empty).next?.key, "erp");
});

test("API market: done once its own connection is healthy; eBay needs the seller login first", () => {
  const unchecked = marketSetup("kaufland", { ...empty, connections: [conn("k1", "kaufland_tickets", { health: "unknown" })] });
  assert.equal(unchecked.connected, false);
  assert.equal(unchecked.next?.key, "check");
  const ok = marketSetup("kaufland", { ...empty, connections: [conn("k1", "kaufland_tickets")] });
  assert.equal(ok.connected, true);
  assert.equal(ok.next, null, "nothing left to do: no reply-route or seller-account step");
  assert.deepEqual(ok.steps.map((st) => st.key), ["connect", "check"]);

  const ebay = marketSetup("ebay", { ...empty, connections: [conn("e1", "ebay_messages", { health: "unknown" })] });
  assert.equal(ebay.next?.key, "ebay_login");
  const paused = marketSetup("ebay", { ...empty, connections: [conn("e1", "ebay_messages", { paused: true, config: { sellerUsername: "x" } })] });
  assert.equal(paused.connected, false, "a paused connection does not count");
});

test("a connection of another market never counts", () => {
  const input: SetupInput = { ...empty, connections: [conn("k1", "kaufland_tickets"), conn("g1", "microsoft_graph")] };
  assert.equal(marketSetup("ebay", input).connected, false);
  assert.equal(marketSetup("kaufland", input).connected, true);
});

test("mail market: done once the marketplace step is ticked off and the mailbox is healthy, no rule needed", () => {
  const graph = conn("g1", "microsoft_graph");
  const ticked = { amazon: { at: "2026-10-26T21:00:00Z", by: "Alex" }, docmorris: { at: "2026-10-23T09:00:00Z", by: null } };
  const unticked = marketSetup("shopify", { ...empty, connections: [graph] });
  assert.equal(unticked.connected, false, "mail not yet set up at Shopify");
  assert.equal(unticked.next?.key, "external");
  const amazon = marketSetup("amazon", { ...empty, connections: [graph], confirmations: ticked });
  assert.equal(amazon.connected, true);
  assert.equal(amazon.next, null);
  assert.deepEqual(amazon.steps.map((st) => st.key), ["external", "mailbox"]);
  const ext = amazon.steps[0]!;
  assert.equal(ext.action, "unconfirm");
  assert.match(ext.hint!, /Alex am 26\.10\.2026/);
  assert.equal(marketSetup("docmorris", { ...empty, connections: [graph], confirmations: ticked }).connected, true);
  const broken = marketSetup("docmorris", { ...empty, connections: [{ ...graph, health: "error" }], confirmations: ticked });
  assert.equal(broken.connected, false);
  assert.equal(broken.next?.key, "mailbox");
});

test("errors surface on the card; weclapp is connected only after a successful check", () => {
  const k = marketSetup("kaufland", { ...empty, connections: [conn("k1", "kaufland_tickets", { health: "error", last_error: "401" })] });
  assert.equal(k.error, "401");
  assert.equal(weclappSetup({ ...empty, erp: { has_secret: true, status: "unchecked", last_error: null } }).connected, false);
  assert.equal(weclappSetup({ ...empty, erp: { has_secret: true, status: "ok", last_error: null } }).connected, true);
});

test("steps that need a connection offer no button until it exists", () => {
  const k = marketSetup("kaufland", empty);
  assert.equal(k.steps.find((s) => s.key === "check")!.action, undefined);
});

test("sending: offered once connected, on only with the platform's route and sending enabled on that connection", () => {
  assert.equal(marketSetup("kaufland", empty).sending, null);
  const k = conn("k1", "kaufland_tickets", { send_enabled: true });
  assert.deepEqual(marketSetup("kaufland", { ...empty, connections: [k] }).sending, { connectionId: "k1", on: false });
  assert.deepEqual(marketSetup("kaufland", { ...empty, connections: [k], routes: [{ connection_id: "k1", source_platform: "kaufland" }] }).sending, { connectionId: "k1", on: true });
  const g = conn("g1", "microsoft_graph", { send_enabled: true });
  const ticked = { amazon: { at: "2026-10-27T09:00:00Z", by: null } };
  const routes = [{ connection_id: "g1", source_platform: "amazon" }];
  assert.equal(marketSetup("amazon", { ...empty, connections: [g], routes }).sending, null, "not before the marketplace step is ticked off");
  assert.deepEqual(marketSetup("amazon", { ...empty, connections: [g], routes, confirmations: ticked }).sending, { connectionId: "g1", on: true });
  assert.equal(marketSetup("docmorris", { ...empty, connections: [g], routes, confirmations: { docmorris: ticked.amazon } }).sending!.on, false, "the Amazon route does not open DocMorris");
});

test("eBay with the installation's keyset: no keys to enter, the login is the first step and works without a connection", () => {
  const fresh = marketSetup("ebay", { ...empty, ebayOperatorApp: true });
  assert.deepEqual(fresh.steps.map((st) => st.key), ["ebay_login", "check"]);
  assert.equal(fresh.next?.action, "ebay_login");
  assert.equal(fresh.steps[1]!.action, undefined, "nothing to test before the login");
  const loggedIn = marketSetup("ebay", { ...empty, ebayOperatorApp: true, connections: [conn("e1", "ebay_messages", { config: { sellerUsername: "shop" } })] });
  assert.equal(loggedIn.connected, true);
  assert.equal(loggedIn.next, null);
});
