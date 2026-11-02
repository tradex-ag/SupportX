import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { caseCounts, getCase, listCases, setStatus, updateWorkspaceSettings } from "../../packages/services/cases.ts";
import { setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { attachUploadedFile, listDocuments, setDraftDocuments } from "../../packages/services/documents.ts";
import { autoInvoice, draftInvoiceReply, fetchCaseInvoices } from "../../packages/services/invoices.ts";
import { DEMO } from "../../packages/testing/demo-data.ts";
import { approveDraft, dispatchOutbox, queueReply } from "../../packages/services/replies.ts";
import { many, one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: ServiceError) => e.code === code);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("bild")]);

async function amazonCase(sendMode: "drafts_only" | "enabled" = "drafts_only") {
  h = await createHarness({ sendMode });
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  assert.equal(conv.order_match_status, "unique");
  return { h, s, conv };
}

describe("Rechnung senden: invoice PDF from weclapp", () => {
  it("fetches the invoice read-only, attaches it to a template draft and sends it only after approval and click, over the original route", async () => {
    const { h, s, conv } = await amazonCase("enabled");
    const before = h.graph.replies.length;
    const result = await draftInvoiceReply(h.ctx, s.agent, conv.id);
    assert.equal(result.attached, true);
    assert.deepEqual(result.files.map((f) => [f.name, f.source]), [["Rechnung RE-9001.pdf", "erp_invoice"]]);
    assert.equal(h.graph.replies.length, before, "nothing is sent by the click");
    assert.ok(h.weclapp.requests.some((r) => r === "GET /webapp/api/v2/salesInvoice/id/inv-1/downloadLatestSalesInvoicePdf"));
    assert.ok(h.weclapp.requests.every((r) => r.startsWith("GET ")), "weclapp is only read");

    const draft = (await one<{ id: string; version: number; body: string; decision: string; generated_by: string; document_ids: string[]; issues: Array<{ code: string; severity: string }> }>(
      h.ctx.db, "SELECT * FROM drafts WHERE workspace_id = $1 AND id = $2", [s.workspaceId, result.draftId],
    ))!;
    assert.equal(draft.decision, "invoice");
    assert.equal(draft.generated_by, "rules", "template, no AI cost");
    assert.match(draft.body, /Rechnung RE-9001 zu Ihrer Bestellung 302-1234567-7654321/);
    assert.deepEqual(draft.document_ids, [result.files[0]!.id]);
    assert.ok(!draft.issues.some((i) => i.severity === "block"), JSON.stringify(draft.issues));
    assert.equal((await listDocuments(h.ctx, s.owner)).length, 0, "case files stay out of the workspace list");
    const view = await getCase(h.ctx, s.agent, conv.id);
    assert.deepEqual(view.invoices, ["RE-9001"]);
    assert.equal(view.caseFiles.length, 1);

    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort kam im Käuferpostfach an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    const approval = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    const outboxId = await queueReply(h.ctx, s.agent, approval);
    assert.equal(await dispatchOutbox(h.ctx, s.workspaceId, outboxId), "provider_accepted");
    const sent = h.graph.replies.at(-1)!;
    const original = await one<{ external_message_id: string }>(h.ctx.db, "SELECT m.external_message_id FROM messages m JOIN conversations c ON c.latest_inbound_message_id = m.id WHERE c.id = $1", [conv.id]);
    assert.equal(sent.inReplyTo, original!.external_message_id, "reply to the customer's own message (Amazon relay)");
    assert.deepEqual(sent.attachments.map((a) => [a.name, a.contentType]), [["Rechnung RE-9001.pdf", "application/pdf"]]);
    assert.match(Buffer.from(sent.attachments[0]!.contentBytes, "base64").toString("latin1"), /^%PDF-/);
  });

  it("warns when the customer names an address in the text and never uses it as recipient", async () => {
    const { h, s, conv } = await amazonCase();
    await h.ctx.db.query("UPDATE messages SET body_text = $2 WHERE id = $1", [conv.latest_inbound_message_id, "Bitte senden Sie die Rechnung (mit USt) an folgende Mail Adresse: max. muster(at) example .de"]);
    const { draftId } = await draftInvoiceReply(h.ctx, s.agent, conv.id);
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.equal(draft.id, draftId);
    assert.ok(draft.issues.some((i) => i.code === "RECIPIENT_IN_TEXT" && i.severity === "warn"));
    assert.doesNotMatch(draft.body, /example/);
    await rejectsWith(approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: false }), "WARNINGS_NOT_ACKNOWLEDGED");
  });

  it("says clearly what is missing instead of drafting: no unique order, no invoice, only a credit note, no PDF", async () => {
    const { h, s, conv } = await amazonCase();
    const draftsBefore = (await many(h.ctx.db, "SELECT id FROM drafts WHERE conversation_id = $1", [conv.id])).length;
    const other = await seedWorkspace(h, "Anderer Händler");
    await rejectsWith(draftInvoiceReply(h.ctx, other.owner, conv.id), "NOT_FOUND");
    await rejectsWith(draftInvoiceReply(h.ctx, s.viewer, conv.id), "FORBIDDEN");

    const inv = h.weclapp.data.salesInvoice.find((i) => i.id === "inv-1")!;
    inv.noPdf = true;
    await rejectsWith(draftInvoiceReply(h.ctx, s.agent, conv.id), "NO_PDF");
    inv.salesInvoiceType = "CREDIT_NOTE";
    await rejectsWith(draftInvoiceReply(h.ctx, s.agent, conv.id), "NO_INVOICE");
    h.weclapp.data.salesInvoice.splice(h.weclapp.data.salesInvoice.indexOf(inv), 1);
    await rejectsWith(draftInvoiceReply(h.ctx, s.agent, conv.id), "NO_INVOICE");

    const ambiguous = await caseByThread(h, s, "conv-ebay-ambiguous");
    await rejectsWith(draftInvoiceReply(h.ctx, s.agent, ambiguous.id), "ORDER_NOT_UNIQUE");
    const missing = await caseByThread(h, s, "conv-amazon-missing");
    await rejectsWith(draftInvoiceReply(h.ctx, s.agent, missing.id), "ORDER_NOT_UNIQUE");

    assert.equal((await many(h.ctx.db, "SELECT id FROM drafts WHERE conversation_id = $1", [conv.id])).length, draftsBefore, "no draft on failure");
    assert.equal((await many(h.ctx.db, "SELECT id FROM documents WHERE conversation_id = $1", [conv.id])).length, 0);
  });
});

