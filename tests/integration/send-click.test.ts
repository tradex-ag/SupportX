import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { dispatchOutbox, editDraft, sendDraft } from "../../packages/services/replies.ts";
import { many, one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

// 0.9.4: "Senden" sends with one click. There is no separate approval step any more,
// but every guard against a wrong send still holds.

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const rejectsWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: ServiceError) => {
    assert.equal(error.code, code, error.message);
    return true;
  });

async function amazonCase(sendMode: "drafts_only" | "enabled", ready = true) {
  h = await createHarness({ sendMode });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  if (ready) {
    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Kontrollierte Testantwort an eine Testbestellung kam an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
  }
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  const draft = (await currentDraft(h, s, conv.id))!;
  return { s, conv, draft };
}

describe("Senden ohne Freigabeschritt", () => {
  it("puts the draft into the outbox with one click and sends it to the original sender", async () => {
    const { s, conv, draft } = await amazonCase("enabled");
    const outboxId = await sendDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    const row = await one<{ state: string; body: string; expected_recipient: string | null }>(h!.ctx.db, "SELECT state, body, expected_recipient FROM outbox WHERE id = $1", [outboxId]);
    assert.equal(row!.state, "planned");
    assert.equal(row!.body, draft.body);
    const inbound = await one<{ from_address: string }>(h!.ctx.db, "SELECT from_address FROM messages WHERE id = $1", [conv.latest_inbound_message_id]);
    assert.equal(row!.expected_recipient, inbound!.from_address, "recipient comes from the customer message, not from the text");
    assert.equal(await dispatchOutbox(h!.ctx, s.workspaceId, outboxId), "provider_accepted");
    assert.equal(h!.graph.replies.length, 1);
  });

  it("leaves nothing behind when sending is blocked", async () => {
    const { s, draft } = await amazonCase("drafts_only");
    await rejectsWith(sendDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }), "SEND_BLOCKED");
    assert.equal((await many(h!.ctx.db, "SELECT 1 FROM approvals WHERE draft_id = $1", [draft.id])).length, 0);
    assert.equal((await many(h!.ctx.db, "SELECT 1 FROM outbox WHERE draft_id = $1", [draft.id])).length, 0);
  });

  it("blocks until the reply route is checked and sending is switched on for the connection", async () => {
    const { s, draft } = await amazonCase("enabled", false);
    await rejectsWith(sendDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }), "SEND_BLOCKED");
  });

  it("refuses a text that changed since it was shown", async () => {
    const { s, draft } = await amazonCase("enabled");
    await editDraft(h!.ctx, s.agent, draft.id, { body: `${draft.body}\nNachtrag.`, expectedVersion: draft.version });
    await rejectsWith(sendDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }), "VERSION_CONFLICT");
  });

  it("sends at most one reply per customer message, even on a double click", async () => {
    const { s, draft } = await amazonCase("enabled");
    const input = { expectedVersion: draft.version, acknowledgeWarnings: true };
    const results = await Promise.allSettled([sendDraft(h!.ctx, s.agent, draft.id, input), sendDraft(h!.ctx, s.agent, draft.id, input)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await many(h!.ctx.db, "SELECT 1 FROM outbox WHERE draft_id = $1", [draft.id])).length, 1);
  });

  it("does not let a viewer send", async () => {
    const { s, draft } = await amazonCase("enabled");
    await rejectsWith(sendDraft(h!.ctx, s.viewer, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }), "FORBIDDEN");
  });

  it("still asks to tick the hints when the draft has any", async () => {
    const { s, draft } = await amazonCase("enabled");
    await h!.ctx.db.query("UPDATE drafts SET issues = $2::jsonb WHERE id = $1", [draft.id, JSON.stringify([{ severity: "warn", code: "test", message: "Testhinweis" }])]);
    await rejectsWith(sendDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: false }), "WARNINGS_NOT_ACKNOWLEDGED");
    assert.ok(await sendDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }));
  });
});
