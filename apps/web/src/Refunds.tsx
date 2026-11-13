import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, PLATFORM_LABEL } from "./api.ts";
import { weclappOrderHref } from "./order-links.ts";
import { formatAmount, type RefundListItem } from "../../../packages/core/refund-list.ts";

type Role = "owner" | "agent" | "viewer";
type Filter = "open" | "done" | "all";

const SOURCE_LABEL: Record<string, string> = { outcome: "Ergebnis im Fall", notice: "Meldung des Marktplatzes", manual: "von Hand hinzugefügt" };
const KIND_LABEL: Record<RefundListItem["kind"], string> = { full: "Erstattet", partial: "Teilweise erstattet", unknown: "Erstattung gemeldet" };

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–");
/** Amount for the input, "12,50": typed in, otherwise read from the marketplace notice. */
const fieldAmount = (item: RefundListItem) => (item.amount ? (item.amount.cents / 100).toFixed(2).replace(".", ",") : "");
const amountText = (a: RefundListItem["amount"]) => (a ? formatAmount(a.cents, a.currency).replace(/ /g, " ") : "");

/**
 * "Erstattungen": every refund decided in a case or reported by a marketplace,
 * once per order. A person makes the credit note in weclapp and ticks it off here.
 * SupportX does not refund and does not write to weclapp.
 */
