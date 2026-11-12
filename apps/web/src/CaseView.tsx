import { useCallback, useEffect, useRef, useState } from "react";
import { orderLinks, type OrderLink } from "./order-links.ts";
import { checkSubjectPattern, subjectPattern } from "../../../packages/core/subject-pattern.ts";
import { api, fmtDate, MATCH_LABEL, OUTBOX_LABEL, PLATFORM_LABEL } from "./api.ts";
import { INTENT_LABEL } from "./Inbox.tsx";
import { sendNotice, type SendInfo } from "./send-notice.ts";
import { customerText, shortText } from "../../../packages/core/customer-text.ts";
import { trackingHref } from "../../../packages/core/tracking.ts";
import { deadlineState } from "../../../packages/core/deadline.ts";
import { formatKg, weightChecks, WEIGHT_SOURCE_NOTE } from "../../../packages/core/weight-check.ts";
import { buildTimeline } from "../../../packages/core/timeline.ts";
import { AmazonOfferCard, LISTING_STATE, listingActionText, type ListingAction } from "./AmazonOffer.tsx";
import { RETURN_STATUS_DE, returnSummary, type ReturnFact, type ReturnSummary } from "../../../packages/core/returns.ts";
import type { RefundDue } from "../../../packages/core/refund-due.ts";
import { formatMoney, type ReturnCheck } from "../../../packages/core/return-check.ts";
import { formatAmount, type RefundListItem } from "../../../packages/core/refund-list.ts";

type Role = "owner" | "agent" | "viewer";
type Rec = Record<string, unknown>;

interface Issue { severity: "block" | "warn"; code: string; message: string }
interface Fact { id: string; text: string; source: string; observedAt?: string }
interface Draft {
  id: string; version: number; status: string; intent: string; summary: string; body: string;
  cited_fact_ids: string[]; facts: Fact[]; missing_information: string[]; suggested_actions: string[]; risks: string[];
  issues: Issue[]; decision: string | null; document_ids?: string[]; generated_by: string; ai_model: string | null; prompt_version: string | null; created_at: string; updated_at: string;
}
interface Parcel { id?: string; trackingId?: string; trackingUrl?: string; carrierId?: string; source: string; weightKg?: number }
interface Shipment {
  id: string; shipmentNumber?: string; erpStatus?: string; erpStatusAt?: string; shippingDate?: string; deliveryDate?: string;
  items: Array<{ orderLineId?: string; title?: string; quantity: number }>; parcels: Parcel[]; returnLabels?: number; weightKg?: number;
}
interface OrderSnapshot {
  id: string; orderNumber?: string; orderNumberAtCustomer?: string; orderDate?: string; status?: string; salesChannel?: string;
  lines: Array<{ id: string; title: string; articleNumber?: string; quantity: number; shippedQuantity?: number; returnedQuantity?: number; grossWeightKg?: number; netWeightKg?: number }>;
  shipments: Shipment[];
  invoices: Array<{ id: string; invoiceNumber?: string; invoiceDate?: string; status?: string; paymentStatus?: string; type?: string }>;
  returns?: ReturnFact[];
  returnsError?: string;
  weightsRead?: boolean;
  retrievedAt: string;
}

const TONE_CLASS: Record<ReturnSummary["tone"], string> = { good: "ok", warn: "warn", bad: "bad", neutral: "" };
const returnsOf = (order: OrderSnapshot) => returnSummary(order);
interface CaseData {
  linkTargets?: { erp_base_url: string | null; mirakl_base_url: string | null } | null;
  conversation: Rec & { topic: string | null; topic_source: string | null; waiting_since: string | null; reply_hours: number | null; snooze_until: string | null; outcome: string | null; outcome_note: string | null; outcome_at: string | null; id: string; subject: string; status: string; category: "support" | "info"; category_reason: string | null; customer_address: string | null; source_platform: string; order_match_status: string; merchant_account_id: string | null; merchant_account_name: string | null; connection_name: string; assignee_user_id: string | null; last_error: string | null; order_references: string[] };
  messages: Array<{ id: string; direction: string; kind: string; outbox_id?: string | null; from_address: string; from_name: string | null; reply_to: Array<{ address: string; name?: string }> | null; subject: string; body_text: string; received_at: string; has_attachments: boolean; removed_remotely_at: string | null }>;
  /** Forwards of mails of this case, sent by a person. */
  forwards?: ForwardRow[];
  /** Messages of other cases of the same customer or order, for context. */
  customerHistory?: { cases: HistoryCase[]; counts: { cases: number; refunds: number; replacements: number; returns: number } };
  relatedMessages?: Array<CaseData["messages"][number] & { conversation_id: string; conversation_subject: string }>;
  notes: Array<{ id: string; body: string; created_at: string; author: string }>;
  orderLink: null | { status: string; references_tried: string[]; candidates: Array<{ id: string; orderNumber?: string; matchedBy: string }>; external_order_id: string | null; matched_by: string | null; linked_by: string; error: string | null; snapshot: OrderSnapshot | null; retrieved_at: string | null };
  drafts: Draft[];
  approvals: Array<{ id: string; draft_id: string; draft_version: number; approved_at: string; expires_at: string; invalidated_at: string | null; invalidation_reason: string | null; approved_by: string }>;
  outbox: Array<{ id: string; draft_id: string; state: string; body: string; attempts: number; last_error: string | null; expected_recipient: string; dispatched_at: string | null; created_at: string; updated_at: string }>;
  history: Array<{ action: string; actor_type: string; details: Rec; created_at: string }>;
  accounts: Array<{ id: string; name: string; platform: string }>;
  members: Array<{ id: string; display_name: string }>;
  send: SendInfo;
  titleHints?: string[];
  writer?: "own_key" | "installation" | "rules";
  replyFiles?: { supported: boolean; note: string };
  /** Files of this case only: uploaded for a reply or fetched from weclapp. */
  caseFiles?: CaseFile[];
  /** Invoice numbers of the linked order that can be sent. */
  invoices?: string[];
  /** Amazon offers closed (or tried) from this case. */
  listingActions?: ListingAction[];
  /** Set when the workspace has an Amazon SP-API access: the marketplaces it may change. */
  amazonListings?: { marketplaceIds: string[] } | null;
  /** Goods back in weclapp and no refund recorded yet: the refund is to be done. */
  refund?: RefundDue;
  /** Returned quantities and amounts checked against the order (null when there is nothing to check). */
  returnCheck?: ReturnCheck | null;
  /** Where the case stands on the refund list ("Erstattungen"). */
  refundList?: { state: "none" | "open" | "done"; removed: boolean; item: Pick<RefundListItem, "done" | "amount" | "kind"> | null };
}

/** Readable names for the Protokoll; unknown actions show their technical name. */
const AUDIT_LABEL: Record<string, string> = {
  "amazon.offer_close_accepted": "Amazon-Angebot deaktiviert (von Amazon angenommen)",
  "amazon.offer_close_rejected": "Amazon-Angebot deaktivieren: von Amazon abgelehnt",
  "amazon.offer_close_uncertain": "Amazon-Angebot deaktivieren: Antwort unklar",
};

const KIND_LABEL: Record<string, string> = { customer: "Kunde", echo: "unsere Antwort", manual_external: "außerhalb gesendet", platform_notice: "Systemhinweis" };
const RISK_LABEL: Record<string, string> = { health: "Gesundheitsfrage", legal: "Rechtliches", refund: "Erstattung", replacement: "Ersatz", cancellation: "Storno", delivery_disputed: "Zustellung bestritten", identity_uncertain: "Identität unklar", abusive: "beleidigend", other: "Sonstiges" };
const ACTION_LABEL: Record<string, string> = { none: "keine", ask_customer: "Kunde fragen", check_return_label: "Retourenlabel prüfen", propose_replacement: "Ersatz prüfen (eigener Ablauf)", propose_refund: "Erstattung prüfen (eigener Ablauf)", escalate: "eskalieren" };

/** Red, yellow, green: what still needs us, what waits for someone else, what is done. */
const CASE_STATUS = [
  { value: "open", label: "Offen" },
  { value: "waiting", label: "Wartet" },
  { value: "closed", label: "Erledigt" },
] as const;

type HistoryCase = { id: string; subject: string; topic: string | null; status: string; outcome: string | null; source_platform: string; last_message_at: string | null; order_number: string | null };

