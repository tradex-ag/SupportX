import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { ServiceError } from "../../packages/services/context.ts";
import { refreshOrderLink } from "../../packages/services/matching.ts";
import { one } from "../../packages/storage/db.ts";
import type { OrderRecord } from "../../packages/core/contracts.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const snapshot = async (h: Harness, ws: string, convId: string) =>
  (await one<{ snapshot: OrderRecord; matched_by: string }>(h.ctx.db, "SELECT snapshot, matched_by FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [ws, convId]))!;

describe("Retoure im Fall", () => {
  it("stores the return with the order and reads it again on click, read-only and without losing the match", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    assert.equal(conv.order_match_status, "unique");
    const first = await snapshot(h, s.workspaceId, conv.id);
    assert.deepEqual(first.snapshot.returns, [], "no return for this order yet");

    // Nothing changed in weclapp: refresh keeps everything.
    assert.deepEqual(await refreshOrderLink(h.ctx, s.agent, conv.id), { status: "unique", changed: false });

    // The customer sends goods back; the warehouse books the return in weclapp.
    h.weclapp.data.incomingGoods!.push({
      id: "ig-new", incomingGoodsNumber: "WE-7100", incomingGoodsType: "CUSTOMER_RETURN", status: "INCOMING_MOVED_INTO_STORE",
      salesOrders: [{ id: "so-amz-1" }], statusHistory: [{ status: "INCOMING_MOVED_INTO_STORE", statusDate: Date.parse("2026-11-03T10:00:00Z") }],
      incomingGoodsItems: [{ salesOrderItemId: "soi-1", quantity: "1" }],
    });
    assert.deepEqual(await refreshOrderLink(h.ctx, s.agent, conv.id), { status: "unique", changed: true });
    const after = await snapshot(h, s.workspaceId, conv.id);
    assert.equal(after.snapshot.returns?.[0]?.returnNumber, "WE-7100");
    assert.equal(after.matched_by, first.matched_by, "original match is kept");
    assert.ok(h.weclapp.requests.every((r) => r.startsWith("GET ")), "weclapp is only read");
  });

  it("refuses viewers and cases without an order", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    await assert.rejects(refreshOrderLink(h.ctx, s.viewer, conv.id), (e: ServiceError) => e.status === 403);
    await h.ctx.db.query("UPDATE order_links SET external_order_id = NULL WHERE workspace_id = $1 AND conversation_id = $2", [s.workspaceId, conv.id]);
    await assert.rejects(refreshOrderLink(h.ctx, s.agent, conv.id), (e: ServiceError) => e.code === "NO_ORDER");
  });
});
