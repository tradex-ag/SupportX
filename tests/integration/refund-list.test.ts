import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase, setOutcome } from "../../packages/services/cases.ts";
import { addToRefundList, listRefunds, removeFromRefundList, setRefundDetails, setRefundDone } from "../../packages/services/refunds.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("Erstattungsliste", () => {
  it("lists refunds per order, ticks them off for the whole group and keeps workspaces apart", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");

    assert.deepEqual((await listRefunds(h.ctx, s.agent, "open")).counts, { open: 0, done: 0 });
    assert.equal((await getCase(h.ctx, s.agent, conv.id)).refundList.state, "none");

    // "Erstattet" puts the case on the list, with the weclapp order and its articles.
    await setOutcome(h.ctx, s.agent, conv.id, { outcome: "refund", note: "Kulanz" });
    let list = await listRefunds(h.ctx, s.agent, "open");
    assert.equal(list.items.length, 1);
    const item = list.items[0]!;
    assert.equal(item.orderNumber, "AU-10001");
    assert.equal(item.marketplaceOrderNumber, "302-1234567-7654321");
    assert.equal(item.kind, "full");
    assert.equal(item.note, "Kulanz");
    assert.ok(item.items.length > 0);
    assert.equal(item.itemsFrom, "order");

    // The marketplace notice for the same order joins it instead of a second refund.
    const notice = (await h.ctx.db.query<{ id: string }>("SELECT id FROM conversations WHERE workspace_id = $1 AND id <> $2 LIMIT 1", [s.workspaceId, conv.id])).rows[0]!.id;
    await h.ctx.db.query("UPDATE conversations SET subject = $3, order_references = $4::jsonb, category = 'info' WHERE workspace_id = $1 AND id = $2",
      [s.workspaceId, notice, "18.30 EUR Rückerstattung veranlasst – Bestellung 302-1234567-7654321", JSON.stringify([{ value: "302-1234567-7654321", kind: "order" }])]);
    list = await listRefunds(h.ctx, s.agent, "open");
    assert.equal(list.items.length, 1);
    assert.deepEqual([...list.items[0]!.conversationIds].sort(), [conv.id, notice].sort());
    assert.deepEqual(list.items[0]!.amount, { cents: 1830, currency: "EUR", from: "notice" });

    // A viewer sees the list but cannot tick; another workspace cannot touch the cases.
    await assert.rejects(setRefundDone(h.ctx, s.viewer, { conversationIds: [conv.id], done: true }), { status: 403 });
    await assert.rejects(setRefundDone(h.ctx, other.agent, { conversationIds: [conv.id], done: true }), { status: 404 });
    await assert.rejects(setRefundDetails(h.ctx, other.agent, { conversationIds: [conv.id], amount: "1" }), { status: 404 });
    assert.equal((await listRefunds(h.ctx, other.agent, "all")).items.length, 0);
    assert.equal((await listRefunds(h.ctx, s.viewer, "open")).items.length, 1);

    await setRefundDetails(h.ctx, s.agent, { conversationIds: list.items[0]!.conversationIds, amount: "19,99" });
    await assert.rejects(setRefundDetails(h.ctx, s.agent, { conversationIds: [conv.id], amount: "neunzehn" }), { status: 400 });
    await setRefundDone(h.ctx, s.agent, { conversationIds: list.items[0]!.conversationIds, done: true, creditNoteNumber: "GS-1001" });
    assert.deepEqual((await listRefunds(h.ctx, s.agent, "open")).counts, { open: 0, done: 1 });
    const done = (await listRefunds(h.ctx, s.agent, "done")).items[0]!;
    assert.deepEqual(done.amount, { cents: 1999, currency: "EUR", from: "entered" });
    assert.equal(done.done!.creditNoteNumber, "GS-1001");
    assert.ok(done.done!.by, "who ticked it");
    assert.equal((await getCase(h.ctx, s.agent, notice)).refundList.state, "done", "the notice case shows it too");
    const audits = await h.ctx.db.query("SELECT 1 FROM audit_events WHERE workspace_id = $1 AND action = 'refund.done'", [s.workspaceId]);
    assert.equal(audits.rowCount, 1);

    // Taking the tick back.
    await setRefundDone(h.ctx, s.agent, { conversationIds: [conv.id, notice], done: false });
    assert.equal((await listRefunds(h.ctx, s.agent, "open")).items[0]!.done, null);

    // Off the list and back by hand.
    await removeFromRefundList(h.ctx, s.agent, [conv.id, notice]);
    assert.equal((await listRefunds(h.ctx, s.agent, "all")).items.length, 0);
    assert.equal((await getCase(h.ctx, s.agent, conv.id)).refundList.removed, true);
    await addToRefundList(h.ctx, s.agent, conv.id);
    assert.deepEqual((await listRefunds(h.ctx, s.agent, "all")).items[0]!.conversationIds, [conv.id]);
    // Choosing "Erstattet" again on a removed case brings it back as well.
    await removeFromRefundList(h.ctx, s.agent, [conv.id]);
    await setOutcome(h.ctx, s.agent, conv.id, { outcome: "partial_refund" });
    assert.equal((await listRefunds(h.ctx, s.agent, "open")).items[0]!.kind, "partial");
  });
});
