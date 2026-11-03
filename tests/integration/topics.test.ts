import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { autoParcelStatus, setAutomation, setCaseTopic, sortUnsortedCases } from "../../packages/services/automation.ts";
import { getCase, listCases } from "../../packages/services/cases.ts";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { DEMO } from "../../packages/testing/demo-data.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: ServiceError) => e.code === code);
const topicOf = async (id: string) => one<{ topic: string | null; topic_source: string | null }>(h!.ctx.db, "SELECT topic, topic_source FROM conversations WHERE id = $1", [id]);

describe("Anliegen sortieren", () => {
  it("sorts every case on arrival, filters the list and keeps a topic a person chose", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const wismo = await caseByThread(h, s, "conv-amazon-wismo");
    assert.equal((await topicOf(wismo.id))!.topic, "parcel_status");
    const parcel = await listCases(h.ctx, s.agent, "all", undefined, "parcel_status");
    assert.ok(parcel.some((c) => c.id === wismo.id));
    assert.ok(parcel.every((c) => (c as { topic?: string }).topic === "parcel_status"));

    await setCaseTopic(h.ctx, s.agent, wismo.id, "return_request");
    assert.deepEqual(await topicOf(wismo.id), { topic: "return_request", topic_source: "person" });
    await rejectsWith(setCaseTopic(h.ctx, s.agent, wismo.id, "nonsense"), "INVALID");
    await setCaseTopic(h.ctx, s.agent, wismo.id, null);
    assert.deepEqual(await topicOf(wismo.id), { topic: "parcel_status", topic_source: "auto" });
  });
});

describe("Paketstatus automatisch", () => {
  const ask = (h: Harness, body: string, key: string) =>
    h.graph.addInbound({ from: `kunde-${key}@${DEMO.amazonRelayDomain}`, fromName: "Kundin", subject: "Bestellung 302-1234567-7654321", body, conversationId: `conv-${key}`, receivedAt: new Date() });

  async function setup(mode: "draft" | "send", allTracked = true) {
    h = await createHarness({ sendMode: "enabled" });
    if (allTracked) {
      const sh2 = h.weclapp.data.shipment.find((x) => x.id === "sh-2")!;
      Object.assign(sh2, { status: "SHIPPED", parcels: [{ id: "pc-9", trackingId: "DEMO00077777", trackingUrl: "https://tracking.demo.invalid/DEMO00077777" }] });
    }
    const s = await seedWorkspace(h);
    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort kam im Käuferpostfach an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    await setAutomation(h.ctx, s.owner, { topic: "parcel_status", mode });
    return { h, s };
  }

  it("sends the tracking links from a fixed template when every shipment has one", async () => {
    const { h, s } = await setup("send");
    ask(h, "Hallo, wann kommt meine Bestellung 302-1234567-7654321 an? Wo ist mein Paket?", "p1");
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-p1");
    assert.ok(await one(h.ctx.db, "SELECT 1 FROM outbox WHERE conversation_id = $1", [conv.id]), "queued");
    const draft = await one<{ generated_by: string; body: string }>(h.ctx.db, "SELECT generated_by, body FROM drafts WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1", [conv.id]);
    assert.equal(draft!.generated_by, "rules", "no AI cost");
    assert.match(draft!.body, /DEMO00077777/);
    const view = await getCase(h.ctx, s.agent, conv.id);
    assert.match(String(view.approvals[0]?.approved_by), /automatisch \(parcel-v1\)/);
  });

  it("only prepares when a shipment has no tracking link or the message is sensitive, and says why", async () => {
    const { h, s } = await setup("send", false);
    ask(h, "Wo ist mein Paket zur Bestellung 302-1234567-7654321?", "p2");
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-p2");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM outbox WHERE conversation_id = $1", [conv.id]), null);
    assert.ok(await currentDraft(h, s, conv.id));
    const row = await one<{ last_error: string }>(h.ctx.db, "SELECT last_error FROM conversations WHERE id = $1", [conv.id]);
    assert.match(row!.last_error, /nicht automatisch gesendet: nicht jede Lieferung hat einen Trackinglink/);
  });

  it("in 'draft' mode prepares without sending; other topics and old mail are left alone", async () => {
    const { h, s } = await setup("draft");
    ask(h, "Wann kommt meine Bestellung 302-1234567-7654321 an?", "p3");
    ask(h, "Der Artikel aus 302-1234567-7654321 ist beschädigt angekommen.", "p4");
    await syncAndDrain(h, s);
    const prepared = await caseByThread(h, s, "conv-p3");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM outbox WHERE conversation_id = $1", [prepared.id]), null);
    assert.ok(await one(h.ctx.db, "SELECT 1 FROM audit_events WHERE action = 'draft.auto_topic' AND workspace_id = $1", [s.workspaceId]));
    const other = await caseByThread(h, s, "conv-p4");
    assert.equal(await autoParcelStatus(h.ctx, s.workspaceId, other.id), "skipped");
  });

  it("is off by default, owner only, and ignores messages from before it was switched on", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    ask(h, "Wann kommt meine Bestellung 302-1234567-7654321 an?", "p5");
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-p5");
    assert.equal(await autoParcelStatus(h.ctx, s.workspaceId, conv.id), "off");
    await rejectsWith(setAutomation(h.ctx, s.agent, { topic: "parcel_status", mode: "send" }), "FORBIDDEN");
    await rejectsWith(setAutomation(h.ctx, s.owner, { topic: "invoice", mode: "send" }), "INVALID");
    await h.ctx.db.query("DELETE FROM drafts WHERE conversation_id = $1", [conv.id]);
    await setAutomation(h.ctx, s.owner, { topic: "parcel_status", mode: "draft" });
    assert.equal(await autoParcelStatus(h.ctx, s.workspaceId, conv.id), "skipped");
  });
});

describe("Altbestand sortieren", () => {
  it("sorts support cases without a topic in the worker tick", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const wismo = await caseByThread(h, s, "conv-amazon-wismo");
    await h.ctx.db.query("UPDATE conversations SET topic = NULL, topic_source = NULL WHERE workspace_id = $1", [s.workspaceId]);
    assert.ok((await sortUnsortedCases(h.ctx)) > 0);
    assert.deepEqual(await topicOf(wismo.id), { topic: "parcel_status", topic_source: "auto" });
    assert.equal(await sortUnsortedCases(h.ctx), 0);
  });
});