export function CaseView({ workspaceId, caseId, role, onChanged, onOpenCase }: { workspaceId: string; caseId: string; role: Role; onChanged: () => void; onOpenCase?: (id: string) => void }) {
  const [data, setData] = useState<CaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/w/${workspaceId}`;
  const canEdit = role !== "viewer";
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [snippets, setSnippets] = useState<SnippetInfo[]>([]);
  useEffect(() => {
    api<{ documents: DocumentInfo[] }>("GET", `${base}/documents`).then((r) => setDocuments(r.documents), () => setDocuments([]));
    api<{ snippets: SnippetInfo[] }>("GET", `${base}/snippets`).then((r) => setSnippets(r.snippets), () => setSnippets([]));
  }, [base]);

  // Who else has this case open: a heartbeat every 15 seconds, at once when writing starts or stops.
  const [editing, setEditing] = useState(false);
  // "Erledigt" asks once what was done, so a refund lands on the refund list with its amount.
  const [closing, setClosing] = useState(false);
  const [others, setOthers] = useState<Array<{ name: string; editing: boolean }>>([]);
  useEffect(() => {
    const beat = () => api<{ others: Array<{ name: string; editing: boolean }> }>("POST", `${base}/cases/${caseId}/presence`, { editing }).then((r) => setOthers(r.others), () => undefined);
    void beat();
    const timer = setInterval(beat, 15_000);
    return () => clearInterval(timer);
  }, [base, caseId, editing]);
  useEffect(() => () => { void api("DELETE", `${base}/cases/${caseId}/presence`).catch(() => undefined); }, [base, caseId]);

  const load = useCallback(async () => {
    try {
      setData(await api<CaseData>("GET", `${base}/cases/${caseId}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base, caseId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success?: string | ((result: unknown) => string)) => {
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (success) setNotice(typeof success === "function" ? success(result) : success);
      window.dispatchEvent(new Event("supportx-refunds"));
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      await load();
    }
  };

  if (!data) return <div className="center muted">{error ?? "Lädt …"}</div>;
  const c = data.conversation;
  const match = MATCH_LABEL[c.order_match_status] ?? { label: c.order_match_status, tone: "muted" as const };
  const draft = data.drafts.find((d) => d.status === "proposed" || d.status === "edited") ?? null;

  const due = deadlineState(c.waiting_since, c.reply_hours);
  const sender = data.messages.find((m) => m.direction === "inbound")?.from_address ?? c.customer_address ?? "";
  const setCategory = (category: "support" | "info", remember: Remember, pattern?: string) =>
    act(() => api("POST", `${base}/cases/${caseId}/category`, { category, remember, pattern }), (result) => {
      const moved = (result as { moved?: number }).moved ?? 0;
      const done = category === "info" ? "Als Werbung/Info eingeordnet." : "Als Kundenanfrage eingeordnet. Die Bestellung wird gesucht.";
      if (remember !== "subject") return done;
      return `${done} Regel gespeichert, gilt auch für neue Mails${moved ? `; ${moved} weitere ${moved === 1 ? "Fall" : "Fälle"} umsortiert` : ""}.`;
    });

  const timeline = buildTimeline([
    ...data.messages.map((m) => ({ ...m, from_case: null as string | null })),
    ...(data.relatedMessages ?? []).map((m) => ({ ...m, outbox_id: null, from_case: m.conversation_subject || "(ohne Betreff)" })),
  ], data.outbox);
  const resolveOutbox = (id: string, resolution: "was_sent" | "was_not_sent") => act(() => api("POST", `${base}/outbox/${id}/resolve`, { resolution }));
  const resolveForward = (id: string, action: "check" | "was_sent" | "was_not_sent") =>
    act(() => api<{ state: string }>("POST", `${base}/forwards/${id}/resolve`, { action }), (r) => (r as { state: string }).state === "confirmed" ? "Weiterleitung in „Gesendete Elemente“ gefunden." : action === "check" ? "Noch nicht in „Gesendete Elemente“ gefunden." : "Geklärt.");
  // Our actions at the marketplace, between the messages at the time they happened.
  const actionsAt = (data.listingActions ?? []).map((a) => ({ at: new Date(a.created_at).getTime(), a }));
  const messages = (
    <section className="card">
      <h3>Verlauf ({timeline.length + actionsAt.length})</h3>
      {(data.relatedMessages?.length ?? 0) > 0 && <p className="muted small">Mit Nachrichten aus anderen Fällen desselben Kunden bzw. derselben Bestellung.</p>}
      <div className="chat">
        {[
          ...timeline.map((e, i) => ({ at: new Date(e.at).getTime(), i, e, a: null })),
          ...actionsAt.map(({ at, a }, i) => ({ at, i: timeline.length + i, e: null, a })),
        ].sort((x, y) => x.at - y.at || x.i - y.i).map(({ e, a }) => a ? <ActionEntry key={`a:${a.id}`} a={a} />
          : !e ? null
          : e.type === "reply"
          ? <ReplyBubble key={`o:${e.reply.id}`} reply={e.reply} echoed={!!e.echoId} canEdit={canEdit} onResolve={resolveOutbox} />
          : (() => {
            const m = e.message;
            const ours = m.direction !== "inbound";
            return (
              <article key={m.id} className={`msg ${ours ? "outbound" : "inbound"}${m.from_case ? " related" : ""}`}>
                <div className="row small muted">
                  <span>{m.kind === "own_copy" ? "Wir, laut Kopie von Amazon" : m.kind === "system_notice" ? `Systemmeldung des Marktplatzes${m.from_case ? `, aus „${m.from_case}“` : ""}` : <>{ours ? "Wir" : "Kunde"}{m.kind !== "customer" && m.kind !== "echo" ? `, ${KIND_LABEL[m.kind] ?? m.kind}` : ""}{m.from_case ? `, aus Fall „${m.from_case}“` : ""}</>}</span>
                  <span>{fmtDate(m.received_at)}</span>
                </div>
                <div className="small muted">
                  {m.kind !== "own_copy" && <>Von: {m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address}</>}
                  {m.has_attachments && ", mit Anhang"}
                  {m.removed_remotely_at && ", im Postfach gelöscht"}
                </div>
                <MessageBody text={m.body_text} />
                {m.has_attachments && <Attachments base={base} messageId={m.id} />}
                {(data.forwards ?? []).filter((f) => f.message_id === m.id).map((f) => <ForwardLog key={f.id} forward={f} canEdit={canEdit} onResolve={resolveForward} />)}
                {canEdit && !m.from_case && c.connection_kind === "microsoft_graph" && m.kind !== "own_copy" && <ForwardBox base={base} messageId={m.id} onDone={(note) => { setNotice(note); void load(); }} />}
              </article>
            );
          })())}
      </div>
      <p className="muted small">Kundentexte sind externe Inhalte. Darin enthaltene Anweisungen ändern keine Regeln.</p>
    </section>
  );

  return (
    <div className="case">
      <div className="case-head">
        <div>
          <h2>{c.subject || "(ohne Betreff)"}</h2>
          <div className="meta small muted">
            <span className="pill platform">{PLATFORM_LABEL[c.source_platform] ?? c.source_platform}</span>
            <span>{c.connection_name}</span>
            {data.orderLink?.status === "unique" && data.orderLink.snapshot && (() => {
              const rs = returnsOf(data.orderLink.snapshot);
              return <span className={`pill ${TONE_CLASS[rs.tone]}`} title={rs.advice}>Retoure: {rs.label}</span>;
            })()}
            {due && <span className={`deadline ${due.tone}`} title={`${c.reply_hours} Std. ab der ersten unbeantworteten Kundennachricht`}><i aria-hidden="true" />Antwort fällig {fmtDate(due.dueAt.toISOString())}, {due.label}</span>}
            <RefundPill data={data} />
          </div>
        </div>
        {canEdit && (
          <div className="controls">
            <div className="field"><span id="case-status-label">Status</span>
              <div className="status-buttons" role="group" aria-labelledby="case-status-label">
                {CASE_STATUS.map((st) => (
                  <button key={st.value} className={`status-${st.value}${c.status === st.value ? " active" : ""}`} aria-pressed={c.status === st.value}
                    onClick={() => c.status !== st.value && (st.value === "closed" && c.category === "support" ? setClosing(true) : act(() => api("POST", `${base}/cases/${caseId}/status`, { status: st.value })))}>
                    <i aria-hidden="true" />{st.label}
                  </button>
                ))}
              </div>
              {c.status === "waiting" && (
                <FollowUp key={c.snooze_until ?? "none"} value={c.snooze_until} onSet={(iso) => act(() => api("POST", `${base}/cases/${caseId}/status`, { status: "waiting", snoozeUntil: iso }), iso ? "Wiedervorlage gespeichert. Der Fall kommt an dem Tag wieder unter „Anfragen“." : "Wiedervorlage entfernt.")} />
              )}
            </div>
            <label className="field"><span>Zuständig</span>
              <select value={c.assignee_user_id ?? ""} onChange={(e) => act(() => api("POST", `${base}/cases/${caseId}/assign`, { userId: e.target.value || null }))}>
                <option value="">niemand</option>
                {data.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            </label>
            {c.category === "support" && <CategoryBar category={c.category} reason={c.category_reason} sender={sender} subject={c.subject} base={base} canEdit={canEdit} onSet={setCategory} />}
          </div>
        )}
      </div>
      {others.length > 0 && (
        <p className="notice presence">
          {others.some((o) => o.editing)
            ? `${others.filter((o) => o.editing).map((o) => o.name).join(", ")} schreibt gerade an einer Antwort. Bitte absprechen, bevor du auch antwortest.`
            : `${others.map((o) => o.name).join(", ")} hat diesen Fall gerade offen.`}
        </p>
      )}
      {closing && canEdit && (
        <CloseCase key={c.outcome ?? "none"} data={data} onCancel={() => setClosing(false)}
          onClose={async (outcome, note, amount) => {
            setClosing(false);
            await act(async () => {
              if (outcome !== undefined) await api("POST", `${base}/cases/${caseId}/outcome`, { outcome, note, ...(amount !== undefined ? { amount } : {}) });
              await api("POST", `${base}/cases/${caseId}/status`, { status: "closed" });
            }, outcome === "refund" || outcome === "partial_refund" ? "Erledigt. Die Erstattung steht auf der Erstattungsliste." : "Erledigt.");
          }} />
      )}
      {error && <p className="notice bad">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}
      {c.last_error && <p className="notice bad">Letzter Fehler: {c.last_error}</p>}
      {c.category === "info" && <CategoryBar category={c.category} reason={c.category_reason} sender={sender} subject={c.subject} base={base} canEdit={canEdit} onSet={setCategory} />}

      {c.category !== "support" ? messages : (
      <div className="case-layout">
        <div className="case-main">
          <Concern data={data} draft={draft} canEdit={canEdit} onTopic={(topic) => act(() => api("POST", `${base}/cases/${caseId}/topic`, { topic }), topic ? "Anliegen gespeichert." : "Anliegen wird wieder automatisch erkannt.")} />

          {messages}

          <section className="card">
            <h3>Antwort</h3>
            {canEdit && (
              <Decision
                current={draft?.decision ?? null}
                hasDraft={!!draft}
                writer={data.writer ?? "rules"}
                pendingOrder={c.order_match_status === "pending"}
                onDecide={(decision) => act(() => api("POST", `${base}/cases/${caseId}/redraft`, { decision }), "Die Antwort wird geschrieben. Sie erscheint hier in wenigen Sekunden.")}
                invoices={data.invoices ?? []}
                orderUnique={c.order_match_status === "unique"}
                onInvoice={() => act(() => api("POST", `${base}/cases/${caseId}/invoice-reply`), data.replyFiles?.supported ? "Rechnung aus weclapp angehängt. Bitte lesen und senden." : "Rechnung aus weclapp geholt. Dieser Kanal nimmt keine Dateien an, siehe Hinweis.")}
                snippets={snippets}
                onSnippet={(snippetId) => act(() => api<{ missing: string[] }>("POST", `${base}/cases/${caseId}/snippet-reply`, { snippetId }), (r) => {
                  const missing = (r as { missing: string[] }).missing;
                  return missing.length ? `Textbaustein übernommen. Ohne Wert geblieben: ${missing.map((m) => `{${m}}`).join(", ")}. Bitte im Entwurf ausfüllen.` : "Textbaustein übernommen. Bitte lesen und senden.";
                })}
                onCompose={(instruction) => act(() => api("POST", `${base}/cases/${caseId}/compose`, { instruction }), (data.writer ?? "rules") !== "rules" ? "Ausformuliert. Bitte noch einmal lesen und dann senden." : "Als Antwort übernommen. Bitte noch einmal lesen und dann senden.")}
              />
            )}
            {!draft ? null : (
              <DraftEditor
                key={`${draft.id}:${draft.version}`}
                draft={draft}
                snippets={snippets}
                renderSnippet={(snippetId) => api<{ text: string; missing: string[] }>("GET", `${base}/cases/${caseId}/snippets/${snippetId}`)}
                onEditing={setEditing}
                canEdit={canEdit}
                send={data.send}
                onSave={(body) => act(() => api("PUT", `${base}/drafts/${draft.id}`, { body, expectedVersion: draft.version }), "Entwurf gespeichert.")}
                onSend={(ack) => act(() => api("POST", `${base}/drafts/${draft.id}/send`, { expectedVersion: draft.version, acknowledgeWarnings: ack }), "In den Postausgang gestellt.")}
                onDiscard={() => act(() => api("POST", `${base}/drafts/${draft.id}/discard`))}
                canPolish={(data.writer ?? "rules") !== "rules"}
                onPolish={(body) => act(() => api("POST", `${base}/drafts/${draft.id}/polish`, { body, expectedVersion: draft.version }), "Neu formuliert und gespeichert. Bitte noch einmal lesen.")}
                documents={documents}
                caseFiles={data.caseFiles ?? []}
                replyFiles={data.replyFiles ?? { supported: false, note: "" }}
                documentBase={`${base}/documents`}
                onUpload={(file) => act(async () => api("POST", `${base}/drafts/${draft.id}/files`, { name: file.name, dataBase64: await readBase64(file), expectedVersion: draft.version }), "Datei angehängt. Bitte Antwort mit Anhang lesen und senden.")}
                onDocuments={(ids) => act(() => api("PUT", `${base}/drafts/${draft.id}/documents`, { documentIds: ids, expectedVersion: draft.version }), ids.length ? "Anhang gespeichert. Bitte Antwort mit Anhang lesen und senden." : "Anhang entfernt.")}
              />
            )}
          </section>
        </div>

        <div className="case-side">
          <section className="card">
            <div className="row wrap"><h3>Bestellung in weclapp</h3><span className={`pill ${match.tone}`}>{match.label}</span></div>
            <OrderPanel
              data={data}
              canEdit={canEdit}
              onLink={(body) => act(() => api("POST", `${base}/cases/${caseId}/order-link`, body), "Zuordnung aktualisiert.")}
              onRefresh={() => act(() => api<{ changed: boolean }>("POST", `${base}/cases/${caseId}/order-refresh`), (r) => (r as { changed: boolean }).changed ? "Bestellung neu aus weclapp abgerufen. Es hat sich etwas geändert; bitte den Entwurf noch einmal lesen." : "Bestellung neu aus weclapp abgerufen. Unverändert.")}
              invoiceFiles={(data.caseFiles ?? []).filter((f) => f.source === "erp_invoice")}
              documentBase={`${base}/documents`}
              draft={draft}
              replyFiles={data.replyFiles ?? { supported: false, note: "" }}
              onFetchInvoices={() => act(async () => {
                const r = await api<{ files: CaseFile[] }>("POST", `${base}/cases/${caseId}/invoices/fetch`);
                // Start the download right away; the file also stays in the list.
                for (const f of r.files) { const a = document.createElement("a"); a.href = `${base}/documents/${f.id}`; a.download = f.name; a.click(); }
              }, "Rechnung aus weclapp geholt.")}
              onAttach={(fileId, on) => draft && act(() => api("PUT", `${base}/drafts/${draft.id}/documents`, { documentIds: on ? [...(draft.document_ids ?? []), fileId] : (draft.document_ids ?? []).filter((x) => x !== fileId), expectedVersion: draft.version }), on ? "Rechnung wird mit der Antwort gesendet. Bitte Antwort lesen und senden." : "Rechnung aus der Antwort genommen.")}
            />
          </section>

          {data.amazonListings && (c.source_platform === "amazon" || (data.listingActions?.length ?? 0) > 0) && (
            <AmazonOfferCard
              key={caseId}
              base={base}
              caseId={caseId}
              marketplaceIds={data.amazonListings.marketplaceIds}
              skus={[...new Set((data.orderLink?.status === "unique" ? data.orderLink.snapshot?.lines ?? [] : []).map((l) => l.articleNumber).filter((x): x is string => !!x))]}
              actions={data.listingActions ?? []}
              canEdit={canEdit}
              onDone={() => { void load(); onChanged(); }}
            />
          )}
          <Outcome key={`${c.id}:${c.outcome_at ?? ""}`} data={data} canEdit={canEdit} onSave={(outcome, note, amount) => act(() => api("POST", `${base}/cases/${caseId}/outcome`, { outcome, note, ...(amount !== undefined ? { amount } : {}) }), "Gespeichert.")}
            onAddToRefunds={() => act(() => api("POST", `${base}/cases/${caseId}/refund-list`), "Steht jetzt auf der Erstattungsliste.")} />
          <CustomerHistory history={data.customerHistory} onOpen={onOpenCase} />
          {canEdit && (
            <section className="card">
              <h3>Nachweis</h3>
              <p className="muted small">Für einen Antrag bei Amazon (A-bis-z-Garantie) oder einen eBay-Fall („nicht erhalten“, „nicht wie beschrieben“): Bestellung, Versand mit Sendungsnummern, Rechnungen und der ganze Verlauf als PDF.</p>
              <a className="button" href={`${base}/cases/${caseId}/evidence.pdf`} download>Nachweis als PDF</a>
            </section>
          )}

          <section className="card">
            <h3>Interne Notizen</h3>
            <p className="muted small">Nur intern sichtbar. Notizen gehen weder an die KI noch an Kunden.</p>
            {data.notes.map((n) => (
              <div key={n.id} className="note"><div className="small muted">{n.author}, {fmtDate(n.created_at)}</div><div>{n.body}</div></div>
            ))}
            {canEdit && <NoteForm onSubmit={(body) => act(() => api("POST", `${base}/cases/${caseId}/notes`, { body }))} />}
          </section>

          <details className="card">
            <summary><h3>Protokoll</h3></summary>
            <ul className="history">
              {data.history.map((h, i) => (
                <li key={i}><span className="muted small">{fmtDate(h.created_at)}</span> {AUDIT_LABEL[h.action] ?? h.action} <span className="muted small">({h.actor_type})</span></li>
              ))}
            </ul>
          </details>
        </div>
      </div>
      )}
    </div>
  );
}