export function Refunds({ workspaceId, role, onOpenCase, onCounts }: { workspaceId: string; role: Role; onOpenCase: (id: string) => void; onCounts?: (open: number) => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [items, setItems] = useState<RefundListItem[] | null>(null);
  const [counts, setCounts] = useState<{ open: number; done: number } | null>(null);
  const [erpBaseUrl, setErpBaseUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/w/${workspaceId}`;
  const canEdit = role !== "viewer";

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: RefundListItem[]; counts: { open: number; done: number }; erpBaseUrl: string | null }>("GET", `${base}/refunds?filter=${filter}`);
      setItems(data.items);
      setErpBaseUrl(data.erpBaseUrl);
      setCounts(data.counts);
      onCounts?.(data.counts.open);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base, filter, onCounts]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-scroll"><div className="settings refunds">
      <div className="settings-title wide row">
        <h2>Erstattungen</h2>
        <div className="row">
          {([["open", "Offen", counts?.open], ["done", "Erledigt", counts?.done], ["all", "Alle", null]] as const).map(([id, label, n]) => (
            <button key={id} className={filter === id ? "chip active" : "chip"} onClick={() => setFilter(id)}>
              {label}{typeof n === "number" ? <span className="count">{n}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small wide refunds-intro">
        Fälle mit Ergebnis „Erstattet“ oder „Teilweise erstattet“ und Erstattungsmeldungen der Marktplätze, je Bestellung einmal.
        Gutschrift in weclapp anlegen, dann hier abhaken. SupportX erstattet nicht selbst und schreibt nichts in weclapp.
      </p>
      {error && <p className="error">{error}</p>}
      {!items ? <p className="muted wide">Lädt …</p> : items.length === 0 ? (
        <p className="muted wide">{filter === "open" ? "Keine offenen Erstattungen." : filter === "done" ? "Noch nichts abgehakt." : "Noch keine Erstattungen."}</p>
      ) : (
        <ul className="refund-list wide">
          {items.map((item) => <RefundRow key={item.key} item={item} weclappHref={weclappOrderHref(erpBaseUrl, item.externalOrderId)} canEdit={canEdit} busy={busy === item.key} onOpenCase={onOpenCase}
            onDone={(done, creditNoteNumber, amount) => act(item.key, async () => {
              if (amount) await api("POST", `${base}/refunds/details`, { conversationIds: item.conversationIds, amount });
              await api("POST", `${base}/refunds/done`, { conversationIds: item.conversationIds, done, creditNoteNumber });
            })}
            onDetails={(body) => act(item.key, () => api("POST", `${base}/refunds/details`, { conversationIds: item.conversationIds, ...body }))}
            onRemove={() => act(item.key, () => api("POST", `${base}/refunds/remove`, { conversationIds: item.conversationIds }))} />)}
        </ul>
      )}
    </div></div>
  );
}

function RefundRow({ item, weclappHref, canEdit, busy, onOpenCase, onDone, onDetails, onRemove }: {
  item: RefundListItem; weclappHref: string | null; canEdit: boolean; busy: boolean; onOpenCase: (id: string) => void;
  onDone: (done: boolean, creditNoteNumber: string | null, amount?: string) => void;
  onDetails: (body: { amount?: string | null; creditNoteNumber?: string | null }) => void;
  onRemove: () => void;
}) {
  const [amount, setAmount] = useState(fieldAmount(item));
  const [creditNote, setCreditNote] = useState(item.done?.creditNoteNumber ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const done = !!item.done;
  const savedAmount = fieldAmount(item);
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setAmount(savedAmount); (e.target as HTMLInputElement).blur(); } };
  const id = `refund-${item.key}`;
  // Ticking off stores the amount shown, so the done entry keeps it even when it came from the notice.
  const keepAmount = () => (amount.trim() && (item.amount?.from !== "entered" || amount.trim() !== savedAmount) ? amount.trim() : undefined);
  return (
    <li className={done ? "refund-row done" : "refund-row"}>
      <label className="refund-tick" htmlFor={id} title={done ? "Abhaken zurücknehmen" : "In weclapp erledigt"}>
        <input id={id} type="checkbox" checked={done} disabled={!canEdit || busy} onChange={(e) => onDone(e.target.checked, creditNote.trim() || null, e.target.checked ? keepAmount() : undefined)} />
        <span className="sr-only">{done ? "Erledigt, zurücknehmen" : "In weclapp erledigt"}</span>
      </label>
      <div className="refund-order">
        <div className="refund-number">{item.orderNumber ?? item.marketplaceOrderNumber ?? "ohne Bestellnummer"}</div>
        <div className="small muted">
          <span className="tag">{PLATFORM_LABEL[item.platform] ?? item.platform}</span>
          {item.orderNumber && item.marketplaceOrderNumber ? ` · ${item.marketplaceOrderNumber}` : ""}
        </div>
        {item.customer && <div className="small ellipsis">{item.customer}</div>}
        {weclappHref && <a className="button small weclapp-link" href={weclappHref} target="_blank" rel="noopener noreferrer">Auftrag in weclapp ↗</a>}
      </div>
      <div className="refund-items small">
        <div className="refund-kind">{KIND_LABEL[item.kind]}</div>
        {item.items.length > 0 ? (
          <>
            <ul>{item.items.slice(0, 6).map((i, n) => <li key={n}><span className="mono">{i.quantity} ×</span> {i.title}</li>)}</ul>
            {item.items.length > 6 && <span className="muted">und {item.items.length - 6} weitere</span>}
            <span className="muted">{item.itemsFrom === "return" ? "laut Retoure in weclapp" : "alle Artikel der Bestellung"}</span>
          </>
        ) : <span className="muted">Keine Bestellung aus weclapp zugeordnet.</span>}
        {item.note && <div className="muted">Notiz: {item.note}</div>}
      </div>
      <div className="refund-amount">
        {canEdit && !done ? (
          <label className="field">
            <span>Betrag</span>
            <input inputMode="decimal" value={amount} placeholder="z. B. 12,50" disabled={busy}
              onChange={(e) => setAmount(e.target.value)} onKeyDown={blurOnEnter}
              onBlur={() => { if (amount.trim() !== savedAmount) onDetails({ amount: amount.trim() || null }); }} />
          </label>
        ) : <div className="refund-sum">{amountText(item.amount) || "–"}</div>}
        {item.amount?.from === "notice" && <div className="small muted">laut Meldung des Marktplatzes</div>}
        {item.creditNotes.length > 0 && !done && <div className="small warn-text" title="In der zuletzt abgerufenen Bestellung steht schon eine Gutschrift. Vielleicht ist das schon erledigt.">In weclapp: Gutschrift {item.creditNotes.join(", ")}</div>}
      </div>
      <div className="refund-state small">
        {done ? (
          <>
            <div className="state ok">Erledigt {fmtDay(item.done!.at)}{item.done!.by ? ` · ${item.done!.by}` : ""}</div>
            {item.done!.creditNoteNumber && <div className="mono">Gutschrift {item.done!.creditNoteNumber}</div>}
          </>
        ) : canEdit ? (
          <label className="field">
            <span>Gutschrift-Nr. (optional)</span>
            <input value={creditNote} placeholder="aus weclapp" disabled={busy} onChange={(e) => setCreditNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onDone(true, creditNote.trim() || null, keepAmount()); }} />
          </label>
        ) : <div className="muted">offen seit {fmtDay(item.since)}</div>}
        {!done && canEdit && <div className="muted">offen seit {fmtDay(item.since)}</div>}
      </div>
      <div className="refund-cases small">
        {item.cases.map((c) => (
          <button key={c.id} className="link" title={`${SOURCE_LABEL[c.source]} · ${fmtDate(c.at)}`} onClick={() => onOpenCase(c.id)}>
            {c.source === "notice" ? "Meldung" : "Fall"}: {c.subject || "(ohne Betreff)"}
          </button>
        ))}
        {canEdit && !done && (confirmRemove ? (
          <span className="row wrap">Keine Erstattung? <button className="small" disabled={busy} onClick={onRemove}>Von der Liste nehmen</button><button className="link" onClick={() => setConfirmRemove(false)}>Abbrechen</button></span>
        ) : <button className="link muted-link" onClick={() => setConfirmRemove(true)}>Gehört nicht auf die Liste</button>)}
      </div>
    </li>
  );
}