describe("Datei anhängen: a file for one reply", () => {
  it("accepts PDF, JPG and PNG by content, keeps it to this case and voids an earlier approval", async () => {
    const { h, s, conv } = await amazonCase();
    const draft = (await currentDraft(h, s, conv.id))!;
    await rejectsWith(attachUploadedFile(h.ctx, s.agent, draft.id, { name: "virus.exe", data: Buffer.from("MZ..."), expectedVersion: draft.version }), "UNSUPPORTED_TYPE");
    await rejectsWith(attachUploadedFile(h.ctx, s.agent, draft.id, { name: "a.png", data: Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), expectedVersion: draft.version }), "TOO_LARGE");
    await rejectsWith(attachUploadedFile(h.ctx, s.viewer, draft.id, { name: "a.png", data: PNG, expectedVersion: draft.version }), "FORBIDDEN");
    const other = await seedWorkspace(h, "Anderer Händler");
    await rejectsWith(attachUploadedFile(h.ctx, other.agent, draft.id, { name: "a.png", data: PNG, expectedVersion: draft.version }), "NOT_FOUND");

    const early = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    const { version, file } = await attachUploadedFile(h.ctx, s.agent, draft.id, { name: "Foto vom Etikett.pdf", data: PNG, expectedVersion: draft.version });
    assert.equal(file.name, "Foto vom Etikett.png", "the name follows the real type");
    assert.equal(file.content_type, "image/png");
    assert.equal(version, draft.version + 1);
    const invalidated = await one<{ invalidated_at: Date | null }>(h.ctx.db, "SELECT invalidated_at FROM approvals WHERE id = $1", [early]);
    assert.ok(invalidated?.invalidated_at, "earlier approval no longer counts");
    assert.equal((await listDocuments(h.ctx, s.owner)).length, 0);

    // A file of this case cannot be attached in another case.
    const otherCase = await caseByThread(h, s, "conv-shopify-wrong");
    const otherDraft = (await currentDraft(h, s, otherCase.id))!;
    await rejectsWith(setDraftDocuments(h.ctx, s.agent, otherDraft.id, { documentIds: [file.id], expectedVersion: otherDraft.version }), "NOT_FOUND");
  });
});