function ActionEntry({ a }: { a: ListingAction }) {
  return (
    <article className="msg action">
      <div className="row small muted"><span>SupportX, Aktion bei Amazon</span><span>{fmtDate(a.created_at)}</span></div>
      <div>{listingActionText(a)} <span className={`pill ${LISTING_STATE[a.state].tone}`}>{LISTING_STATE[a.state].label}</span></div>
      {a.error && <div className="small muted">{a.error}</div>}
    </article>
  );
}

/** What the customer wants, on top: topic, the AI's one-line summary if there is one, and the customer's own words. */
const TOPIC_SOURCE: Record<string, string> = { auto: "automatisch erkannt", ai: "von der KI erkannt", person: "von Hand gesetzt" };

function Concern({ data, draft, canEdit, onTopic }: { data: CaseData; draft: Draft | null; canEdit: boolean; onTopic: (topic: string | null) => void }) {
  const inbound = [...data.messages].reverse().find((m) => m.direction === "inbound");
  if (!inbound) return null;
  const words = customerText(inbound.body_text);
  const aiSummary = draft && draft.generated_by !== "rules" && draft.generated_by !== "snippet" && draft.summary ? draft.summary : null;
  return (
    <section className="card concern">
      <div className="row wrap">
        <h3>Anliegen</h3>
        {(() => {
          const c = data.conversation;
          const topic = c.topic ?? draft?.intent ?? null;
          if (!canEdit) return topic ? <span className="pill muted">{INTENT_LABEL[topic] ?? topic}</span> : null;
          return (
            <span className="topic-pick small">
              <select value={topic ?? ""} onChange={(e) => onTopic(e.target.value || null)} aria-label="Anliegen">
                {!topic && <option value="">noch nicht erkannt</option>}
                {Object.entries(INTENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {c.topic_source && <span className="muted">{TOPIC_SOURCE[c.topic_source] ?? c.topic_source}</span>}
              {c.topic_source === "person" && <button className="link" onClick={() => onTopic(null)}>automatisch</button>}
            </span>
          );
        })()}
      </div>
      {aiSummary && <p>{aiSummary}</p>}
      {words && <blockquote>{shortText(words, 600)}</blockquote>}
      {(data.titleHints?.length ?? 0) > 0 && (
        <div className="title-hint">
          <strong>Abweichung zwischen Kunde, Bestellung und Artikel</strong>
          <ul>{data.titleHints!.map((h) => <li key={h}>{h}</li>)}</ul>
          <p className="small muted">Bitte den Titel, das Bild und die Menge des Angebots auf dem Marktplatz mit dem Artikel in weclapp vergleichen. Mögliche Ursachen: Falschlieferung, falsche Artikelzuordnung oder ein falsch eingestelltes Angebot.</p>
        </div>
      )}
    </section>
  );
}

interface AttachmentRow { id: string; name: string; contentType: string; size: number; inline: boolean }

/** Customer files, read live from the mailbox or marketplace: images as previews, the rest as downloads. */
function Attachments({ base, messageId }: { base: string; messageId: string }) {
  const [rows, setRows] = useState<AttachmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ attachments: AttachmentRow[] }>("GET", `${base}/messages/${messageId}/attachments`)
      .then((r) => setRows(r.attachments))
      .catch((e: Error) => setError(e.message));
  }, [base, messageId]);
  if (error) return <p className="small warn-text">Anhänge: {error}</p>;
  if (!rows) return <p className="small muted">Anhänge werden geladen …</p>;
  if (rows.length === 0) return <p className="small muted">Mit Anhang, aber keine Datei zum Anzeigen (z. B. nur eingebettete Grafiken).</p>;
  const url = (a: AttachmentRow) => `${base}/messages/${messageId}/attachments/${encodeURIComponent(a.id)}`;
  return (
    <div className="attachments">
      {rows.map((a) => a.inline ? (
        <a key={a.id} href={url(a)} target="_blank" rel="noreferrer" className="thumb" title={`${a.name} öffnen`}>
          <img src={url(a)} alt={a.name} loading="lazy" />
          <span className="small">{a.name}</span>
        </a>
      ) : (
        <a key={a.id} href={url(a)} download={a.name} className="button file">{a.name} ({Math.max(1, Math.round(a.size / 1024))} KB) herunterladen</a>
      ))}
    </div>
  );
}

