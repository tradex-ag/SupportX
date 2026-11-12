import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase, listCases, setOutcome } from "../../packages/services/cases.ts";
import { refreshOrderLink } from "../../packages/services/matching.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("Erstattung offen", () => {
  it("flags the case and its list row once the goods are back, and stops when a refund is recorded", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const row = async () => (await listCases(h!.ctx, s.agent, "all")).find((r) => r.id === conv.id)!;

    assert.equal((await getCase(h.ctx, s.agent, conv.id)).refund.state, "none", "no return yet");
    assert.equal((await row()).refund, "none");

    h.weclapp.data.incomingGoods!.push({
      id: "ig-back", incomingGoodsNumber: "WE-7200", incomingGoodsType: "CUSTOMER_RETURN", status: "INCOMING_MOVED_INTO_STORE",
      salesOrders: [{ id: "so-amz-1" }], statusHistory: [{ status: "INCOMING_MOVED_INTO_STORE", statusDate: Date.parse("2026-11-03T10:00:00Z") }],
      incomingGoodsItems: [{ salesOrderItemId: "soi-1", quantity: "1" }],
    });
    await refreshOrderLink(h.ctx, s.agent, conv.id);
    const due = (await getCase(h.ctx, s.agent, conv.id)).refund;
    assert.equal(due.state, "due");
    assert.equal(due.headline, "Erstattung ist jetzt zu machen: Ware zurück (03.11.2026).");
    assert.equal((await row()).refund, "due");
    assert.equal("order_return" in (await row()), false, "the list does not ship the order snapshot");

    // A marketplace notice about the refund for the same order (any category) ends it.
    const other = (await listCases(h.ctx, s.agent, "all")).find((r) => r.id !== conv.id)!;
    await h.ctx.db.query(
      "UPDATE conversations SET subject = $3, order_references = $4::jsonb WHERE workspace_id = $1 AND id = $2",
      [s.workspaceId, other.id, "12.50 EUR Rückerstattung veranlasst – Bestellung 302-1234567-7654321", JSON.stringify([{ value: "302-1234567-7654321", kind: "order" }])],
    );
    const done = (await getCase(h.ctx, s.agent, conv.id)).refund;
    assert.equal(done.state, "done");
    assert.equal(done.signals[0]!.source, "notice");
    assert.equal((await row()).refund, "done");
    // The exact return check: 1 of 1 shipped unit back (the sieve was never shipped), 24.90 € fit, the notice says 12.50 €.
    const check = (await getCase(h.ctx, s.agent, conv.id)).returnCheck!;
    assert.equal(check.applicable, true);
    assert.deepEqual([check.receivedUnits, check.baseUnits, check.complete], [1, 1, true]);
    assert.equal(check.amounts!.expected, 24.9);
    assert.equal(check.amounts!.noticed, 12.5);
    assert.ok(check.findings.some((f) => f.code === "credit_lower" && f.text.startsWith("Marktplatz-Erstattung 12,50 €")));

    // Without the notice, the outcome "Erstattet" on the case ends it too.
    await h.ctx.db.query("UPDATE conversations SET subject = 'Frage', order_references = '[]' WHERE workspace_id = $1 AND id = $2", [s.workspaceId, other.id]);
    assert.equal((await row()).refund, "due");
    await setOutcome(h.ctx, s.agent, conv.id, { outcome: "refund" });
    assert.equal((await row()).refund, "done");
  });
});
