import { OWN_COPY_REASON, ownCopyText } from "../core/category.ts";
import type { OrderRecord } from "../core/contracts.ts";
import { customerText } from "../core/customer-text.ts";
import { RETURN_STATUS_DE, returnSummary } from "../core/returns.ts";
import { formatMoney, returnCheck } from "../core/return-check.ts";
import { renderPdf, type PdfBlock } from "../core/simple-pdf.ts";
import { trackingHref } from "../core/tracking.ts";
import { many, one } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

const PLATFORM: Record<string, string> = { email: "E-Mail", amazon: "Amazon", ebay: "eBay", kaufland: "Kaufland", shop_apotheke: "Shop Apotheke", docmorris: "DocMorris", shopify: "Shopify" };
const when = (iso: string | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";

/**
 * Evidence for a marketplace claim (Amazon A-bis-z, eBay "nicht erhalten" or "nicht wie
 * beschrieben"): order, shipments with tracking, invoices and the whole conversation,
 * as one PDF from the stored case data. Nothing is fetched and nothing is sent.
 */
export async function evidencePdf(ctx: AppContext, actor: Actor, conversationId: string): Promise<{ name: string; data: Buffer }> {
  requireRole(actor, ["owner", "agent"]);
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const ws = actor.workspaceId;
  const conv = await one<{ subject: string; source_platform: string; customer_name: string | null; customer_address: string | null; created_at: Date; workspace_name: string }>(
    ctx.db, "SELECT c.subject, c.source_platform, c.customer_name, c.customer_address, c.created_at, w.name AS workspace_name FROM conversations c JOIN workspaces w ON w.id = c.workspace_id WHERE c.workspace_id = $1 AND c.id = $2", [ws, conversationId],
  );
  if (!conv) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const link = await one<{ status: string; snapshot: OrderRecord | null; retrieved_at: Date | null }>(
    ctx.db, "SELECT status, snapshot, retrieved_at FROM order_links WHERE workspace_id = $1 AND conversation_id = $2 AND is_current", [ws, conversationId],
  );
  const messages = await many<{ direction: string; kind: string; from_address: string | null; from_name: string | null; subject: string; body_text: string; received_at: Date; has_attachments: boolean }>(
    ctx.db, "SELECT direction, kind, from_address, from_name, subject, body_text, received_at, has_attachments FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND kind <> 'echo' ORDER BY received_at", [ws, conversationId],
  );
  // Replies written in Seller Central: Amazon's copy lands as its own case.
  const ownCopies = await many<{ body_text: string; received_at: Date }>(
    ctx.db,
    `SELECT m.body_text, m.received_at FROM conversations o JOIN messages m ON m.workspace_id = o.workspace_id AND m.conversation_id = o.id
      WHERE o.workspace_id = $1 AND o.category_reason = $2 AND o.id <> $3
        AND ((o.customer_address IS NOT NULL AND o.customer_address = (SELECT customer_address FROM conversations WHERE id = $3))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.order_references) a, jsonb_array_elements((SELECT order_references FROM conversations WHERE id = $3)) b WHERE a->>'value' = b->>'value'))`,
    [ws, OWN_COPY_REASON, conversationId],
  );
  const sent = await many<{ dispatched_at: Date | null; created_at: Date; body: string; files: string[] | null }>(
    ctx.db,
    `SELECT o.dispatched_at, o.created_at, d.body, (SELECT array_agg(f.name) FROM documents f WHERE f.workspace_id = o.workspace_id AND f.id = ANY(o.document_ids)) AS files
       FROM outbox o JOIN drafts d ON d.id = o.draft_id
      WHERE o.workspace_id = $1 AND o.conversation_id = $2 AND o.state IN ('provider_accepted','confirmed') ORDER BY o.created_at`,
    [ws, conversationId],
  );

  const b: PdfBlock[] = [];
  const kv = (label: string, value: string | null | undefined) => { if (value) b.push({ kind: "text", text: `${label}: ${value}` }); };
  b.push({ kind: "title", text: `Nachweis zum Kundenfall: ${conv.subject || "(ohne Betreff)"}` });
  b.push({ kind: "text", text: `${conv.workspace_name} · erstellt ${when(new Date())} mit SupportX`, muted: true });
  b.push({ kind: "space" });
  kv("Kanal", PLATFORM[conv.source_platform] ?? conv.source_platform);
  kv("Kunde", [conv.customer_name, conv.customer_address].filter(Boolean).join(", "));
  kv("Fall angelegt", when(conv.created_at));

  const order = link?.status === "unique" ? link.snapshot : null;
  b.push({ kind: "heading", text: "Bestellung" });
  if (!order) b.push({ kind: "text", text: "Keine eindeutig zugeordnete Bestellung." });
  else {
    kv("Bestellnummer (Marktplatz)", order.orderNumberAtCustomer);
    kv("Auftrag in weclapp", order.orderNumber);
    kv("Bestelldatum", order.orderDate ? when(order.orderDate) : null);
    kv("Auftragsstatus", order.status);
    for (const l of order.lines) {
      b.push({ kind: "text", text: `• ${l.quantity} × ${l.title}${l.articleNumber ? ` (Artikel ${l.articleNumber})` : ""}${l.shippedQuantity !== undefined ? `, versendet ${l.shippedQuantity}` : ""}${l.returnedQuantity ? `, retourniert ${l.returnedQuantity}` : ""}` });
    }
    b.push({ kind: "heading", text: "Versand" });
    if (order.shipments.length === 0) b.push({ kind: "text", text: "Keine Lieferung in weclapp." });
    for (const s of order.shipments) {
      b.push({ kind: "text", text: `Lieferschein ${s.shipmentNumber ?? s.id}${s.erpStatus ? ` · Status ${s.erpStatus}` : ""}` });
      kv("  Versanddatum", s.shippingDate ? when(s.shippingDate) : null);
      kv("  Lieferdatum", s.deliveryDate ? when(s.deliveryDate) : null);
      if (s.statusHistory.length) kv("  Statusverlauf", s.statusHistory.map((h) => `${h.status}${h.at ? ` (${when(h.at)})` : ""}`).join(" › "));
      if (s.items.length) kv("  Inhalt", s.items.map((i) => `${i.quantity} × ${i.title ?? "Position"}`).join(", "));
      for (const p of s.parcels) {
        const href = p.trackingUrl ? trackingHref(p.trackingUrl, p.trackingId) : null;
        b.push({ kind: "text", text: `  Paket: Sendungsnummer ${p.trackingId ?? "–"}${p.carrierId ? `, Versanddienst ${p.carrierId}` : ""}${href ? `, ${href}` : ""}` });
      }
    }
    const rs = returnSummary(order);
    b.push({ kind: "heading", text: "Retoure" });
    b.push({ kind: "text", text: `${rs.label}. ${rs.advice}` });
    for (const r of rs.returns) {
      b.push({ kind: "text", text: `Retoure ${r.returnNumber ?? r.id}${r.erpStatus ? ` · ${RETURN_STATUS_DE[r.erpStatus] ?? r.erpStatus}` : ""}${r.erpStatusAt ? ` (${when(r.erpStatusAt)})` : ""}` });
      if (r.items.length) kv("  Inhalt", r.items.map((i) => `${i.quantity} × ${i.title ?? "Position"}${i.reason ? ` (Grund: ${i.reason})` : ""}`).join(", "));
    }
    const check = returnCheck(order);
    if (check.applicable) {
      b.push({ kind: "text", text: `Retourenprüfung: ${check.receivedUnits} von ${check.baseUnits} Stück zurück.` });
      for (const l of check.lines) {
        b.push({ kind: "text", text: `  ${l.title}: bestellt ${l.ordered}, versendet ${l.shipped ?? "unbekannt"}, eingegangen ${l.received}${l.announced ? `, angemeldet ${l.announced}` : ""}` });
      }
      if (check.amounts) {
        const m = (n: number) => formatMoney(n, check.amounts!.currency);
        kv("  Beträge (brutto)", `Ware zurück ${m(check.amounts.goods)}, Versandkosten ${m(check.amounts.shipping)}, passend ${m(check.amounts.expected)}, Bestellung ${m(check.amounts.maximum)}${check.amounts.credited ? `, Gutschrift ${m(check.amounts.credited)}` : ""}`);
      }
      for (const f of check.findings) b.push({ kind: "text", text: `  ${f.tone === "bad" ? "Achtung: " : ""}${f.text}` });
    }
    if (order.invoices.length) {
      b.push({ kind: "heading", text: "Rechnungen" });
      for (const i of order.invoices) b.push({ kind: "text", text: `${i.type === "CREDIT_NOTE" ? "Gutschrift" : "Rechnung"} ${i.invoiceNumber ?? i.id}${i.invoiceDate ? ` vom ${when(i.invoiceDate)}` : ""}${i.paymentStatus ? ` · ${i.paymentStatus}` : ""}` });
    }
    b.push({ kind: "text", text: `Daten aus weclapp, abgerufen ${when(link?.retrieved_at ?? order.retrievedAt)}. Der Status ist eine Buchung in weclapp, kein Scan des Versanddienstes.`, muted: true });
  }

  b.push({ kind: "heading", text: "Verlauf" });
  type Entry = { at: Date; who: string; text: string };
  const entries: Entry[] = messages.map((m) => ({
    at: m.received_at,
    who: m.direction === "inbound" ? `Kunde${m.from_name || m.from_address ? ` (${m.from_name ?? m.from_address})` : ""}` : "Händler",
    text: (m.direction === "inbound" ? customerText(m.body_text) : m.body_text) + (m.has_attachments ? "\n[mit Anhang]" : ""),
  }));
  for (const m of ownCopies) entries.push({ at: m.received_at, who: "Händler (in Seller Central geschrieben, Kopie von Amazon)", text: ownCopyText(m.body_text) });
  // Replies sent through SupportX, in case the mailbox copy is missing.
  for (const s of sent) {
    const at = s.dispatched_at ?? s.created_at;
    if (!entries.some((e) => e.who === "Händler" && Math.abs(new Date(e.at).getTime() - new Date(at).getTime()) < 10 * 60_000)) {
      entries.push({ at, who: "Händler (über SupportX gesendet)", text: s.body + (s.files?.length ? `\n[Anhang: ${s.files.join(", ")}]` : "") });
    }
  }
  entries.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
  for (const e of entries) {
    b.push({ kind: "space" });
    b.push({ kind: "text", text: `${when(e.at)} · ${e.who}`, muted: true });
    b.push({ kind: "text", text: e.text.trim() || "(leer)" });
  }

  await audit(ctx.db, actor, "conversation.evidence_pdf", "conversation", conversationId, {});
  const ref = order?.orderNumberAtCustomer ?? order?.orderNumber ?? conversationId.slice(0, 8);
  return { name: `Nachweis ${ref}.pdf`.replace(/[\\/]/g, "-"), data: renderPdf(b, `Nachweis ${ref}`) };
}
