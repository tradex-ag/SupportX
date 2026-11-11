import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, describe, it } from "node:test";
import { DEMO } from "../../packages/testing/demo-data.ts";
import { getCase } from "../../packages/services/cases.ts";
import { setSendEnabled } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { forwardMessage, getForwardInfo, resolveForward } from "../../packages/services/forwards.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, currentDraft, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const PDF = Buffer.from("%PDF-1.4 Lieferschein").toString("base64");
const code = (c: string) => (e: ServiceError) => e.code === c;
const firstMessage = async (conversationId: string) => (await one<{ id: string }>(h!.ctx.db, "SELECT id FROM messages WHERE conversation_id = $1 ORDER BY received_at LIMIT 1", [conversationId]))!.id;

describe("forward a mail from a case", () => {
  it("forwards the original once, logs it in the case and does not treat the sent copy as a manual reply", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    h.graph.addInbound({
      from: "kunde@example.invalid", subject: "Ware beschädigt, Bestellung 4711", body: "Die Lieferung kam kaputt an.", conversationId: "fw-plain",
      attachments: [{ id: "a1", name: "lieferschein.pdf", contentType: "application/pdf", contentBytes: PDF }],
    });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "fw-plain");
    const messageId = await firstMessage(conv.id);

    // Not yet allowed: sending is off for the connection.
    assert.match((await getForwardInfo(h.ctx, s.agent, messageId)).blockers.join(" "), /nicht aktiviert/);
    await assert.rejects(forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: "lager@lieferant.example" }), code("SEND_BLOCKED"));
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);

    const info = await getForwardInfo(h.ctx, s.agent, messageId);
    assert.equal(info.mode, "original");
    assert.equal(info.subject, "Fwd: Ware beschädigt, Bestellung 4711");
    assert.deepEqual(info.blockers, []);

    await assert.rejects(getForwardInfo(h.ctx, s.viewer, messageId), (e: ServiceError) => e.status === 403);
    await assert.rejects(forwardMessage(h.ctx, other.owner, messageId, { forwardId: randomUUID(), to: "x@y.example" }), code("NOT_FOUND"), "another workspace cannot forward the mail");
    await assert.rejects(forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: "kein-at" }), code("INVALID_RECIPIENT"));

    const draftBefore = await currentDraft(h, s, conv.id);
    const forwardId = randomUUID();
    const result = await forwardMessage(h.ctx, s.agent, messageId, { forwardId, to: "Lager@Lieferant.example, chef@firma.example", comment: "Bitte prüfen." });
    assert.equal(result.state, "sent");
    assert.equal(h.graph.forwards.length, 1);
    const sent = h.graph.forwards[0]!;
    assert.equal(sent.kind, "forward");
    assert.deepEqual(sent.to, ["lager@lieferant.example", "chef@firma.example"]);
    assert.ok(sent.headers.some((x) => x.value === forwardId), "the marker header travels with the forward");
    assert.deepEqual(sent.attachments.map((a) => a.name), ["lieferschein.pdf"], "the original attachment goes with the forward");

    // A double click with the same dialog id does not send twice.
    assert.equal((await forwardMessage(h.ctx, s.agent, messageId, { forwardId, to: "lager@lieferant.example" })).state, "sent");
    assert.equal(h.graph.forwards.length, 1);

    // The copy in Sent Items confirms the forward; the case and its draft stay as they are.
    await syncAndDrain(h, s);
    const after = await caseByThread(h, s, "fw-plain");
    assert.equal(after.version, conv.version, "a forward is no new message in the case");
    assert.equal((await currentDraft(h, s, conv.id))?.id, draftBefore?.id, "the draft is not superseded");
    const data = await getCase(h.ctx, s.agent, conv.id);
    assert.equal(data.messages.length, 1, "the forwarded copy is not shown as our reply");
    const logged = data.forwards as Array<{ state: string; recipients: string[]; comment: string }>;
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.state, "confirmed");
    assert.equal(logged[0]!.comment, "Bitte prüfen.");

    assert.deepEqual((await getForwardInfo(h.ctx, s.agent, messageId)).suggestions.sort(), ["chef@firma.example", "lager@lieferant.example"]);
  });

  it("forwards a marketplace relay mail as text without any address", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    const relay = `kunde-q1@${DEMO.amazonRelayDomain}`;
    h.graph.addInbound({
      from: relay, subject: "Frage zur Bestellung 302-0000000-0000000", body: `Die Dose ist falsch. Antworten an ${relay}`, conversationId: "fw-relay",
      attachments: [{ id: "p1", name: "foto.pdf", contentType: "application/pdf", contentBytes: PDF }],
    });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "fw-relay");
    const messageId = await firstMessage(conv.id);
    const info = await getForwardInfo(h.ctx, s.agent, messageId);
    assert.equal(info.mode, "text");
    assert.match(info.notice, /Relay-Adresse/);

    const result = await forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: ["einkauf@lieferant.example"] });
    assert.equal(result.state, "sent");
    const sent = h.graph.forwards[0]!;
    assert.equal(sent.kind, "sendMail", "a new mail, not the original with the relay sender");
    assert.equal(sent.subject, "Fwd: Frage zur Bestellung 302-0000000-0000000");
    assert.doesNotMatch(sent.body, new RegExp(DEMO.amazonRelayDomain.replace(/\./g, "\\.")));
    assert.match(sent.body, /Die Dose ist falsch/);
    assert.deepEqual(sent.attachments.map((a) => a.name), ["foto.pdf"]);
  });

  it("keeps an unclear forward from being sent again until it is cleared", async () => {
    h = await createHarness({ sendMode: "enabled", graphTimeoutMs: 150 });
    const s = await seedWorkspace(h);
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    h.graph.addInbound({ from: "kunde@example.invalid", subject: "Rückfrage", body: "Bitte an den Lieferanten.", conversationId: "fw-timeout" });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "fw-timeout");
    const messageId = await firstMessage(conv.id);

    h.graph.setReplyFault("timeout_after_send");
    const first = await forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: "lager@lieferant.example" });
    assert.equal(first.state, "uncertain");
    await assert.rejects(forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: "lager@lieferant.example" }), code("FORWARD_UNCLEAR"));
    assert.equal((await resolveForward(h.ctx, s.agent, first.id, "check")).state, "confirmed", "found in Sent Items by its marker");

    // A rejected forward is recorded as failed and may be tried again.
    h.graph.setReplyFault("reject_403");
    const rejected = await forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: "buero@firma.example" });
    assert.equal(rejected.state, "failed");
    assert.match(rejected.error ?? "", /Senderecht/);
    assert.equal((await forwardMessage(h.ctx, s.agent, messageId, { forwardId: randomUUID(), to: "buero@firma.example" })).state, "sent");
  });
});
