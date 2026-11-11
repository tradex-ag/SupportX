import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { approveDraft, dispatchOutbox, editDraft, queueReply, reconcileOutbox, resolveUncertainSend, sendBlockers } from "../../packages/services/replies.ts";
import { enrichConversation } from "../../packages/services/matching.ts";
import { many, one } from "../../packages/storage/db.ts";
import { OUTBOX_HEADER } from "../../packages/connectors/microsoft/graph-mail.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

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

describe("ingestion and matching", () => {
  it("runs Microsoft mail → inbox → weclapp matching → draft for all demo cases", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const rows = await many<{ external_thread_key: string; source_platform: string; order_match_status: string; merchant_account_id: string | null }>(
      h.ctx.db, "SELECT external_thread_key, source_platform, order_match_status, merchant_account_id FROM conversations WHERE workspace_id = $1", [s.workspaceId]);
    const byKey = Object.fromEntries(rows.map((r) => [r.external_thread_key.replace("conv-", ""), r]));
    assert.equal(rows.length, 10);
    assert.equal(byKey["amazon-wismo"]!.order_match_status, "unique");
    assert.equal(byKey["docmorris-damaged"]!.source_platform, "docmorris");
    assert.equal(byKey["docmorris-damaged"]!.order_match_status, "unique");
    assert.equal(byKey["ebay-ambiguous"]!.order_match_status, "ambiguous");
    assert.equal(byKey["amazon-missing"]!.order_match_status, "missing");
    assert.equal(byKey["unknown-sender"]!.order_match_status, "no_reference");
    const drafts = await many(h.ctx.db, "SELECT 1 FROM drafts WHERE workspace_id = $1 AND status = 'proposed'", [s.workspaceId]);
    assert.equal(drafts.length, 8, "no draft for the promotion and our own Amazon copy; Lena's follow-up joins her first case");
    const promo = await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE workspace_id = $1 AND external_thread_key = 'conv-marketplace-promo'", [s.workspaceId]);
    assert.equal(promo!.category, "info");
  });

  it("matches the same order number to the right seller account", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "kunde@shop.example.invalid", subject: "Bestellung #1001", body: "Wo ist sie?", conversationId: "shop" });
    h.graph.addInbound({ from: "k@ebay-relay.demo.invalid", subject: "Bestellung #1001", body: "Wo ist sie?", conversationId: "ebay" });
    await syncAndDrain(h, s);
    const links = await many<{ external_thread_key: string; external_order_id: string }>(
      h.ctx.db, "SELECT c.external_thread_key, l.external_order_id FROM order_links l JOIN conversations c ON c.id = l.conversation_id WHERE l.workspace_id = $1 AND l.is_current", [s.workspaceId]);
    const byKey = Object.fromEntries(links.map((l) => [l.external_thread_key, l.external_order_id]));
    assert.equal(byKey.shop, "so-shop-1");
    assert.equal(byKey.ebay, "so-ebay-x");
  });

  it("without a seller account the number is searched in all of weclapp and fills in the account", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "unbekannt@example.invalid", subject: "Frage", body: "Hallo", conversationId: "noacc" });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "noacc");
    await h.ctx.db.query("UPDATE conversations SET merchant_account_id = NULL WHERE id = $1", [conv.id]);
    assert.equal(await enrichConversation(h.ctx, s.workspaceId, conv.id, { manualReference: "AU-10003" }), "unique");
    const after = await one<{ merchant_account_id: string | null; external_order_id: string }>(h.ctx.db,
      "SELECT c.merchant_account_id, l.external_order_id FROM conversations c JOIN order_links l ON l.conversation_id = c.id AND l.is_current WHERE c.id = $1", [conv.id]);
    assert.equal(after!.external_order_id, "so-shop-1");
    assert.equal(after!.merchant_account_id, s.accounts.shopify, "the account whose weclapp rule fits the order");
  });

  it("keeps several parcels and flags the shipment without tracking", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = (await currentDraft(h, s, conv.id))!;
    const ids = draft.facts.map((f) => f.id);
    assert.ok(ids.includes("shipment.1.parcel.1") && ids.includes("shipment.1.parcel.2"), "both parcels of the first shipment");
    assert.ok(ids.includes("shipment.2.no_tracking"), "second shipment has no tracking");
    assert.doesNotMatch(draft.body, /zugestellt/i);
  });

  it("does not duplicate on repeated sync or after an expired delta token", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    await syncAndDrain(h, s);
    h.graph.expireDeltaTokens();
    await syncAndDrain(h, s);
    const count = await one<{ n: number }>(h.ctx.db, "SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1", [s.workspaceId]);
    assert.equal(count!.n, 11);
  });

  it("stores a genuinely repeated customer message and supersedes the old draft", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "kunde@shop.example.invalid", subject: "Bestellung #1002", body: "Wo ist mein Paket?", conversationId: "rep" });
    await syncAndDrain(h, s);
    const before = await caseByThread(h, s, "rep");
    const firstDraft = (await currentDraft(h, s, before.id))!;
    h.graph.addInbound({ from: "kunde@shop.example.invalid", subject: "Bestellung #1002", body: "Wo ist mein Paket?", conversationId: "rep" });
    await syncAndDrain(h, s);
    const afterConv = await caseByThread(h, s, "rep");
    const msgs = await many(h.ctx.db, "SELECT 1 FROM messages WHERE conversation_id = $1", [before.id]);
    assert.equal(msgs.length, 2);
    assert.ok(afterConv.version > before.version);
    const old = await one<{ status: string }>(h.ctx.db, "SELECT status FROM drafts WHERE id = $1", [firstDraft.id]);
    assert.equal(old!.status, "superseded");
  });

  it("treats instructions inside a customer mail as content", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-injection");
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.doesNotMatch(draft.body, /erstattet|500|chef@/i);
    assert.ok(draft.risks.includes("refund"));
    const recipient = await one<{ customer_address: string }>(h.ctx.db, "SELECT customer_address FROM conversations WHERE id = $1", [conv.id]);
    assert.equal(recipient!.customer_address, "lena.test@kunde.example.invalid");
  });
});

