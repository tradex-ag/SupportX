import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { sendMany, batchCandidates } from "../../packages/services/batch.ts";
import { caseCounts, getCase, setOutcome, updateWorkspaceSettings } from "../../packages/services/cases.ts";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { evidencePdf } from "../../packages/services/evidence.ts";
import { supportReport } from "../../packages/services/reports.ts";
import { DEMO } from "../../packages/testing/demo-data.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);
const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: ServiceError) => e.code === code);

async function demo(sendMode: "drafts_only" | "enabled" = "drafts_only") {
  h = await createHarness({ sendMode });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  return { h, s };
}

describe("Kundenhistorie", () => {
  it("lists earlier cases of the same address or weclapp customer with what was done", async () => {
    const { h, s } = await demo();
    const first = await caseByThread(h, s, "conv-amazon-wismo");
    await setOutcome(h.ctx, s.agent, first.id, { outcome: "refund" });
    // Another buyer address, same order (so the same weclapp customer).
    h.graph.addInbound({ from: `andere-adresse@${DEMO.amazonRelayDomain}`, fromName: "Erika", subject: "Nochmal zu 302-1234567-7654321", body: "Wann kommt das Teesieb?", conversationId: "conv-hist2", receivedAt: new Date() });
    await syncAndDrain(h, s);
    const second = await caseByThread(h, s, "conv-hist2");
    const view = await getCase(h.ctx, s.agent, second.id);
    const history = view.customerHistory;
    assert.ok(history.cases.some((c) => c.id === first.id && c.outcome === "refund" && c.order_number === "302-1234567-7654321"));
    assert.equal(history.counts.refunds, 1);
    assert.ok(!history.cases.some((c) => c.id === second.id), "not the case itself");
  });
});

describe("Mehrere Antworten freigeben", () => {
  it("shows the text of each draft, offers only drafts without hints, and binds to the version shown", async () => {
    const { h, s } = await demo("enabled");
    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "shopify", evidenceNote: "Test kam an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    const ids = [];
    for (const key of ["conv-shopify-delivered", "conv-docmorris-damaged", "conv-amazon-wismo"]) ids.push((await caseByThread(h, s, key)).id);
    const items = await batchCandidates(h.ctx, s.agent, ids);
    assert.equal(items.length, 3);
    for (const i of items) assert.ok(i.body, "the person reads the text");
    const ready = items.filter((i) => i.ready);
    const notReady = items.filter((i) => !i.ready);
    assert.ok(notReady.every((i) => i.reasons.length > 0));
    await rejectsWith(batchCandidates(h.ctx, s.viewer, ids), "FORBIDDEN");

    const results = await sendMany(h.ctx, s.agent, [
      ...ready.map((i) => ({ draftId: i.draftId!, expectedVersion: i.version! })),
      ...notReady.filter((i) => i.draftId).map((i) => ({ draftId: i.draftId!, expectedVersion: i.version! })),
    ]);
    for (const i of ready) assert.ok(results.find((r) => r.draftId === i.draftId)?.ok, JSON.stringify(results));
    for (const i of notReady.filter((x) => x.draftId)) {
      assert.equal(results.find((r) => r.draftId === i.draftId)?.ok, false, "not offered, not sent in bulk");
      assert.equal(await one(h.ctx.db, "SELECT 1 FROM approvals WHERE draft_id = $1", [i.draftId]), null, "no approval left behind");
    }
    if (ready[0]) {
      assert.ok(await one(h.ctx.db, "SELECT 1 FROM outbox WHERE conversation_id = $1", [ready[0].conversationId]));
      const again = await sendMany(h.ctx, s.agent, [{ draftId: ready[0].draftId!, expectedVersion: ready[0].version! }]);
      assert.equal(again[0]!.ok, false);
    }
  });
});

describe("Auswertung", () => {
  it("counts topics, platforms, outcomes, first replies and problems per article", async () => {
    const { h, s } = await demo();
    const damaged = await caseByThread(h, s, "conv-docmorris-damaged");
    await setOutcome(h.ctx, s.agent, damaged.id, { outcome: "replacement" });
    const r = await supportReport(h.ctx, s.viewer, 30);
    assert.ok(r.cases >= 5);
    assert.ok((r.byTopic.parcel_status ?? 0) >= 1);
    assert.ok((r.byPlatform.amazon ?? 0) >= 1);
    assert.equal(r.outcomes.replacement, 1);
    const cream = r.articles.find((a) => /Pflegecreme/.test(a.article));
    assert.ok(cream, JSON.stringify(r.articles));
    assert.equal(cream!.byTopic.damaged_item, 1);
    assert.equal(r.firstReply.answered, 1, "the Amazon copy of a reply from Seller Central counts as an answer");
    await rejectsWith(supportReport(h.ctx, s.viewer, 5), "INVALID");
  });
});

describe("Frist-Hinweis", () => {
  it("counts open cases whose deadline is red", async () => {
    const { h, s } = await demo();
    const before = (await caseCounts(h.ctx, s.agent))!;
    await updateWorkspaceSettings(h.ctx, s.owner, { replyDeadlines: { amazon: 1, shopify: 0, docmorris: 0, ebay: 0, email: 0 } });
    const after_ = (await caseCounts(h.ctx, s.agent))!;
    assert.ok(after_.urgent >= 1, JSON.stringify({ before, after_ }));
    await updateWorkspaceSettings(h.ctx, s.owner, { replyDeadlines: { amazon: 0, shopify: 0, docmorris: 0, ebay: 0, email: 0 } });
    assert.equal((await caseCounts(h.ctx, s.agent))!.urgent, 0);
  });
});

describe("Nachweis-PDF", () => {
  it("puts order, tracking and the conversation into one PDF, for owner and agent only", async () => {
    const { h, s } = await demo();
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const pdf = await evidencePdf(h.ctx, s.agent, conv.id);
    assert.equal(pdf.name, "Nachweis 302-1234567-7654321.pdf");
    const text = pdf.data.toString("latin1");
    assert.match(text, /^%PDF-1\.4/);
    assert.match(text, /%%EOF\n$/);
    assert.match(text, /302-1234567-7654321/);
    assert.match(text, /DEMO00012345/);
    assert.match(text, /LS-5001/);
    await rejectsWith(evidencePdf(h.ctx, s.viewer, conv.id), "FORBIDDEN");
    assert.ok(await one(h.ctx.db, "SELECT 1 FROM audit_events WHERE action = 'conversation.evidence_pdf' AND target_id = $1", [conv.id]));
  });
});
