import type { InvoiceFact, OrderRecord } from "../core/contracts.ts";
import { detectRisks, newestEmailText } from "../core/classify.ts";
import { asksForInvoice } from "../core/invoice-request.ts";
import { checkDraft, type DraftIssue } from "../core/draft-check.ts";
import { buildOrderFacts } from "../core/facts.ts";
import { createHash } from "node:crypto";
import { one, withTx, type Tx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { loadErpConnection, orderProviderFor, type ChannelKind } from "./connections.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";
import { applyDraftDocuments, MAX_DOCUMENT_BYTES, MAX_REPLY_DOCUMENTS, REPLY_FILES, storeCaseFile, type CaseFileInfo } from "./documents.ts";
import { ALL_ORDERS } from "./matching.ts";
import { approveByRule, queueReply, sendBlockers } from "./replies.ts";

const UUID = /^[0-9a-f-]{36}$/i;

/** An address in the customer's text, also written as "name(at)domain .de". */
const ADDRESS_IN_TEXT = /[\p{L}\p{N}._%+-]+\s*(?:@|\(at\)|\[at\]|\{at\})\s*[\p{L}\p{N}-]+(?:\s*\.\s*[\p{L}\p{N}-]+)*\s*\.\s*\p{L}{2,}/iu;

/** Invoices that can go to the customer: no credit notes, nothing cancelled; newest first. */
export function sendableInvoices(order: OrderRecord): InvoiceFact[] {
  return order.invoices
    .filter((inv) => inv.type !== "CREDIT_NOTE" && inv.status !== "CANCELLED")
    .sort((a, b) => (b.invoiceDate ?? "").localeCompare(a.invoiceDate ?? ""));
}

const ROUTE_LABEL: Record<ChannelKind, string> = {
  microsoft_graph: "als Antwort auf die Mail des Kunden (bei Amazon über die Amazon-Käufernachricht)",
  kaufland_tickets: "im Kaufland-Ticket",
  mirakl_inbox: "in der Nachricht bei Shop Apotheke",
  ebay_messages: "als eBay-Nachricht",
};

function replyText(lang: string, invoiceNumbers: string[], orderNumber: string, attached: boolean, signature: string): string {
  const en = lang.toLowerCase().startsWith("en");
  const list = invoiceNumbers.length > 1 ? `${invoiceNumbers.slice(0, -1).join(", ")} ${en ? "and" : "und"} ${invoiceNumbers.at(-1)}` : invoiceNumbers[0]!;
  const plural = invoiceNumbers.length > 1;
  const middle = en
    ? attached
      ? `Thank you for your message. Please find attached ${plural ? "the invoices" : "the invoice"} ${list} for your order ${orderNumber} as PDF.`
      : `Thank you for your message. ${plural ? "The invoices" : "The invoice"} ${list} for your order ${orderNumber} will be provided to you with the order on the marketplace.`
    : attached
      ? `vielen Dank für Ihre Nachricht. Anbei erhalten Sie ${plural ? "die Rechnungen" : "die Rechnung"} ${list} zu Ihrer Bestellung ${orderNumber} als PDF.`
      : `vielen Dank für Ihre Nachricht. ${plural ? "Die Rechnungen" : "Die Rechnung"} ${list} zu Ihrer Bestellung ${orderNumber} stellen wir Ihnen bei der Bestellung im Marktplatz bereit.`;
  return [en ? "Hello," : "Guten Tag,", "", middle, "", signature].join("\n");
}

interface InvoicePdfs {
  linkId: string;
  order: OrderRecord;
  orderNumber: string;
  invoices: InvoiceFact[];
  pdfs: Array<{ invoice: InvoiceFact; data: Buffer }>;
}

/** Fresh from weclapp (read only): the sendable invoices of the case's linked order and their PDFs. */
async function loadInvoicePdfs(ctx: AppContext, actor: Actor, conversationId: string): Promise<InvoicePdfs> {
  const link = await one<{ id: string; status: string; snapshot: OrderRecord | null }>(ctx.db, "SELECT id, status, snapshot FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [actor.workspaceId, conversationId]);
  if (!link || link.status !== "unique" || !link.snapshot) {
    const why = link?.status === "ambiguous" ? "Es passen mehrere Bestellungen." : link?.status === "pending" ? "Die Bestellung wird noch gesucht." : "Es ist keine Bestellung zugeordnet.";
    throw new ServiceError(409, "ORDER_NOT_UNIQUE", `${why} Bitte erst rechts unter „Bestellung in weclapp“ die richtige Bestellung zuordnen. Es wurde nichts verschickt.`);
  }
  const erp = await loadErpConnection(ctx.db, actor.workspaceId);
  if (!erp) throw new ServiceError(409, "NO_ERP", "Keine weclapp-Verbindung eingerichtet.");
  const provider = await orderProviderFor(ctx, ctx.db, erp);
  if (!provider.downloadInvoicePdf) throw new ServiceError(409, "NOT_SUPPORTED", "Diese Warenwirtschaft liefert keine Rechnungs-PDFs.");

  // Fresh from the ERP: the invoice may have been written after the case was matched.
  const fresh = await provider.getOrder(link.snapshot.id, ALL_ORDERS);
  if (fresh.status === "error") throw new ServiceError(502, "ERP_ERROR", `weclapp ist gerade nicht erreichbar: ${fresh.error}`);
  if (fresh.status !== "unique") throw new ServiceError(409, "ORDER_NOT_UNIQUE", "Die zugeordnete Bestellung ist in weclapp nicht mehr zu finden. Bitte die Zuordnung prüfen. Es wurde nichts verschickt.");
  const order = fresh.order;
  const orderNumber = order.orderNumberAtCustomer ?? order.orderNumber ?? order.id;
  const invoices = sendableInvoices(order);
  if (invoices.length === 0) {
    throw new ServiceError(409, "NO_INVOICE", `Zu Bestellung ${orderNumber} gibt es in weclapp noch keine Rechnung (Gutschriften und stornierte Rechnungen zählen nicht). Bitte die Rechnung in weclapp erstellen und dann erneut klicken.`);
  }
  if (invoices.length > MAX_REPLY_DOCUMENTS) {
    throw new ServiceError(409, "TOO_MANY", `Zu Bestellung ${orderNumber} gibt es ${invoices.length} Rechnungen, höchstens ${MAX_REPLY_DOCUMENTS} passen in eine Antwort. Bitte die passenden in weclapp herunterladen und unter „Datei anhängen“ selbst anhängen.`);
  }
  const pdfs: InvoicePdfs["pdfs"] = [];
  for (const invoice of invoices) {
    const label = invoice.invoiceNumber ?? invoice.id;
    let file: { data: Buffer; contentType: string };
    try {
      file = await provider.downloadInvoicePdf(invoice.id);
    } catch (error) {
      throw new ServiceError(502, "NO_PDF", `weclapp liefert für Rechnung ${label} kein PDF (${(error as Error).message}). Bitte in weclapp prüfen, ob das Rechnungsdokument erstellt ist. Es wurde nichts verschickt.`);
    }
    if (file.data.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new ServiceError(502, "NO_PDF", `weclapp liefert für Rechnung ${label} keine PDF-Datei. Bitte in weclapp prüfen, ob das Rechnungsdokument erstellt ist. Es wurde nichts verschickt.`);
    }
    pdfs.push({ invoice, data: file.data });
  }
  if (pdfs.reduce((sum, p) => sum + p.data.length, 0) > MAX_DOCUMENT_BYTES) {
    throw new ServiceError(413, "TOO_LARGE", "Die Rechnungs-PDF ist zu groß für eine Antwort (höchstens 3 MB). Bitte in weclapp prüfen. Es wurde nichts verschickt.");
  }
  return { linkId: link.id, order, orderNumber, invoices, pdfs };
}

/** Store the PDFs with the case; the same document fetched again is reused, not stored twice. */
async function storeInvoices(tx: Tx, actor: Actor, conversationId: string, loaded: InvoicePdfs): Promise<CaseFileInfo[]> {
  // The panel shows what was just read from weclapp.
  await tx.query("UPDATE order_links SET snapshot = $3, retrieved_at = now() WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, loaded.linkId, JSON.stringify(loaded.order)]);
  const files: CaseFileInfo[] = [];
  for (const { invoice, data } of loaded.pdfs) {
    const same = await one<CaseFileInfo>(
      tx,
      `SELECT id, name, size, content_type, source, created_at FROM documents
        WHERE workspace_id = $1 AND conversation_id = $2 AND source = 'erp_invoice' AND external_ref = $3 AND sha256 = $4 AND deleted_at IS NULL`,
      [actor.workspaceId, conversationId, invoice.id, createHash("sha256").update(data).digest("hex")],
    );
    files.push(same ?? (await storeCaseFile(tx, actor, conversationId, { name: `Rechnung ${invoice.invoiceNumber ?? invoice.id}.pdf`.replace(/[\\/]/g, "-"), contentType: "application/pdf", data, source: "erp_invoice", externalRef: invoice.id })));
  }
  return files;
}

/**
 * "Rechnung herunterladen": fetch the invoice PDF(s) of the linked order from weclapp
 * and keep them with the case, for download and to tick as attachment. Sends nothing.
 */
export async function fetchCaseInvoices(ctx: AppContext, actor: Actor, conversationId: string): Promise<{ files: CaseFileInfo[] }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const conv = await one(ctx.db, "SELECT 1 FROM conversations WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conversationId]);
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const loaded = await loadInvoicePdfs(ctx, actor, conversationId);
  return { files: await withTx(ctx.db, (tx) => storeInvoices(tx, actor, conversationId, loaded)) };
}

/**
 * "Rechnung senden": a person clicked it (or the workspace's invoice rule). The invoice
 * documents of the linked order are fetched from the ERP (read only), stored with the
 * case and attached to a new draft from a fixed template (no AI cost). Nothing is sent:
 * the draft goes through the normal check, approval and send click, and only over the
 * case's own route. An address the customer names in the text is never used as recipient.
 */
export async function draftInvoiceReply(ctx: AppContext, actor: Actor, conversationId: string): Promise<{ draftId: string; files: CaseFileInfo[]; attached: boolean }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const conv = await one<{ id: string; version: number; latest_inbound_message_id: string | null; order_match_status: string; source_platform: string; kind: ChannelKind }>(
    ctx.db,
    `SELECT c.id, c.version, c.latest_inbound_message_id, c.order_match_status, c.source_platform, cc.kind FROM conversations c
       JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id
      WHERE c.workspace_id = $1 AND c.id = $2`,
    [actor.workspaceId, conversationId],
  );
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  if (!conv.latest_inbound_message_id) throw new ServiceError(409, "NO_MESSAGE", "In diesem Fall gibt es keine Kundennachricht zum Beantworten.");
  const loaded = await loadInvoicePdfs(ctx, actor, conversationId);
  const { order, orderNumber, invoices } = loaded;

  const ws = (await one<{ reply_signature: string; default_language: string; allowed_link_prefixes: string[] }>(ctx.db, "SELECT reply_signature, default_language, allowed_link_prefixes FROM workspaces WHERE id = $1", [actor.workspaceId]))!;
  const attached = REPLY_FILES[conv.kind].supported;
  const facts = buildOrderFacts(order);
  const invoiceFactIds = facts.filter((f) => /^invoice\.\d+$/.test(f.id) && invoices.some((inv) => f.text.includes(inv.invoiceNumber ?? inv.id))).map((f) => f.id);
  const body = replyText(ws.default_language, invoices.map((inv) => inv.invoiceNumber ?? inv.id), orderNumber, attached, ws.reply_signature);
  const citedFactIds = ["order", ...invoiceFactIds].filter((id) => facts.some((f) => f.id === id));
  const issues: DraftIssue[] = checkDraft({ text: body, citedFactIds, facts, order, orderStatus: "unique", allowedLinkPrefixes: ws.allowed_link_prefixes, sourcePlatform: conv.source_platform });

  const latest = await one<{ body_text: string }>(ctx.db, "SELECT body_text FROM messages WHERE workspace_id = $1 AND id = $2", [actor.workspaceId, conv.latest_inbound_message_id]);
  if (ADDRESS_IN_TEXT.test(newestEmailText(latest?.body_text ?? ""))) {
    issues.push({
      severity: "warn",
      code: "RECIPIENT_IN_TEXT",
      message: `Der Kunde nennt im Text eine Mailadresse. Die Rechnung geht trotzdem nur ${ROUTE_LABEL[conv.kind]}, nie an eine Adresse aus dem Kundentext: Die Rechnung enthält Name und Anschrift, und die Adresse ist nicht geprüft. Soll sie wirklich woanders hin, bitte außerhalb von SupportX prüfen und selbst senden.`,
    });
  }
  if (!attached) {
    issues.push({ severity: "warn", code: "FILES_NOT_SUPPORTED", message: `${REPLY_FILES[conv.kind].note} Die Rechnung liegt unten zum Herunterladen bereit.` });
  }

  return withTx(ctx.db, async (tx) => {
    const locked = await one<{ version: number; latest_inbound_message_id: string | null }>(tx, "SELECT version, latest_inbound_message_id FROM conversations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [actor.workspaceId, conversationId]);
    if (!locked || locked.latest_inbound_message_id !== conv.latest_inbound_message_id) throw new ServiceError(409, "VERSION_CONFLICT", "Inzwischen ist eine neue Kundennachricht da. Bitte neu laden.");
    const files = await storeInvoices(tx, actor, conversationId, loaded);
    await tx.query("UPDATE drafts SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND conversation_id = $2 AND status IN ('proposed','edited')", [actor.workspaceId, conversationId]);
    const draft = await one<{ id: string; version: number }>(
      tx,
      `INSERT INTO drafts (workspace_id, conversation_id, based_on_conversation_version, inbound_message_id, order_link_id, intent, summary, body,
         cited_fact_ids, facts, missing_information, suggested_actions, risks, issues, generated_by, ai_model, prompt_version, decision)
       VALUES ($1,$2,$3,$4,$5,'invoice',$6,$7,$8,$9,'[]','["none"]','{}',$10,'rules',NULL,'invoice-v1','invoice') RETURNING id, version`,
      [
        actor.workspaceId, conversationId, locked.version, conv.latest_inbound_message_id, loaded.linkId,
        `Rechnung aus weclapp: ${files.map((f) => f.name).join(", ")}.`, body, citedFactIds, JSON.stringify(facts), JSON.stringify(issues),
      ],
    );
    await audit(tx, actor, "draft.invoice", "draft", draft!.id, { invoices: invoices.map((i) => i.invoiceNumber ?? i.id), attached });
    if (attached) await applyDraftDocuments(tx, actor, draft!.id, files.map((f) => f.id), draft!.version);
    return { draftId: draft!.id, files, attached };
  });
}

/** For the case view: which invoices could be sent, without fetching anything. */
export function invoiceSummary(order: OrderRecord | null): string[] {
  return order ? sendableInvoices(order).map((inv) => inv.invoiceNumber ?? inv.id) : [];
}

const AUTO_RULE = "invoice-v1";

/**
 * After a new customer message is matched: if the workspace switched it on and the
 * customer asks to be sent an invoice, prepare the invoice reply on its own (fixed
 * template, PDF from weclapp, no AI cost). With "send" it goes out only when nothing
 * needs a person: unique order, exactly the invoice(s) found, the channel takes files,
 * no warning (e.g. an address in the text, health topic), and every send check passes.
 * Otherwise the prepared draft waits for a person, and the case says why.
 */
export async function autoInvoice(ctx: AppContext, workspaceId: string, conversationId: string): Promise<"off" | "skipped" | "drafted" | "sent" | "failed"> {
  const ws = await one<{ auto_invoice: "off" | "draft" | "send"; auto_invoice_since: Date | null }>(ctx.db, "SELECT auto_invoice, auto_invoice_since FROM workspaces WHERE id = $1", [workspaceId]);
  if (!ws || ws.auto_invoice === "off" || !ws.auto_invoice_since) return "off";
  const conv = await one<{ category: string; status: string; order_match_status: string; latest_inbound_message_id: string | null }>(
    ctx.db,
    "SELECT category, status, order_match_status, latest_inbound_message_id FROM conversations WHERE workspace_id = $1 AND id = $2",
    [workspaceId, conversationId],
  );
  if (!conv?.latest_inbound_message_id || conv.category !== "support" || conv.status === "closed") return "skipped";
  const msg = await one<{ body_text: string; kind: string; received_at: Date }>(ctx.db, "SELECT body_text, kind, received_at FROM messages WHERE workspace_id = $1 AND id = $2", [workspaceId, conv.latest_inbound_message_id]);
  if (!msg || msg.received_at < ws.auto_invoice_since) return "skipped";
  if (msg.kind !== "customer" || !asksForInvoice(newestEmailText(msg.body_text))) return "skipped";
  // Once per customer message, and never over a reply a person is already working on.
  const existing = await one(ctx.db, "SELECT 1 FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 AND inbound_message_id = $3", [workspaceId, conversationId, conv.latest_inbound_message_id]);
  if (existing) return "skipped";

  const worker: Actor = { type: "worker", workspaceId };
  const note = (text: string) => ctx.db.query("UPDATE conversations SET last_error = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId, text]);
  let result: Awaited<ReturnType<typeof draftInvoiceReply>>;
  try {
    result = await draftInvoiceReply(ctx, worker, conversationId);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    await note(`Kunde fragt nach der Rechnung, automatisch nicht möglich: ${error.message}`);
    await audit(ctx.db, worker, "invoice.auto_failed", "conversation", conversationId, { code: error.code });
    return "failed";
  }
  if (ws.auto_invoice === "draft") return "drafted";

  const draft = await one<{ issues: DraftIssue[] }>(ctx.db, "SELECT issues FROM drafts WHERE workspace_id = $1 AND id = $2", [workspaceId, result.draftId]);
  const reasons: string[] = [];
  if (!result.attached) reasons.push("dieser Kanal nimmt keine Dateien an");
  if (detectRisks(newestEmailText(msg.body_text)).length > 0) reasons.push("die Nachricht enthält ein heikles Thema");
  for (const issue of draft?.issues ?? []) reasons.push(issue.code === "RECIPIENT_IN_TEXT" ? "der Kunde nennt eine eigene Mailadresse" : issue.message);
  if (reasons.length === 0) {
    const blockers = await sendBlockers(ctx, ctx.db, workspaceId, conversationId);
    if (!blockers.allowed) reasons.push(...blockers.blockers);
  }
  if (reasons.length > 0) {
    await note(`Rechnung angehängt, nicht automatisch gesendet: ${reasons.join("; ")}. Bitte prüfen und selbst senden.`);
    return "drafted";
  }
  const approvalId = await approveByRule(ctx, workspaceId, result.draftId, AUTO_RULE);
  await queueReply(ctx, worker, approvalId);
  await ctx.db.query("UPDATE conversations SET last_error = NULL WHERE workspace_id = $1 AND id = $2", [workspaceId, conversationId]);
  return "sent";
}
