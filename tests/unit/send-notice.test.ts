import { test } from "node:test";
import assert from "node:assert/strict";
import { sendNotice } from "../../apps/web/src/send-notice.ts";

const queued = "Auf die letzte Kundennachricht gibt es bereits einen Versandauftrag (Status: planned).";

test("a reply that is already queued shows a neutral status, not a lock", () => {
  const n = sendNotice({ allowed: false, blockers: [queued], pending: { state: "planned", text: queued }, setupMissing: false });
  assert.deepEqual(n.blocked, []);
  assert.equal(n.setupHint, false);
  assert.equal(n.status?.text, "Antwort ist eingeplant und wird gleich gesendet.");
});

test("a sent reply says so", () => {
  const text = queued.replace("planned", "confirmed");
  const n = sendNotice({ allowed: false, blockers: [text], pending: { state: "confirmed", text }, setupMissing: false });
  assert.deepEqual(n.blocked, []);
  assert.equal(n.status?.tone, "ok");
});

test("the marketplace hint appears only when the card is the reason", () => {
  const mode = "Versand ist für diese Installation deaktiviert (SEND_MODE=drafts_only). Es werden nur Entwürfe erstellt.";
  assert.equal(sendNotice({ allowed: false, blockers: [mode], pending: null, setupMissing: false }).setupHint, false);
  const off = "Versand ist für die Verbindung „Postfach Test“ nicht aktiviert.";
  const n = sendNotice({ allowed: false, blockers: [off], pending: null, setupMissing: true });
  assert.deepEqual(n.blocked, [off]);
  assert.equal(n.setupHint, true);
});

test("a real lock next to a queued reply still shows, without the queued line", () => {
  const paused = "Die Verbindung ist pausiert.";
  const n = sendNotice({ allowed: false, blockers: [paused, queued], pending: { state: "planned", text: queued }, setupMissing: false });
  assert.deepEqual(n.blocked, [paused]);
  assert.ok(n.status);
});

test("nothing to say when sending is allowed", () => {
  const n = sendNotice({ allowed: true, blockers: [], pending: null, setupMissing: false });
  assert.deepEqual(n, { blocked: [], setupHint: false, status: null });
});
