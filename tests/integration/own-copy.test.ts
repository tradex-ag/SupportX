import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { getCase } from "../../packages/services/cases.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const COPY = "[Amazon.com] Sehr geehrte(r) Demo-Händler,\n\nHier ist eine Kopie der E-Mail, die du an Erika gesendet hast.\n\nBestellnummer 302-1234567-7654321:\n\nAnbei das Retourenlabel.";

describe("Amazon copies of our own messages", () => {
  it("are sorted out on arrival, without a draft", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Erika", body: COPY, conversationId: "copy-1" });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "copy-1");
    const row = (await one<{ category: string; category_reason: string }>(h.ctx.db, "SELECT category, category_reason FROM conversations WHERE id = $1", [conv.id]))!;
    assert.equal(row.category, "info");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM drafts WHERE conversation_id = $1", [conv.id]), null);
  });

  it("existing ones are moved by the migration, a person's choice stays", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Erika", body: COPY, conversationId: "copy-2" });
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Ingrid", body: COPY.replace("Erika", "Ingrid"), conversationId: "copy-3" });
    await syncAndDrain(h, s);
    const auto = await caseByThread(h, s, "copy-2");
    const person = await caseByThread(h, s, "copy-3");
    // As before this update: filed as requests.
    await h.ctx.db.query("UPDATE conversations SET category = 'support', category_source = 'auto' WHERE id = $1", [auto.id]);
    await h.ctx.db.query("UPDATE conversations SET category = 'support', category_source = 'person' WHERE id = $1", [person.id]);
    await h.ctx.db.query(readFileSync(new URL("../../packages/storage/migrations/012_own_copies.sql", import.meta.url), "utf8"));
    assert.equal((await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE id = $1", [auto.id]))!.category, "info");
    assert.equal((await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE id = $1", [person.id]))!.category, "support");
  });
});

describe("our answers in the history", () => {
  it("shows Amazon's copy of our reply in the case of the same order, with only our text", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "kunde-x@marketplace.amazon.de", subject: "Falscher Artikel (Bestellung: 302-1234567-7654321)", body: "Ich habe die falsche Dose bekommen.", conversationId: "req-1" });
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Erika", body: COPY.replace("Anbei das Retourenlabel.", "------------- Beginnmeldung -------------\n\nAnbei das Retourenlabel, wir senden Ersatz.\n\n------------- Endmeldung -------------"), conversationId: "copy-9" });
    await syncAndDrain(h, s);
    const req = await caseByThread(h, s, "req-1");
    const view = await getCase(h.ctx, s.agent, req.id);
    const ours = view.relatedMessages.find((m) => (m as { kind: string }).kind === "own_copy") as { body_text: string; direction: string } | undefined;
    assert.ok(ours, "the copy shows up in the history");
    assert.equal(ours.direction, "outbound");
    assert.equal(ours.body_text, "Anbei das Retourenlabel, wir senden Ersatz.");
  });
});