describe("Rechnungsanfragen automatisch", () => {
  const ask = (h: Harness, body: string, key: string) =>
    h.graph.addInbound({ from: `kunde-${key}@${DEMO.amazonRelayDomain}`, fromName: "Kundin", subject: "Rechnung zu Bestellung 302-1234567-7654321", body, conversationId: `conv-${key}`, receivedAt: new Date() });

  async function setup(mode: "draft" | "send") {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort kam im Käuferpostfach an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    await updateWorkspaceSettings(h.ctx, s.owner, { autoInvoice: mode });
    return { h, s };
  }

  it("sends the invoice on its own when the customer asks for it and nothing speaks against it", async () => {
    const { h, s } = await setup("send");
    ask(h, "Hallo, können Sie mir bitte die Rechnung zu meiner Bestellung 302-1234567-7654321 schicken? Danke", "auto1");
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-auto1");
    const outbox = await one<{ state: string; document_ids: string[] }>(h.ctx.db, "SELECT state, document_ids FROM outbox WHERE conversation_id = $1", [conv.id]);
    assert.ok(outbox, "queued");
    assert.equal(outbox!.document_ids.length, 1);
    const sent = h.graph.replies.at(-1)!;
    assert.deepEqual(sent.attachments.map((a) => a.name), ["Rechnung RE-9001.pdf"]);
    const view = await getCase(h.ctx, s.agent, conv.id);
    assert.match(String(view.approvals[0]?.approved_by), /automatisch \(invoice-v1\)/);
  });

  it("only prepares it when the customer names an address, and says why", async () => {
    const { h, s } = await setup("send");
    ask(h, "Bitte übersenden Sie die Rechnung zu Bestellung 302-1234567-7654321 an folgende Mail Adresse: max. muster(at) example .de", "auto2");
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-auto2");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM outbox WHERE conversation_id = $1", [conv.id]), null);
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.ok(draft.issues.some((i) => i.code === "RECIPIENT_IN_TEXT"));
    const row = await one<{ last_error: string }>(h.ctx.db, "SELECT last_error FROM conversations WHERE id = $1", [conv.id]);
    assert.match(row!.last_error, /nicht automatisch gesendet: der Kunde nennt eine eigene Mailadresse/);
  });

  it("in 'draft' mode prepares without sending; complaints and old mail are left alone", async () => {
    const { h, s } = await setup("draft");
    ask(h, "Bitte schicken Sie mir die Rechnung zu 302-1234567-7654321.", "auto3");
    ask(h, "Die Rechnung zu 302-1234567-7654321 ist falsch, bitte korrigieren.", "auto4");
    await syncAndDrain(h, s);
    const prepared = await caseByThread(h, s, "conv-auto3");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM outbox WHERE conversation_id = $1", [prepared.id]), null);
    const d = await one<{ decision: string; document_ids: string[] }>(h.ctx.db, "SELECT decision, document_ids FROM drafts WHERE conversation_id = $1 AND status IN ('proposed','edited')", [prepared.id]);
    assert.equal(d!.decision, "invoice");
    assert.equal(d!.document_ids.length, 1);
    const complaint = await caseByThread(h, s, "conv-auto4");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM drafts WHERE conversation_id = $1 AND decision = 'invoice'", [complaint.id]), null);
  });

  it("is off by default and ignores messages from before it was switched on", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    ask(h, "Bitte schicken Sie mir die Rechnung zu 302-1234567-7654321.", "auto5");
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-auto5");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM drafts WHERE conversation_id = $1 AND decision = 'invoice'", [conv.id]), null);
    await updateWorkspaceSettings(h.ctx, s.owner, { autoInvoice: "draft" });
    assert.equal(await autoInvoice(h.ctx, s.workspaceId, conv.id), "skipped");
  });
});

describe("Rechnung herunterladen und anhaken", () => {
  it("keeps the invoice with the case once, and it can be ticked as attachment of the reply", async () => {
    const { h, s, conv } = await amazonCase();
    const first = await fetchCaseInvoices(h.ctx, s.agent, conv.id);
    const again = await fetchCaseInvoices(h.ctx, s.agent, conv.id);
    assert.equal(first.files.length, 1);
    assert.equal(again.files[0]!.id, first.files[0]!.id, "the same document is not stored twice");
    await rejectsWith(fetchCaseInvoices(h.ctx, s.viewer, conv.id), "FORBIDDEN");
    const draft = (await currentDraft(h, s, conv.id))!;
    const { version } = await setDraftDocuments(h.ctx, s.agent, draft.id, { documentIds: [first.files[0]!.id], expectedVersion: draft.version });
    assert.equal(version, draft.version + 1);
    assert.equal(h.graph.replies.length, 0, "nothing sent");
  });
});

describe("Klärung nötig", () => {
  it("list and counter agree, done cases are not in it", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const list = await listCases(h.ctx, s.agent, "needs_attention");
    assert.ok(list.length > 0);
    assert.equal((await caseCounts(h.ctx, s.agent))!.needs_attention, list.length);
    await setStatus(h.ctx, s.agent, (list[0] as { id: string }).id, "closed");
    const after = await listCases(h.ctx, s.agent, "needs_attention");
    assert.equal(after.length, list.length - 1);
    assert.equal((await caseCounts(h.ctx, s.agent))!.needs_attention, after.length);
  });
});