describe("approvals and sending", () => {
  async function approvedAmazonCase(sendMode: "drafts_only" | "enabled", graphTimeoutMs?: number) {
    h = await createHarness({ sendMode, graphTimeoutMs });
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = (await currentDraft(h, s, conv.id))!;
    const approvalId = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    return { s, conv, draft, approvalId };
  }
  async function enableSending(s: Awaited<ReturnType<typeof approvedAmazonCase>>["s"]) {
    await verifyReplyRoute(h!.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort an Testbestellung am 21.10. kam im Käuferpostfach an" });
    await setSendEnabled(h!.ctx, s.owner, s.connectionId, true);
  }

  it("blocks sending in drafts-only mode", async () => {
    const { s, approvalId } = await approvedAmazonCase("drafts_only");
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "SEND_BLOCKED");
  });

  it("blocks sending until the reply route is verified and the connection is enabled", async () => {
    const { s, approvalId } = await approvedAmazonCase("enabled");
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "SEND_BLOCKED");
    await setSendEnabled(h!.ctx, s.owner, s.connectionId, true);
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "SEND_BLOCKED");
  });

  it("invalidates an approval when a new customer message arrives", async () => {
    const { s, conv, approvalId } = await approvedAmazonCase("enabled");
    await enableSending(s);
    h!.graph.addInbound({ from: "kunde-a1b2c3@amazon-relay.demo.invalid", subject: "Re: Frage", body: "Ach, und die Rechnung bitte.", conversationId: "conv-amazon-wismo" });
    await syncAndDrain(h!, s);
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "APPROVAL_INVALID");
    const approval = await one<{ invalidated_at: Date | null }>(h!.ctx.db, "SELECT invalidated_at FROM approvals WHERE id = $1", [approvalId]);
    assert.ok(approval!.invalidated_at);
    assert.ok(conv.id);
  });

  it("invalidates an approval when the draft is edited", async () => {
    const { s, draft, approvalId } = await approvedAmazonCase("enabled");
    await enableSending(s);
    await editDraft(h!.ctx, s.agent, draft.id, { body: `${draft.body}\nNachtrag.`, expectedVersion: draft.version });
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "APPROVAL_INVALID");
  });

  it("does not let a viewer approve", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = (await currentDraft(h, s, conv.id))!;
    await rejectsWith(approveDraft(h.ctx, s.viewer, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true }), "FORBIDDEN");
  });

  it("sends once, recognises its own sent copy and refuses a second reply", async () => {
    const { s, conv, approvalId } = await approvedAmazonCase("enabled");
    await enableSending(s);
    // Two clicks at the same time: exactly one outbox entry survives.
    const results = await Promise.allSettled([queueReply(h!.ctx, s.agent, approvalId), queueReply(h!.ctx, s.agent, approvalId)]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>[];
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.ok(["DUPLICATE_REPLY", "SEND_BLOCKED"].includes((failed[0]!.reason as ServiceError).code));
    const outboxId = ok[0]!.value;
    // The case view gets the queued reply as a status, not only as a blocker text.
    const status = await sendBlockers(h!.ctx, h!.ctx.db, s.workspaceId, conv.id);
    assert.equal(status.pending?.state, "planned");
    assert.ok(status.blockers.includes(status.pending!.text));
    assert.equal(status.setupMissing, false);
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "SEND_BLOCKED");
    assert.equal(await dispatchOutbox(h!.ctx, s.workspaceId, outboxId), "provider_accepted");
    assert.equal(h!.graph.replies.length, 1);
    assert.ok(h!.graph.replies[0]!.headers.some((x) => x.name === OUTBOX_HEADER && x.value === outboxId));
    await syncAndDrain(h!, s);
    const echo = await one<{ kind: string }>(h!.ctx.db, "SELECT kind FROM messages WHERE outbox_id = $1", [outboxId]);
    assert.equal(echo!.kind, "echo");
    const state = await one<{ state: string }>(h!.ctx.db, "SELECT state FROM outbox WHERE id = $1", [outboxId]);
    assert.equal(state!.state, "confirmed");
    const convs = await many(h!.ctx.db, "SELECT 1 FROM conversations WHERE workspace_id = $1", [s.workspaceId]);
    assert.equal(convs.length, 10, "own reply does not open a new case");
    const pending = await currentDraft(h!, s, conv.id);
    assert.equal(pending, null, "no new draft for our own reply");
  });

  it("marks a timeout after sending as uncertain and confirms it by reconciliation, without resending", async () => {
    const { s, approvalId } = await approvedAmazonCase("enabled", 150);
    await enableSending(s);
    const outboxId = await queueReply(h!.ctx, s.agent, approvalId);
    h!.graph.setReplyFault("timeout_after_send");
    assert.equal(await dispatchOutbox(h!.ctx, s.workspaceId, outboxId), "delivery_uncertain");
    assert.equal(await dispatchOutbox(h!.ctx, s.workspaceId, outboxId), "skipped", "an uncertain send is never dispatched again");
    assert.equal(await reconcileOutbox(h!.ctx, s.workspaceId, outboxId), "confirmed");
    assert.equal(h!.graph.replies.length, 1);
  });

  it("leaves a timeout before sending for a person to resolve, then allows a new approval", async () => {
    const { s, conv, approvalId } = await approvedAmazonCase("enabled", 150);
    await enableSending(s);
    const outboxId = await queueReply(h!.ctx, s.agent, approvalId);
    h!.graph.setReplyFault("timeout_before_send");
    assert.equal(await dispatchOutbox(h!.ctx, s.workspaceId, outboxId), "delivery_uncertain");
    assert.equal(await reconcileOutbox(h!.ctx, s.workspaceId, outboxId), "still_uncertain");
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "SEND_BLOCKED");
    await resolveUncertainSend(h!.ctx, s.agent, outboxId, "was_not_sent");
    const draft = (await currentDraft(h!, s, conv.id))!;
    const second = await approveDraft(h!.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    const outbox2 = await queueReply(h!.ctx, s.agent, second);
    assert.equal(await dispatchOutbox(h!.ctx, s.workspaceId, outbox2), "provider_accepted");
    assert.equal(h!.graph.replies.length, 1);
  });

  it("recognises a reply sent manually in Outlook and withdraws the approval", async () => {
    const { s, approvalId } = await approvedAmazonCase("enabled");
    await enableSending(s);
    h!.graph.addSent({ to: "kunde-a1b2c3@amazon-relay.demo.invalid", subject: "AW: Frage", body: "Manuell geantwortet", conversationId: "conv-amazon-wismo" });
    await syncAndDrain(h!, s);
    const manual = await one<{ kind: string }>(h!.ctx.db, "SELECT kind FROM messages WHERE workspace_id = $1 AND direction = 'outbound'", [s.workspaceId]);
    assert.equal(manual!.kind, "manual_external");
    await rejectsWith(queueReply(h!.ctx, s.agent, approvalId), "APPROVAL_INVALID");
  });
});