type ForwardRow = { id: string; message_id: string; recipients: string[]; comment: string; mode: "original" | "text"; state: string; attachments_included: number | null; attachments_left_out: string[]; last_error: string | null; created_at: string; created_by_name: string | null };
type ForwardInfo = { mode: "original" | "text"; subject: string; notice: string; suggestions: string[]; blockers: string[] };
const FORWARD_STATE: Record<string, { label: string; tone: string }> = {
  sending: { label: "wird gesendet", tone: "muted" }, sent: { label: "vom Postfach angenommen", tone: "ok" }, confirmed: { label: "in Gesendete Elemente", tone: "ok" },
  uncertain: { label: "ungeklärt", tone: "bad" }, failed: { label: "nicht gesendet", tone: "bad" },
};

/** "Weitergeleitet an … am …" under the forwarded mail. */
function ForwardLog({ forward: f, canEdit, onResolve }: { forward: ForwardRow; canEdit: boolean; onResolve: (id: string, action: "check" | "was_sent" | "was_not_sent") => void }) {
  const st = FORWARD_STATE[f.state] ?? { label: f.state, tone: "muted" };
  return (
    <div className="forward-log small">
      <div className="row wrap">
        <span>Weitergeleitet an {f.recipients.join(", ")} am {fmtDate(f.created_at)}{f.created_by_name ? ` von ${f.created_by_name}` : ""}</span>
        <span className={`pill ${st.tone}`}>{st.label}</span>
        {f.mode === "text" && <span className="muted">nur Text, ohne Adressen{f.attachments_included ? `, ${f.attachments_included} Anhang/Anhänge` : ""}</span>}
      </div>
      {f.comment && <p className="muted">Begleittext: {f.comment}</p>}
      {f.attachments_left_out.length > 0 && <p className="warn-text">Nicht mitgesendet (zu groß): {f.attachments_left_out.join(", ")}</p>}
      {f.last_error && <p className="error">{f.last_error}</p>}
      {canEdit && (f.state === "uncertain" || f.state === "sending") && (
        <div className="row wrap">
          <span>Bitte in „Gesendete Elemente“ prüfen:</span>
          <button onClick={() => onResolve(f.id, "check")}>Automatisch prüfen</button>
          <button onClick={() => onResolve(f.id, "was_sent")}>Wurde gesendet</button>
          <button onClick={() => onResolve(f.id, "was_not_sent")}>Wurde nicht gesendet</button>
        </div>
      )}
    </div>
  );
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Forward one mail: recipients, optional own text, confirm, send through the mailbox. */
function ForwardBox({ base, messageId, onDone }: { base: string; messageId: string; onDone: (notice: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ForwardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [comment, setComment] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const forwardId = useRef<string>("");

  const start = async () => {
    setOpen(true);
    setError(null);
    setConfirming(false);
    forwardId.current = crypto.randomUUID();
    try {
      setInfo(await api<ForwardInfo>("GET", `${base}/messages/${messageId}/forward`));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const close = () => {
    setOpen(false);
    setTo([]);
    setTyped("");
    setComment("");
    setConfirming(false);
  };
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((p) => !EMAIL_RE.test(p));
    setTo((cur) => [...cur, ...parts.filter((p) => EMAIL_RE.test(p) && !cur.includes(p))]);
    setTyped(bad.join(", "));
    setError(bad.length ? `Keine gültige E-Mail-Adresse: ${bad.join(", ")}` : null);
  };
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ state: string; error?: string }>("POST", `${base}/messages/${messageId}/forward`, { forwardId: forwardId.current, to, comment });
      if (r.state === "failed") {
        setError(r.error ?? "Weiterleitung fehlgeschlagen. Es wurde nichts gesendet.");
        forwardId.current = crypto.randomUUID();
        setConfirming(false);
        onDone("");
        return;
      }
      onDone(r.state === "uncertain" ? "Weiterleitung ungeklärt: bitte in „Gesendete Elemente“ prüfen." : `Weitergeleitet an ${to.join(", ")}.`);
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <div className="row"><button className="link small" onClick={() => void start()}>Weiterleiten</button></div>;
  const pending = typed.trim() !== "";
  const blocked = (info?.blockers.length ?? 0) > 0;
  return (
    <div className="forward-box">
      <div className="row"><strong className="small">Weiterleiten</strong><button className="link small" onClick={close}>Abbrechen</button></div>
      {!info && !error && <p className="small muted">Lädt …</p>}
      {info && !confirming && (
        <>
          <label className="field"><span>An</span>
            <div className="recipients">
              {to.map((a) => <span key={a} className="pill">{a} <button className="link" aria-label={`${a} entfernen`} onClick={() => setTo(to.filter((x) => x !== a))}>×</button></span>)}
              <input type="email" value={typed} placeholder={to.length ? "weitere Adresse" : "name@firma.de"} onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); add(typed); } }} onBlur={() => typed.trim() && add(typed)} />
            </div>
          </label>
          {info.suggestions.filter((sug) => !to.includes(sug)).length > 0 && (
            <div className="row wrap small"><span className="muted">Zuletzt verwendet:</span>
              {info.suggestions.filter((sug) => !to.includes(sug)).slice(0, 8).map((sug) => <button key={sug} className="chip" onClick={() => setTo([...to, sug])}>{sug}</button>)}
            </div>
          )}
          <label className="field"><span>Eigener Text (optional)</span>
            <textarea rows={3} value={comment} maxLength={5000} onChange={(e) => setComment(e.target.value)} placeholder="z. B. Bitte prüfen, ob die Ware so ausgeliefert wurde." />
          </label>
          <p className={`small ${info.mode === "text" ? "warn-text" : "muted"}`}>{info.notice}</p>
          {blocked && <p className="small error">{info.blockers.join(" ")}</p>}
          <div className="row"><button className="primary" disabled={to.length === 0 || pending || blocked} onClick={() => setConfirming(true)}>Weiter</button></div>
        </>
      )}
      {info && confirming && (
        <div className="confirm small">
          <p><strong>Wirklich weiterleiten?</strong></p>
          <p>An: {to.join(", ")}</p>
          <p>Betreff: {info.subject}</p>
          {comment.trim() && <p>Eigener Text: {comment.trim()}</p>}
          <p className={info.mode === "text" ? "warn-text" : "muted"}>{info.mode === "text" ? "Nur der Text ohne E-Mail-Adressen, Anhänge bis 3 MB." : "Die Original-Mail mit Absender und Anhängen."}</p>
          <div className="row"><button onClick={() => setConfirming(false)} disabled={busy}>Zurück</button><button className="primary" onClick={() => void send()} disabled={busy}>{busy ? "Wird gesendet …" : "Jetzt weiterleiten"}</button></div>
        </div>
      )}
      {error && <p className="small error">{error}</p>}
    </div>
  );
}

/** Our reply in the history, right-aligned like a chat, with its send state. */
function ReplyBubble({ reply, echoed, canEdit, onResolve }: { reply: CaseData["outbox"][number]; echoed: boolean; canEdit: boolean; onResolve: (id: string, resolution: "was_sent" | "was_not_sent") => void }) {
  const tone = reply.state === "delivery_uncertain" || reply.state === "failed" ? "bad" : reply.state === "confirmed" || reply.state === "provider_accepted" ? "ok" : "muted";
  const when = reply.dispatched_at ?? reply.created_at;
  return (
    <article className={`msg outbound reply state-${reply.state}`}>
      <div className="row small muted">
        <span>Wir{reply.state === "planned" || reply.state === "dispatching" ? ", eingeplant" : ""}</span>
        <span>{fmtDate(when)}</span>
      </div>
      <div className="row wrap small">
        <span className={`pill ${tone}`}>{OUTBOX_LABEL[reply.state] ?? reply.state}</span>
        {reply.expected_recipient && <span className="muted">an {reply.expected_recipient}</span>}
        {reply.attempts > 1 && <span className="muted">{reply.attempts} Versuche</span>}
        {echoed && <span className="muted">im Postfach als gesendet gefunden</span>}
      </div>
      <MessageBody text={reply.body} />
      {reply.last_error && <p className="small error">{reply.last_error}</p>}
      {reply.state === "delivery_uncertain" && canEdit && (
        <div className="row wrap">
          <span className="small">Bitte in „Gesendete Elemente“ prüfen:</span>
          <button onClick={() => onResolve(reply.id, "was_sent")}>Wurde gesendet</button>
          <button onClick={() => onResolve(reply.id, "was_not_sent")}>Wurde nicht gesendet</button>
        </div>
      )}
    </article>
  );
}

