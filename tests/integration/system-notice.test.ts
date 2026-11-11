import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { caseCounts, getCase, listCases } from "../../packages/services/cases.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const ORDER = "302-1111111-2222222";
const REFUND = `9.99 EUR Rückerstattung veranlasst – Bestellung ${ORDER}`;
const REFUND_BODY = `Sehr geehrte(r) Testhändler,\nWir haben eine Rückerstattung von EUR 9.99 für die folgenden Artikel veranlasst:\n* Bestell-ID: ${ORDER}\nRücksendung: Testversand`;
const category = async (id: string) => (await one<{ category: string; category_reason: string | null }>(h!.ctx.db, "SELECT category, category_reason FROM conversations WHERE id = $1", [id]))!;

describe("marketplace system notices", () => {
  it("are filed as info on arrival: no deadline, no draft, not under Anfragen", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "seller-notification@amazon.de", subject: REFUND, body: REFUND_BODY, conversationId: "notice-1" });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "notice-1");
    assert.equal((await category(conv.id)).category, "info");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM drafts WHERE conversation_id = $1", [conv.id]), null);
    const open = await listCases(h.ctx, s.agent, "open");
    assert.ok(!open.some((r) => (r as { id: string }).id === conv.id));
    const counts = await caseCounts(h.ctx, s.agent) as { open: number; info: number };
    assert.equal(counts.open, 0);
    assert.equal(counts.info, 1);
  });

  it("show up in the history of the customer's case for the same order", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "kaeufer-1@marketplace.amazon.de", subject: `Rücksendung (Bestellung: ${ORDER})`, body: "Die Dose war beschädigt, ich schicke sie zurück.", conversationId: "req-1" });
    h.graph.addInbound({ from: "seller-notification@amazon.de", subject: REFUND, body: REFUND_BODY, conversationId: "notice-2" });
    h.graph.addInbound({ from: "seller-notification@amazon.de", subject: "Rückerstattung veranlasst – Bestellung 302-9999999-9999999", body: "Andere Bestellung", conversationId: "notice-3" });
    await syncAndDrain(h, s);
    const req = await caseByThread(h, s, "req-1");
    assert.equal((await category(req.id)).category, "support");
    const view = await getCase(h.ctx, s.agent, req.id);
    const kinds = (view.relatedMessages as Array<{ kind: string; subject: string }>).map((m) => [m.kind, m.subject]);
    assert.deepEqual(kinds, [["system_notice", REFUND]], "only the notice of this order, shown as a system notice");
  });

  it("existing ones are moved by the migration; requests, claims and a person's choice stay", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "seller-notification@amazon.de", subject: REFUND, body: REFUND_BODY, conversationId: "old-1" });
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: `Dein SAFE-T-Antrag 10000 wurde für die Bestellung ${ORDER} eingereicht`, body: "Eingereicht.", conversationId: "old-2" });
    h.graph.addInbound({ from: "seller-notification@amazon.de", subject: REFUND, body: REFUND_BODY, conversationId: "old-person" });
    h.graph.addInbound({ from: "atoz-guarantee-no-reply@amazon.de", subject: `A-bis-z-Garantieantrag für Bestellung ${ORDER}`, body: "Bitte antworten.", conversationId: "old-claim" });
    h.graph.addInbound({ from: "kaeufer-2@marketplace.amazon.de", subject: `Frage (Bestellung: ${ORDER})`, body: "Wo ist mein Paket?", conversationId: "old-buyer" });
    await syncAndDrain(h, s);
    const ids = Object.fromEntries(await Promise.all(["old-1", "old-2", "old-person", "old-claim", "old-buyer"].map(async (k) => [k, (await caseByThread(h!, s, k)).id] as const)));
    // As before this update: all filed as requests.
    await h.ctx.db.query("UPDATE conversations SET category = 'support', category_source = 'auto', category_reason = 'Kundenanliegen erkannt' WHERE workspace_id = $1", [s.workspaceId]);
    await h.ctx.db.query("UPDATE conversations SET category_source = 'person' WHERE id = $1", [ids["old-person"]]);
    await h.ctx.db.query(readFileSync(new URL("../../packages/storage/migrations/018_system_notices.sql", import.meta.url), "utf8"));
    assert.deepEqual(await category(ids["old-1"]!), { category: "info", category_reason: "Systemmeldung des Marktplatzes" });
    assert.equal((await category(ids["old-2"]!)).category, "info");
    assert.equal((await category(ids["old-person"]!)).category, "support");
    assert.equal((await category(ids["old-claim"]!)).category, "support");
    assert.equal((await category(ids["old-buyer"]!)).category, "support");
  });
});
