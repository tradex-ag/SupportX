import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getSettings, previewSubjectPattern, setCaseCategory } from "../../packages/services/cases.ts";
import { one } from "../../packages/storage/db.ts";
import { subjectPattern } from "../../packages/core/subject-pattern.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

// A neutral system sender that the automatic detection does not know.
const SYSTEM = "system@shop.example.invalid";
const claim = (n: number) => `Dein Antrag 1000${n}-2000${n} wurde für die Bestellung 302-111111${n}-222222${n} eingereicht`;
const category = async (id: string) => (await one<{ category: string; category_source: string; category_reason: string | null }>(h!.ctx.db, "SELECT category, category_source, category_reason FROM conversations WHERE id = $1", [id]))!;

describe("subject pattern rules", () => {
  it("preview counts existing cases, saving re-sorts them and sorts new mails; a person's choice stays", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: SYSTEM, subject: claim(1), body: "Eingereicht.", conversationId: "a" });
    h.graph.addInbound({ from: "other-system@shop2.example.invalid", subject: claim(2), body: "Eingereicht.", conversationId: "b" });
    h.graph.addInbound({ from: SYSTEM, subject: claim(3), body: "Eingereicht.", conversationId: "person" });
    h.graph.addInbound({ from: "kunde@example.invalid", subject: `AW: ${claim(4)}`, body: "Ich habe eine Frage dazu.", conversationId: "reply" });
    await syncAndDrain(h, s);
    const [a, b, person, reply] = await Promise.all(["a", "b", "person", "reply"].map((k) => caseByThread(h!, s, k)));
    for (const c of [a, b, person, reply]) assert.equal((await category(c!.id)).category, "support");
    await setCaseCategory(h.ctx, s.agent, person!.id, { category: "support" });

    const pattern = subjectPattern(claim(1));
    assert.equal(pattern, "Dein Antrag * wurde für die Bestellung * eingereicht");
    const preview = await previewSubjectPattern(h.ctx, s.agent, { pattern, category: "info" });
    assert.equal(preview.valid, true);
    assert.equal(preview.matching, 3, "a, b and the person's case; not the customer's reply");
    assert.equal(preview.moving, 2, "the person's case stays");
    assert.equal((await previewSubjectPattern(h.ctx, s.agent, { pattern: "* *", category: "info" })).valid, false);

    const { moved } = await setCaseCategory(h.ctx, s.agent, a!.id, { category: "info", remember: "subject", pattern });
    assert.equal(moved, 1);
    assert.equal((await category(a!.id)).category, "info");
    assert.deepEqual(await category(b!.id), { category: "info", category_source: "rule", category_reason: `Betreff-Muster „${pattern}“` });
    assert.equal((await category(person!.id)).category, "support");
    assert.equal((await category(reply!.id)).category, "support");

    // A new mail with the same kind of subject is sorted on arrival, from any sender.
    h.graph.addInbound({ from: "third@shop3.example.invalid", subject: claim(5), body: "Eingereicht.", conversationId: "new" });
    await syncAndDrain(h, s);
    const fresh = await caseByThread(h, s, "new");
    assert.equal((await category(fresh.id)).category_source, "rule");
    assert.equal((await category(fresh.id)).category, "info");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM drafts WHERE conversation_id = $1 AND status IN ('proposed','edited')", [fresh.id]), null);

    const settings = await getSettings(h.ctx, s.owner) as unknown as { categoryRules: Array<{ match_type: string; pattern: string; hits: number }> };
    const rule = settings.categoryRules.find((r) => r.match_type === "subject_pattern");
    assert.equal(rule?.pattern, pattern);
    assert.equal(rule?.hits, 3, "the case itself, the re-sorted one and the new mail");
  });

  it("stays inside the workspace and refuses patterns that catch everything", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    h.graph.addInbound({ from: SYSTEM, subject: claim(1), body: "Eingereicht.", conversationId: "a" });
    await syncAndDrain(h, s);
    const a = await caseByThread(h, s, "a");
    const pattern = subjectPattern(claim(1));
    assert.equal((await previewSubjectPattern(h.ctx, other.agent, { pattern, category: "info" })).matching, 0);
    await assert.rejects(setCaseCategory(h.ctx, other.agent, a.id, { category: "info", remember: "subject", pattern }), /nicht gefunden/);
    await assert.rejects(setCaseCategory(h.ctx, s.agent, a.id, { category: "info", remember: "subject", pattern: "* EUR *" }), /mindestens/);
    await assert.rejects(previewSubjectPattern(h.ctx, s.viewer, { pattern, category: "info" }));
    assert.equal((await category(a.id)).category, "support", "nothing changed by the refused calls");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM category_rules WHERE workspace_id = $1", [other.workspaceId]), null);
  });
});