/** The full message as received; long ones start folded. */
function MessageBody({ text }: { text: string }) {
  // Marketplace mails wrap the customer's words in links and boilerplate: show the words, keep the raw mail one click away.
  const words = customerText(text);
  const extracted = words.trim() !== "" && words.trim() !== text.trim();
  const long = extracted || text.length > 700 || text.split("\n").length > 14;
  const [open, setOpen] = useState(!long);
  return (
    <>
      {extracted && !open ? <pre className="body">{words}</pre> : <pre className={`body${open ? "" : " folded"}`}>{text}</pre>}
      {long && <button className="link small" onClick={() => setOpen(!open)}>{open ? "Weniger anzeigen" : "Ganze Nachricht anzeigen"}</button>}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = { open: "offen", waiting: "wartet", closed: "erledigt" };

/** Earlier cases of this customer (same address or same weclapp customer). */
function CustomerHistory({ history, onOpen }: { history: CaseData["customerHistory"]; onOpen?: (id: string) => void }) {
  if (!history) return null;
  const { cases, counts } = history;
  const done = [counts.refunds && `${counts.refunds} × erstattet`, counts.replacements && `${counts.replacements} × Ersatz`, counts.returns && `${counts.returns} × Rücksendung`].filter(Boolean);
  return (
    <section className="card">
      <h3>Kundenhistorie</h3>
      {cases.length === 0 ? <p className="muted small">Erster Fall dieses Kunden in SupportX.</p> : (
        <>
          <p className="small">{cases.length === 1 ? "1 früherer Fall" : `${cases.length} frühere Fälle`}{done.length > 0 ? ` · ${done.join(" · ")}` : ""}</p>
          <ul className="history-cases">
            {cases.map((h) => (
              <li key={h.id}>
                <button className="link" onClick={() => onOpen?.(h.id)} disabled={!onOpen}>{h.subject || "(ohne Betreff)"}</button>
                <span className="muted small">
                  {[h.last_message_at ? fmtDate(h.last_message_at) : null, PLATFORM_LABEL[h.source_platform] ?? h.source_platform, h.order_number, h.topic ? INTENT_LABEL[h.topic] ?? h.topic : null, STATUS_LABEL[h.status] ?? h.status, h.outcome ? OUTCOME_LABEL[h.outcome] : null].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Gleiche Absenderadresse oder gleicher Kunde in weclapp.</p>
    </section>
  );
}

export const OUTCOME_LABEL: Record<string, string> = {
  none: "Nichts weiter nötig",
  replacement: "Ersatz geschickt",
  refund: "Erstattet",
  partial_refund: "Teilweise erstattet",
  return: "Rücksendung vereinbart",
  question: "Rückfrage an den Kunden",
  other: "Sonstiges",
};

/** What was answered and what was done afterwards: the base for later automation. */
function Outcome({ data, canEdit, onSave, onAddToRefunds }: { data: CaseData; canEdit: boolean; onSave: (outcome: string | null, note: string, amount?: string | null) => void; onAddToRefunds: () => void }) {
  const c = data.conversation;
  const [note, setNote] = useState(c.outcome_note ?? "");
  const savedAmount = enteredAmount(data);
  const [amount, setAmount] = useState(savedAmount);
  const isRefund = c.outcome === "refund" || c.outcome === "partial_refund";
  const sent = data.outbox.find((o) => o.state === "provider_accepted" || o.state === "confirmed");
  return (
    <section className="card">
      <h3>Ergebnis</h3>
      <div className="kv"><span>Antwort</span><span>{sent ? `über SupportX gesendet ${fmtDate(sent.dispatched_at ?? sent.created_at)}` : "noch nicht über SupportX gesendet"}</span></div>
      {sent && <p className="muted small">Der Antworttext steht im Verlauf.</p>}
      <label className="stack small">Was wurde danach gemacht?
        <select value={c.outcome ?? ""} disabled={!canEdit} onChange={(e) => onSave(e.target.value || null, note)}>
          <option value="">noch offen</option>
          {Object.entries(OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {c.outcome && (
        <input placeholder="Notiz, z. B. Betrag, Artikel oder Antwort außerhalb von SupportX" value={note} disabled={!canEdit}
          onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== (c.outcome_note ?? "")) onSave(c.outcome, note); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      )}
      {isRefund && (
        <label className="stack small refund-amount-field">Erstatteter Betrag in €
          <input inputMode="decimal" placeholder="z. B. 12,50" value={amount} disabled={!canEdit}
            onChange={(e) => setAmount(e.target.value)} onBlur={() => { if (amount.trim() !== savedAmount) onSave(c.outcome, note, amount.trim() || null); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setAmount(savedAmount); }} />
        </label>
      )}
      {c.outcome_at && <p className="muted small">Erfasst {fmtDate(c.outcome_at)}</p>}
      <RefundListStatus status={data.refundList} canEdit={canEdit} onAdd={onAddToRefunds} />
    </section>
  );
}

/** Amount a person entered for this case's refund, as "12,50" (empty when none). */
function enteredAmount(data: CaseData): string {
  const a = data.refundList?.item?.amount;
  return a?.from === "entered" ? (a.cents / 100).toFixed(2).replace(".", ",") : "";
}

/** Header hint: what was refunded and whether it is ticked off in weclapp. */
function RefundPill({ data }: { data: CaseData }) {
  const outcome = data.conversation.outcome;
  const list = data.refundList;
  if (!list || list.state === "none") return null;
  const a = list.item?.amount;
  const what = outcome === "partial_refund" ? "Teilweise erstattet" : outcome === "refund" ? "Erstattet" : "Erstattung";
  const sum = a ? ` ${formatAmount(a.cents, a.currency).replace(/\u00a0/g, " ")}` : "";
  return list.state === "done"
    ? <span className="pill ok" title="Auf der Erstattungsliste als in weclapp erledigt abgehakt">{what}{sum} · in weclapp erledigt</span>
    : <span className="pill refund-open" title="Steht auf der Erstattungsliste, in weclapp noch nicht abgehakt">{what}{sum} · Erstattungsliste offen</span>;
}

const CLOSE_OUTCOMES = ["refund", "partial_refund", "replacement", "return", "none", "other"] as const;

/** Asked when a case is set to "Erledigt": what was done, and for a refund the amount. */
function CloseCase({ data, onClose, onCancel }: { data: CaseData; onClose: (outcome: string | undefined, note: string, amount?: string | null) => void; onCancel: () => void }) {
  const c = data.conversation;
  const [outcome, setOutcome] = useState(c.outcome ?? "");
  const [note, setNote] = useState(c.outcome_note ?? "");
  const [amount, setAmount] = useState(enteredAmount(data));
  const isRefund = outcome === "refund" || outcome === "partial_refund";
  return (
    <form className="card close-case" onSubmit={(e) => { e.preventDefault(); onClose(outcome || undefined, note, isRefund ? amount.trim() || null : undefined); }}>
      <h3>Fall erledigen</h3>
      <p className="small muted">Was wurde gemacht? Bei einer Erstattung kommt der Fall mit Betrag auf die Erstattungsliste, dort wird abgehakt, wenn die Gutschrift in weclapp angelegt ist.</p>
      <div className="row wrap" role="radiogroup" aria-label="Was wurde gemacht?">
        {CLOSE_OUTCOMES.map((o) => (
          <button type="button" key={o} className={outcome === o ? "chip active" : "chip"} aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? "" : o)}>{OUTCOME_LABEL[o]}</button>
        ))}
      </div>
      {isRefund && (
        <div className="row wrap close-case-fields">
          <label className="field"><span>Betrag in €</span><input inputMode="decimal" placeholder="z. B. 12,50" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
          <label className="field grow"><span>Vermerk</span><input placeholder="z. B. 25 % für fehlende Packung, keine Retoure" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
      )}
      {!isRefund && outcome && (
        <label className="field close-case-fields"><span>Vermerk (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      )}
      <div className="row wrap actions">
        <button className="primary" type="submit">{isRefund ? "Erledigt, auf die Erstattungsliste" : "Erledigt"}</button>
        <button type="button" className="link" onClick={() => onClose(undefined, "")}>Ohne Angabe erledigen</button>
        <button type="button" className="link" onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}

/** The case on the refund list: open, done in weclapp, or a button to put it there. */
function RefundListStatus({ status, canEdit, onAdd }: { status: CaseData["refundList"]; canEdit: boolean; onAdd: () => void }) {
  if (!status) return null;
  const done = status.item?.done;
  return (
    <div className="refund-list-status small">
      {status.state === "open" && <span className="refund-flag">Erstattungsliste</span>}
      {status.state === "open" && <span>Steht auf der Erstattungsliste, in weclapp noch nicht abgehakt.</span>}
      {status.state === "done" && done && (
        <span className="ok-text">Erstattung in weclapp erledigt {fmtDate(done.at)}{done.by ? ` von ${done.by}` : ""}{done.creditNoteNumber ? ` (Gutschrift ${done.creditNoteNumber})` : ""}.</span>
      )}
      {status.state === "none" && canEdit && (
        <button className="small" onClick={onAdd} title="Für Erstattungen, die in weclapp noch zu machen sind. Bei „Erstattet“ oder „Teilweise erstattet“ geschieht das von selbst.">
          {status.removed ? "Wieder auf die Erstattungsliste" : "Auf die Erstattungsliste"}
        </button>
      )}
    </div>
  );
}

function OrderPanel({ data, canEdit, onLink, onRefresh, invoiceFiles, documentBase, draft, replyFiles, onFetchInvoices, onAttach }: {
  data: CaseData; canEdit: boolean; onLink: (body: { reference?: string; candidateId?: string }) => void; onRefresh: () => Promise<void> | void;
  invoiceFiles: CaseFile[]; documentBase: string; draft: Draft | null; replyFiles: { supported: boolean; note: string };
  onFetchInvoices: () => Promise<void> | void; onAttach: (fileId: string, on: boolean) => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [reference, setReference] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const link = data.orderLink;
  const order = link?.snapshot ?? null;
  const c = data.conversation;
  return (
    <div>
      {link && (
        <p className="small muted">
          Gesucht: {link.references_tried.length ? link.references_tried.join(", ") : "keine Referenz erkannt"}
          {link.matched_by ? ` · Treffer über ${link.matched_by}` : ""} · {link.linked_by === "user" ? "manuell zugeordnet" : "automatisch"}
          {link.retrieved_at ? ` · abgerufen ${fmtDate(link.retrieved_at)}` : ""}
        </p>
      )}
      {link?.error && <p className="notice bad">{link.error}</p>}
      {link?.status === "ambiguous" && (
        <div className="notice warn">
          <p>Mehrere Bestellungen passen. Bitte die richtige auswählen:</p>
          {link.candidates.map((cand) => (
            <div key={cand.id} className="row">
              <span>{cand.orderNumber ?? cand.id} <span className="muted small">(über {cand.matchedBy})</span></span>
              {canEdit && <button onClick={() => onLink({ candidateId: cand.id })}>Zuordnen</button>}
            </div>
          ))}
        </div>
      )}
      {order && (
        <OrderDetails
          order={order}
          refund={data.refund}
          check={data.returnCheck ?? null}
          returns={<><ReturnBox order={order} canEdit={canEdit} onRefresh={onRefresh} />{data.returnCheck?.applicable && <ReturnCheckBox check={data.returnCheck} />}</>}
          links={orderLinks({
            order,
            platforms: [c.source_platform, data.accounts.find((a) => a.id === c.merchant_account_id)?.platform],
            erpBaseUrl: data.linkTargets?.erp_base_url,
            miraklBaseUrl: data.linkTargets?.mirakl_base_url,
          })}
          invoices={
            <>
          <h4>Rechnungen</h4>
          {order.invoices.length > 0
            ? <ul>{order.invoices.map((inv) => <li key={inv.id} className="small">{inv.type === "CREDIT_NOTE" ? "Gutschrift " : ""}{inv.invoiceNumber ?? inv.id} · {fmtDate(inv.invoiceDate)} · {inv.paymentStatus ?? inv.status ?? "–"}</li>)}</ul>
            : <p className="small muted">Noch keine Rechnung abgerufen.</p>}
          {canEdit && (
            <button disabled={fetching} onClick={async () => { setFetching(true); try { await onFetchInvoices(); } finally { setFetching(false); } }} title="Holt die Rechnungs-PDF dieser Bestellung aus weclapp (nur lesend) und lädt sie herunter.">
              {fetching ? "Holt Rechnung …" : "Rechnung herunterladen"}
            </button>
          )}
          {invoiceFiles.length > 0 && (
            <ul className="invoice-files">
              {invoiceFiles.map((f) => {
                const attached = !!draft?.document_ids?.includes(f.id);
                return (
                  <li key={f.id} className="small">
                    <a className="button" href={`${documentBase}/${f.id}`} download>{f.name} herunterladen</a>
                    {canEdit && replyFiles.supported && (
                      <label className="row" title={draft ? undefined : "Erst eine Antwort schreiben lassen, dann anhaken."}>
                        <input type="checkbox" checked={attached} disabled={!draft || (!attached && (draft.document_ids?.length ?? 0) >= 3)} onChange={(e) => onAttach(f.id, e.target.checked)} />
                        Als Anhang mit der Antwort senden{!draft ? " (erst Antwort schreiben lassen)" : ""}
                      </label>
                    )}
                    {!replyFiles.supported && <span className="muted"> {replyFiles.note}</span>}
                  </li>
                );
              })}
            </ul>
          )}
            </>
          }
        />
      )}
      {canEdit && link?.status === "unique" && !searchOpen && (
        <button className="link small" onClick={() => setSearchOpen(true)}>Andere Bestellung zuordnen</button>
      )}
      {canEdit && (link?.status !== "unique" || searchOpen) && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (reference.trim()) onLink({ reference: reference.trim() }); }}>
          <input placeholder="Bestell-, Rechnungs- oder Sendungsnummer suchen" value={reference} onChange={(e) => setReference(e.target.value)} />
          <button type="submit">Suchen &amp; zuordnen</button>
        </form>
      )}
    </div>
  );
}

/** Has the customer sent the goods back? Shown first, so a refund decision does not need a trip to weclapp. */
function ReturnBox({ order, canEdit, onRefresh }: { order: OrderSnapshot; canEdit: boolean; onRefresh: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const rs = returnsOf(order);
  return (
    <div className={`return-box ${TONE_CLASS[rs.tone]}`}>
      <div className="row wrap"><h4>Retoure</h4><span className={`pill ${TONE_CLASS[rs.tone]}`}>{rs.label}</span></div>
      <p className="small">{rs.advice}</p>
      {rs.returns.length > 0 && (
        <ul>
          {rs.returns.map((r) => (
            <li key={r.id} className="small">
              <strong>{r.returnNumber ?? "Retoure"}</strong> · {r.erpStatus ? RETURN_STATUS_DE[r.erpStatus] ?? r.erpStatus : "ohne Status"}{r.erpStatusAt ? ` (${fmtDate(r.erpStatusAt)})` : ""}
              {r.createdAt && <span className="muted"> · angelegt {fmtDate(r.createdAt)}</span>}
              {r.items.length > 0 && <div className="muted">{r.items.map((i) => `${i.quantity} × ${i.title ?? "Position"}${i.reason ? ` (Grund: ${i.reason})` : ""}`).join(", ")}</div>}
            </li>
          ))}
        </ul>
      )}
      {rs.creditNotes.length > 0 && (
        <p className="small">Gutschrift: {rs.creditNotes.map((cn) => `${cn.invoiceNumber ?? cn.id}${cn.invoiceDate ? ` vom ${fmtDate(cn.invoiceDate)}` : ""}`).join(", ")}</p>
      )}
      <p className="muted small">Stand weclapp {fmtDate(order.retrievedAt)}. Der Status ist eine Buchung in weclapp, kein Scan des Paketdienstes.</p>
      {canEdit && (
        <button disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }} title="Liest die Bestellung mit Lieferungen, Rechnungen und Retouren neu aus weclapp (nur lesend).">
          {busy ? "Ruft ab …" : "Neu aus weclapp abrufen"}
        </button>
      )}
    </div>
  );
}

/** Returned units per position against ordered and shipped, and the amount that fits the return. */
function ReturnCheckBox({ check }: { check: ReturnCheck }) {
  const a = check.amounts;
  const money = (n: number) => formatMoney(n, a?.currency);
  const announced = check.lines.some((l) => l.announced > 0);
  const toneText: Record<string, string> = { good: "ok-text", warn: "warn-text", bad: "error", neutral: "muted" };
  return (
    <div className={`return-box return-check ${TONE_CLASS[check.tone]}`}>
      <div className="row wrap"><h4>Retourenprüfung</h4><span className={`pill ${TONE_CLASS[check.tone]}`}>{check.receivedUnits} von {check.baseUnits} Stück zurück</span></div>
      <div className="table-wrap"><table className="small">
        <thead><tr><th>Position</th><th>bestellt</th><th>versendet</th><th>zurück</th>{announced && <th>angemeldet</th>}</tr></thead>
        <tbody>
          {check.lines.map((l) => (
            <tr key={l.lineId}>
              <td>{l.title}{a && l.unitGross !== undefined && <span className="muted"> (je {money(l.unitGross)})</span>}</td><td>{l.ordered}</td><td>{l.shipped ?? "?"}</td>
              <td className={l.received > l.ordered || (l.shipped !== undefined && l.received > l.shipped) ? "error" : undefined}>{l.received}</td>
              {announced && <td>{l.announced || ""}</td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      {a && (
        <p className="small">
          Ware zurück <strong>{money(a.goods)}</strong> · Versandkosten der Bestellung {money(a.shipping)}{check.complete ? " (bei vollständiger Rücksendung mit erstatten)" : " (Teilretoure: nicht automatisch mit erstatten)"} ·
          {" "}passend <strong>{money(a.expected)}</strong> · höchstens {money(a.maximum)}
          {a.credited > 0 && <> · Gutschrift {money(a.credited)}{a.creditedShipping > 0 ? ` (davon Versand ${money(a.creditedShipping)})` : ""}</>}
          {a.noticed > 0 && <> · Marktplatz-Erstattung {money(a.noticed)}</>}
        </p>
      )}
      <ul>
        {check.findings.map((f, i) => <li key={i} className={`small ${toneText[f.tone]}`}>{f.text}</li>)}
      </ul>
      <p className="muted small">Beträge brutto laut weclapp. Rücksendekosten stehen nicht in weclapp: Ob der Kunde sie trägt, richtet sich nach euren Bedingungen.</p>
    </div>
  );
}

/** Ordered weight (article master data) against the booked package weight: a strong hint when something is missing. */
function WeightBox({ order }: { order: OrderSnapshot }) {
  const checks = weightChecks(order);
  if (checks.length === 0) return null;
  return (
    <>
      {checks.map((c, i) => (
        <div key={c.shipmentId ?? i} className={`return-box weight-box ${TONE_CLASS[c.tone]}`}>
          <div className="row wrap">
            <h4>Gewicht{checks.length > 1 && c.shipmentNumber ? ` ${c.shipmentNumber}` : ""}</h4>
            <span className={`pill ${TONE_CLASS[c.tone]}`}>{c.label}</span>
          </div>
          {(c.expectedKg !== undefined || c.actualKg !== undefined) && (
            <p className="small">
              Soll (Artikel) <strong>{c.expectedKg !== undefined ? formatKg(c.expectedKg) : "unbekannt"}</strong> · Paket <strong>{c.actualKg !== undefined ? formatKg(c.actualKg) : "kein Gewicht"}</strong>
              {c.percent !== undefined && <span className="muted"> ({c.percent} %)</span>}
            </p>
          )}
          <p className="small">{c.advice}</p>
        </div>
      ))}
      <p className="muted small">{WEIGHT_SOURCE_NOTE} Paketgewicht inklusive Verpackung. Ob es gewogen oder berechnet wurde, zeigt weclapp nicht an.</p>
    </>
  );
}

function OrderDetails({ order, links, invoices, returns, refund, check }: { order: OrderSnapshot; links: OrderLink[]; invoices: React.ReactNode; returns: React.ReactNode; refund?: RefundDue; check?: ReturnCheck | null }) {
  const due = refund?.state === "due";
  const blockers = check?.findings.filter((f) => f.tone === "bad") ?? [];
  const hasRefundLink = links.some((l) => l.kind === "refund");
  return (
    <div className="order">
      {due && (
        <div className="refund-due-notice" role="status">
          <strong>{refund!.headline}</strong>
          {blockers.length > 0 && <span className="small"><strong>Vorher prüfen:</strong> {blockers.map((b) => b.text).join(" ")}</span>}
          {check?.amounts && <span className="small">Passender Betrag laut Retoure: {formatMoney(check.amounts.expected, check.amounts.currency)}{check.complete ? "" : " (Teilretoure)"}.</span>}
          <span className="small">{hasRefundLink ? "Über „Bestellung erstatten“ im Marktplatz erstatten und danach unten unter Ergebnis „Erstattet“ wählen." : "Im Marktplatz bzw. in weclapp erstatten und danach unten unter Ergebnis „Erstattet“ wählen."}</span>
        </div>
      )}
      {refund?.state === "done" && <p className="small ok-text">{refund.headline}</p>}
      {links.length > 0 && (
        <div className="row wrap order-links">
          {links.map((l) => (
            <a key={l.href} className={l.kind === "refund" && due ? "button refund-due" : "button"} href={l.href} target="_blank" rel="noopener noreferrer"
              title={l.kind === "refund" && due ? "Ware ist zurück, Erstattung ist noch offen." : undefined}>
              {l.label} ↗
            </a>
          ))}
        </div>
      )}
      <div className="kv"><span>Auftrag</span><strong>{order.orderNumber ?? order.id}</strong></div>
      {order.orderNumberAtCustomer && <div className="kv"><span>Marktplatz-Nr.</span><span>{order.orderNumberAtCustomer}</span></div>}
      <div className="kv"><span>Datum / Status</span><span>{fmtDate(order.orderDate)} · {order.status ?? "–"}</span></div>
      {returns}
      <h4>Positionen</h4>
      <ul>
        {order.lines.map((l) => {
          const unitKg = l.grossWeightKg ?? l.netWeightKg;
          return <li key={l.id}>{l.quantity} × {l.title} <span className="muted small">(versendet {l.shippedQuantity ?? 0}, retourniert {l.returnedQuantity ?? 0}{unitKg ? `, je ${formatKg(unitKg)}` : ""})</span></li>;
        })}
      </ul>
      <h4>Lieferungen ({order.shipments.length})</h4>
      {order.shipments.length === 0 && <p className="muted small">Keine Lieferung in weclapp angelegt.</p>}
      {order.shipments.map((s) => (
        <div key={s.id} className="shipment">
          <div><strong>{s.shipmentNumber ?? s.id}</strong> · ERP-Status {s.erpStatus ?? "–"} {s.erpStatusAt ? `(${fmtDate(s.erpStatusAt)})` : ""}</div>
          <div className="small muted">{s.items.map((i) => `${i.quantity} × ${i.title ?? "?"}`).join(", ")}</div>
          {s.parcels.length === 0 ? (
            <div className="small warn-text">Keine Sendungsnummer hinterlegt.</div>
          ) : (
            <ul>
              {s.parcels.map((p, i) => (
                <li key={p.id ?? i} className="small">
                  Paket {i + 1}: {p.trackingId ?? "ohne Nummer"}{" "}
                  {trackingHref(p.trackingUrl, p.trackingId) ? <a href={trackingHref(p.trackingUrl, p.trackingId)} target="_blank" rel="noreferrer noopener">Trackinglink</a> : <span className="muted">kein Link</span>}
                  {p.source === "legacy_package_tracking" && <span className="muted"> (altes Einzelfeld)</span>}
                  {p.weightKg !== undefined && <span className="muted"> · {formatKg(p.weightKg)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <WeightBox order={order} />
      <p className="muted small">ERP-Status ist eine Buchung in weclapp, kein Scan des Paketdienstes. Ein Trackinglink belegt weder Versand noch Zustellung.</p>
      {invoices}
      <p className="muted small">Abgerufen: {fmtDate(order.retrievedAt)}</p>
    </div>
  );
}

const DECISION_LABEL: Record<string, string> = { customer_right: "Kunde hat recht", customer_wrong: "Kunde hat nicht recht", ask_customer: "Erst nachfragen", custom: "Individuell", invoice: "Rechnung senden" };
const WRITER_NOTE: Record<string, string> = {
  own_key: "Die Antwort schreibt Claude über euren Schlüssel. Jeder Klick kostet Claude-Guthaben.",
  installation: "Die Antwort schreibt Claude. Jeder Klick kostet Claude-Guthaben.",
  rules: "Die Antwort kommt aus einer Vorlage, ohne KI-Kosten.",
};

/** First a person decides, then the reply is written: nothing is generated (or paid for) on its own. */
function Decision({ current, hasDraft, writer, pendingOrder, invoices, orderUnique, onInvoice, onDecide, onCompose, snippets, onSnippet }: {
  current: string | null; hasDraft: boolean; writer: string; pendingOrder: boolean; invoices: string[]; orderUnique: boolean; onInvoice: () => void; onDecide: (decision: string) => void; onCompose: (instruction: string) => void;
  snippets: SnippetInfo[]; onSnippet: (snippetId: string) => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [custom, setCustom] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const ai = writer !== "rules";
  return (
    <div className="decision">
      <p className="small"><strong>{hasDraft ? "Andere Entscheidung? Dann wird die Antwort neu geschrieben." : "Erst entscheiden, dann wird die Antwort geschrieben."}</strong>{pendingOrder ? " Die Bestellung wird noch gesucht." : ""}</p>
      <div className="row wrap">
        {Object.entries(DECISION_LABEL).filter(([key]) => key !== "custom" && key !== "invoice").map(([key, label]) => (
          <button key={key} className={current === key ? "primary" : key === "customer_right" && !hasDraft ? "primary" : ""} onClick={() => onDecide(key)}>{label}</button>
        ))}
        <button className={custom || current === "custom" ? "primary" : ""} aria-expanded={custom} onClick={() => setCustom(!custom)}>Individuell</button>
        <button
          className={current === "invoice" ? "primary" : ""}
          disabled={fetching}
          onClick={async () => { setFetching(true); try { await onInvoice(); } finally { setFetching(false); } }}
          title="Holt die Rechnungs-PDF der zugeordneten Bestellung aus weclapp und hängt sie an eine Antwort aus der Vorlage (ohne KI-Kosten). Gesendet wird erst mit Klick auf Senden."
        >{fetching ? "Holt Rechnung …" : "Rechnung senden"}</button>
        {snippets.length > 0 && (
          <span className="snippet-pick">
            <select value="" onChange={(e) => e.target.value && onSnippet(e.target.value)} aria-label="Textbaustein als Antwort" title="Antwort aus einem Textbaustein, mit Daten aus weclapp gefüllt, ohne KI-Kosten">
              <option value="">Textbaustein …</option>
              {snippets.map((sn) => <option key={sn.id} value={sn.id}>{sn.title}</option>)}
            </select>
          </span>
        )}
      </div>
      <p className="small muted">
        „Rechnung senden“: {!orderUnique ? "geht erst, wenn die Bestellung eindeutig zugeordnet ist." : invoices.length ? `holt ${invoices.length > 1 ? "die Rechnungen" : "die Rechnung"} ${invoices.join(", ")} als PDF aus weclapp, ohne KI-Kosten.` : "sucht die Rechnung der Bestellung in weclapp und holt sie als PDF, ohne KI-Kosten."}
      </p>
      {custom && (
        <form className="custom-reply" onSubmit={(e) => { e.preventDefault(); if (!instruction.trim()) return; setBusy(true); onCompose(instruction); setCustom(false); setInstruction(""); setBusy(false); }}>
          <label className="field"><span>Was soll der Kunde als Antwort bekommen?</span>
            <textarea rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="z. B. Sorry für die Verwechslung, die richtige Dose geht heute raus, die falsche darf er behalten." autoFocus />
          </label>
          <div className="row wrap">
            <button type="submit" className="primary" disabled={busy || !instruction.trim()}>{ai ? "Ausformulieren" : "Als Antwort übernehmen"}</button>
            <span className="small muted">{ai ? "Claude formuliert daraus eine freundliche, vollständige Antwort (kostet Claude-Guthaben)." : "Ohne Claude-Schlüssel wird dein Text mit Anrede und Signatur übernommen."}</span>
          </div>
        </form>
      )}
      <p className="small muted">{WRITER_NOTE[writer] ?? WRITER_NOTE.rules}</p>
    </div>
  );
}

function DraftEditor(props: {
  snippets: SnippetInfo[]; renderSnippet: (snippetId: string) => Promise<{ text: string; missing: string[] }>; onEditing: (editing: boolean) => void;
  draft: Draft; canEdit: boolean; send: CaseData["send"];
  onSave: (body: string) => void; onSend: (ack: boolean) => void; onDiscard: () => void; canPolish: boolean; onPolish: (body: string) => void;
  documents: DocumentInfo[]; caseFiles: CaseFile[]; replyFiles: { supported: boolean; note: string }; documentBase: string; onDocuments: (ids: string[]) => void; onUpload: (file: File) => void;
}) {
  const { draft, canEdit, send } = props;
  const notice = sendNotice(send);
  const [body, setBody] = useState(draft.body);
  const [ack, setAck] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const dirty = body !== draft.body;
  const area = useRef<HTMLTextAreaElement>(null);
  const [snippetNote, setSnippetNote] = useState<string | null>(null);
  const { onEditing } = props;
  useEffect(() => { onEditing(dirty); }, [dirty, onEditing]);
  useEffect(() => () => onEditing(false), [onEditing]);
  const insertSnippet = async (snippetId: string) => {
    try {
      const r = await props.renderSnippet(snippetId);
      const el = area.current;
      const at = el ? el.selectionStart : body.length;
      const end = el ? el.selectionEnd : body.length;
      setBody(body.slice(0, at) + r.text + body.slice(end));
      setSnippetNote(r.missing.length ? `Eingefügt. Ohne Wert geblieben: ${r.missing.map((m) => `{${m}}`).join(", ")}. Bitte ausfüllen, dann speichern.` : "Eingefügt. Bitte speichern.");
    } catch (err) {
      setSnippetNote((err as Error).message);
    }
  };
  const blocking = draft.issues.filter((i) => i.severity === "block");
  const warnings = draft.issues.filter((i) => i.severity === "warn");
  return (
    <div className="draft">
      <div className="row wrap small">
        {draft.risks.map((r) => <span key={r} className="pill warn">Achtung: {RISK_LABEL[r] ?? r}</span>)}
        <span className="muted">{draft.decision ? `${DECISION_LABEL[draft.decision] ?? draft.decision}, ` : ""}Entwurf {draft.generated_by === "rules" ? "aus Vorlage" : draft.generated_by === "snippet" ? "aus Textbaustein" : draft.generated_by === "person" ? "nach deiner Vorgabe" : "von der KI"}{draft.status === "edited" ? ", bearbeitet" : ""}, {fmtDate(draft.updated_at)}</span>
      </div>
      <textarea ref={area} value={body} onChange={(e) => setBody(e.target.value)} rows={10} readOnly={!canEdit} />
      {canEdit && props.snippets.length > 0 && (
        <div className="row wrap small snippet-pick">
          <select value="" onChange={(e) => e.target.value && void insertSnippet(e.target.value)} aria-label="Textbaustein einfügen">
            <option value="">Textbaustein einfügen …</option>
            {props.snippets.map((sn) => <option key={sn.id} value={sn.id}>{sn.title}</option>)}
          </select>
          {snippetNote && <span className="muted">{snippetNote}</span>}
        </div>
      )}
      <DraftFiles draft={draft} canEdit={canEdit && !dirty} documents={props.documents} caseFiles={props.caseFiles} replyFiles={props.replyFiles} base={props.documentBase} onChange={props.onDocuments} onUpload={props.onUpload} />
      {(blocking.length > 0 || warnings.length > 0) && (
        <ul className="issues">
          {blocking.map((i, n) => <li key={`b${n}`} className="error">Blockiert: {i.message}</li>)}
          {warnings.map((i, n) => <li key={`w${n}`} className="warn-text">Hinweis: {i.message}</li>)}
        </ul>
      )}
      {draft.missing_information.length > 0 && <p className="small"><strong>Fehlende Angaben:</strong> {draft.missing_information.join("; ")}</p>}
      {draft.suggested_actions.filter((a) => a !== "none").length > 0 && (
        <p className="small"><strong>Vorgeschlagene nächste Schritte (nur Hinweis, keine automatische Aktion):</strong> {draft.suggested_actions.filter((a) => a !== "none").map((a) => ACTION_LABEL[a] ?? a).join(", ")}</p>
      )}
      <details className="small">
        <summary>Belegte Fakten ({draft.facts.length}), davon zitiert {draft.cited_fact_ids.length}</summary>
        <ul>{draft.facts.map((f) => <li key={f.id} className={draft.cited_fact_ids.includes(f.id) ? "" : "muted"}><code>{f.id}</code> {f.text} <span className="muted">[{f.source}]</span></li>)}</ul>
      </details>
      {canEdit && (
        <div className="row wrap actions">
          {dirty && <button onClick={() => props.onSave(body)}>Änderungen speichern</button>}
          {props.canPolish && <button onClick={() => { setPolishing(true); props.onPolish(body); }} disabled={polishing || !body.trim()} title="Formuliert deinen Text freundlich und kundenorientiert (Claude, kostet Guthaben)">{polishing ? "Formuliert …" : "Freundlich formulieren"}</button>}
          <button className="ghost danger" onClick={props.onDiscard}>Verwerfen</button>
          <span className="spacer" />
          {warnings.length > 0 && <label className="small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Hinweise geprüft</label>}
          <button className="primary" disabled={!send.allowed || dirty || blocking.length > 0 || (warnings.length > 0 && !ack)} onClick={() => props.onSend(ack)} title={dirty ? "Erst speichern" : undefined}>Senden</button>
        </div>
      )}
      {notice.status && <p className="small"><span className={`pill ${notice.status.tone}`}>{notice.status.text}</span></p>}
      {notice.blocked.length > 0 && (
        <div className="send-blocked small">
          <strong>Senden ist gesperrt</strong>
          <ul>{notice.blocked.map((b) => <li key={b}>{b}</li>)}</ul>
          {notice.setupHint && <p className="muted">Freischalten in den Einstellungen auf der Karte des Marktplatzes. Bis dahin den Text kopieren und im Marktplatz selbst senden.</p>}
        </div>
      )}
    </div>
  );
}

interface DocumentInfo { id: string; name: string; size: number }
interface SnippetInfo { id: string; title: string }

/** Date input next to "Wartet": on that day (8:00) the case comes back under "Anfragen". */
function FollowUp({ value, onSet }: { value: string | null; onSet: (iso: string | null) => void }) {
  const toInput = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const tomorrow = new Date(Date.now() + 86_400_000);
  return (
    <label className="follow-up small">Wiedervorlage am
      <input type="date" min={toInput(tomorrow.toISOString())} value={value ? toInput(value) : ""}
        onChange={(e) => {
          if (!e.target.value) return onSet(null);
          const [y, m, d] = e.target.value.split("-").map(Number);
          onSet(new Date(y!, m! - 1, d!, 8, 0, 0).toISOString());
        }} />
      {value && <button className="link" onClick={() => onSet(null)}>entfernen</button>}
    </label>
  );
}

const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

interface CaseFile { id: string; name: string; size: number; content_type: string; source: "upload" | "erp_invoice" }

const MAX_FILE = 3 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}

/**
 * Files that go out with this reply, approved together with the text: workspace PDFs,
 * files of this case (invoice from weclapp) or a file uploaded just for this reply.
 * Shown in every channel; where the channel takes no files it says so and why.
 */
function DraftFiles({ draft, canEdit, documents, caseFiles, replyFiles, base, onChange, onUpload }: {
  draft: Draft; canEdit: boolean; documents: DocumentInfo[]; caseFiles: CaseFile[]; replyFiles: { supported: boolean; note: string }; base: string; onChange: (ids: string[]) => void; onUpload: (file: File) => void;
}) {
  const [tooBig, setTooBig] = useState(false);
  const chosen = draft.document_ids ?? [];
  const all: Array<{ id: string; name: string; size: number }> = [...caseFiles, ...documents];
  const available = all.filter((d) => !chosen.includes(d.id));
  const nameOf = (id: string) => all.find((d) => d.id === id)?.name ?? "Dokument (aus der Liste entfernt)";
  const full = chosen.length >= 3;
  if (!replyFiles.supported) {
    return (
      <div className="draft-files small">
        <strong>Anhang</strong>
        {canEdit && <button disabled title={replyFiles.note}>Datei anhängen</button>}
        <span className="muted">{replyFiles.note}</span>
        {caseFiles.map((f) => <span key={f.id} className="file-chip"><a href={`${base}/${f.id}`} download>{f.name}</a> <span className="muted">zum Herunterladen</span></span>)}
      </div>
    );
  }
  return (
    <div className="draft-files small">
      <strong>Anhang</strong>
      {chosen.map((id) => (
        <span key={id} className="file-chip">
          <a href={`${base}/${id}`} download>{nameOf(id)}</a>
          {canEdit && <button className="link" onClick={() => onChange(chosen.filter((x) => x !== id))} aria-label={`${nameOf(id)} entfernen`}>entfernen</button>}
        </span>
      ))}
      {canEdit && available.length > 0 && !full && (
        <select value="" onChange={(e) => e.target.value && onChange([...chosen, e.target.value])} aria-label="PDF anhängen">
          <option value="">PDF anhängen …</option>
          {available.map((d) => <option key={d.id} value={d.id}>{d.name} ({fmtSize(d.size)})</option>)}
        </select>
      )}
      {canEdit && !full && (
        <label className="file-pick" title="PDF, JPG oder PNG, höchstens 3 MB; gilt nur für diese Antwort">
          <input
            type="file"
            accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > MAX_FILE) { setTooBig(true); return; }
              setTooBig(false);
              onUpload(file);
            }}
          />
          <span className="button">Datei anhängen</span>
        </label>
      )}
      {tooBig && <span className="error">Die Datei ist zu groß (höchstens 3 MB).</span>}
      {chosen.length === 0 && <span className="muted">kein Anhang</span>}
      {chosen.length > 0 && <span className="muted">{replyFiles.note}</span>}
    </div>
  );
}

function NoteForm({ onSubmit }: { onSubmit: (body: string) => void }) {
  const [body, setBody] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) { onSubmit(body); setBody(""); } }}>
      <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Interne Notiz" />
      <button type="submit">Notiz speichern</button>
    </form>
  );
}

type Remember = "none" | "address" | "domain" | "subject";

function CategoryBar({ category, reason, sender, subject, base, canEdit, onSet }: {
  category: "support" | "info"; reason: string | null; sender: string; subject: string; base: string; canEdit: boolean;
  onSet: (category: "support" | "info", remember: Remember, pattern?: string) => void;
}) {
  const [asking, setAsking] = useState<false | "choose" | "subject">(false);
  const domain = sender.includes("@") ? sender.slice(sender.lastIndexOf("@") + 1) : "";
  const target = category === "info" ? "support" : "info";
  const close = () => setAsking(false);
  const choices = asking === "subject" ? (
    <SubjectRuleEditor subject={subject} target={target} base={base} onCancel={close} onSave={(pattern) => { close(); onSet(target, "subject", pattern); }} />
  ) : (
    <div className="row wrap">
      <button onClick={() => { close(); onSet(target, "none"); }}>Nur diese Mail</button>
      {subject.trim() && <button onClick={() => setAsking("subject")} title="Alle Mails, deren Betreff bis auf Beträge und Nummern gleich ist">Alle mit diesem Betreff-Muster …</button>}
      {sender && <button onClick={() => { close(); onSet(target, "address"); }}>Alle von {sender}</button>}
      {domain && <button onClick={() => { close(); onSet(target, "domain"); }}>Alle von @{domain}</button>}
      <button className="link" onClick={close}>Abbrechen</button>
    </div>
  );
  if (category === "info") {
    return (
      <div className="notice info-bar">
        <div><strong>Werbung oder Info</strong>, kein Antwortentwurf.{reason ? <span className="muted"> Erkannt an: {reason}.</span> : null}</div>
        {canEdit && (asking ? <><div className="small">Als Kundenanfrage behandeln:</div>{choices}</> : <button onClick={() => setAsking("choose")}>Ist eine Kundenanfrage</button>)}
      </div>
    );
  }
  if (!canEdit) return null;
  return asking ? (
    <div className={`notice info-bar${asking === "subject" ? " wide" : ""}`}><div className="small">Als Werbung/Info einordnen, ohne Antwort:</div>{choices}</div>
  ) : (
    <button className="ghost" onClick={() => setAsking("choose")} title="Als Werbung oder Info einordnen, ohne Antwort">Keine Kundenanfrage</button>
  );
}

const checkPatternText = (raw: string): string => { const c = checkSubjectPattern(raw); return c.ok ? c.pattern : raw; };

interface PatternPreview { pattern: string; valid: boolean; error?: string; matching: number; moving: number; examples: Array<{ id: string; subject: string; category: "support" | "info" }> }

/** Proposes the subject with amounts and numbers as "*", lets the person edit it and shows what it would catch. */
function SubjectRuleEditor({ subject, target, base, onSave, onCancel }: {
  subject: string; target: "support" | "info"; base: string; onSave: (pattern: string) => void; onCancel: () => void;
}) {
  const [pattern, setPattern] = useState(() => subjectPattern(subject));
  const [preview, setPreview] = useState<PatternPreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      api<PatternPreview>("POST", `${base}/category-rules/preview`, { pattern, category: target })
        .then((p) => { if (!stale) { setPreview(p); setFailed(null); } })
        .catch((err: Error) => { if (!stale) setFailed(err.message); });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [base, pattern, target]);
  const current = preview && preview.pattern === checkPatternText(pattern) ? preview : null;
  const label = target === "info" ? "Werbung/Info" : "Kundenanfrage";
  return (
    <div className="subject-rule">
      <label className="field"><span>Betreff-Muster (* steht für Beträge, Nummern und andere wechselnde Teile)</span>
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={300} spellCheck={false} />
      </label>
      {failed && <p className="error small">{failed}</p>}
      {current && !current.valid && <p className="error small">{current.error}</p>}
      {current?.valid && (
        <div className="small">
          <p>
            Passt auf <strong>{current.matching}</strong> bestehende {current.matching === 1 ? "Fall" : "Fälle"}
            {current.moving > 0 ? <>, davon werden <strong>{current.moving}</strong> als {label} umsortiert</> : null}.
            {" "}Gilt danach für jede neue Mail mit diesem Betreff. Fälle, die schon beantwortet oder von Hand eingeordnet sind, bleiben, wie sie sind.
          </p>
          {current.examples.length > 0 && (
            <ul className="muted">{current.examples.map((e) => <li key={e.id}>{e.subject}{e.category === target ? " (schon so eingeordnet)" : ""}</li>)}</ul>
          )}
        </div>
      )}
      <div className="row wrap">
        <button className="primary" disabled={!current?.valid} onClick={() => onSave(pattern)}>Regel speichern{current?.valid && current.moving > 0 ? ` und ${current.moving} umsortieren` : ""}</button>
        <button className="link" onClick={onCancel}>Abbrechen</button>
      </div>
    </div>
  );
}
