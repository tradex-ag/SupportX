import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "./api.ts";
import { amazonMarketplaceLabel } from "../../../packages/core/amazon-marketplaces.ts";

export interface ListingAction {
  id: string; marketplace_id: string; sku: string; asin: string | null; item_name: string | null;
  state: "pending" | "accepted" | "rejected" | "uncertain" | "failed"; submission_id: string | null;
  issues: Array<{ code: string; message: string; severity: string }>; error: string | null; created_at: string; finished_at: string | null; requested_by: string;
}

interface Listing {
  sku: string; marketplaceId: string; asin?: string; itemName?: string; productType?: string; status: string[];
  offers: Array<{ offerType: string; currency: string; amount?: string }>; fulfillment: Array<{ channel: string; quantity?: number }>;
  issues: Array<{ code: string; message: string; severity: string }>; canClose: boolean;
}

export const LISTING_STATE: Record<ListingAction["state"], { label: string; tone: string }> = {
  pending: { label: "läuft", tone: "muted" },
  accepted: { label: "von Amazon angenommen", tone: "ok" },
  rejected: { label: "von Amazon abgelehnt", tone: "bad" },
  uncertain: { label: "unklar, bei Amazon prüfen", tone: "warn" },
  failed: { label: "nicht gesendet", tone: "bad" },
};

/** One line for the case history. */
export function listingActionText(a: ListingAction): string {
  return `Amazon-Angebot deaktivieren: SKU ${a.sku}${a.asin ? ` (ASIN ${a.asin})` : ""} auf ${amazonMarketplaceLabel(a.marketplace_id)}. Ausgelöst von ${a.requested_by}.`;
}

/**
 * Case card: read the Amazon offer, then close it after a confirmation dialog.
 * Nothing happens without the two clicks; the result stays with the case.
 */
export function AmazonOfferCard({ base, caseId, marketplaceIds, skus, actions, canEdit, onDone }: {
  base: string; caseId: string; marketplaceIds: string[]; skus: string[]; actions: ListingAction[]; canEdit: boolean; onDone: () => void;
}) {
  const [sku, setSku] = useState(skus[0] ?? "");
  const [marketplaceId, setMarketplaceId] = useState(marketplaceIds[0] ?? "");
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setListing(null); }, [sku, marketplaceId]);

  const lookup = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      setListing(await api<Listing>("POST", `${base}/cases/${caseId}/amazon-listing/lookup`, { sku: sku.trim(), marketplaceId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (!listing) return;
    dialog.current?.close();
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<{ state: "accepted" | "rejected" | "uncertain"; issues: Array<{ message: string }> }>("POST", `${base}/cases/${caseId}/amazon-listing/close`, { sku: listing.sku || sku.trim(), marketplaceId, confirm: true, expectedAsin: listing.asin });
      if (r.state === "accepted") setNotice({ tone: "ok", text: "Amazon hat die Änderung angenommen. Es kann einige Minuten dauern, bis das Angebot nicht mehr kaufbar ist." });
      else if (r.state === "uncertain") setNotice({ tone: "warn", text: "Keine Antwort von Amazon. Bitte mit „Angebot bei Amazon prüfen“ nachsehen, bevor du es noch einmal versuchst." });
      else setNotice({ tone: "bad", text: `Amazon hat abgelehnt: ${r.issues.map((i) => i.message).join("; ") || "ohne Grund"}` });
      setListing(null);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const price = listing?.offers.map((o) => `${o.amount ?? "?"} ${o.currency}${o.offerType === "B2B" ? " (Business)" : ""}`).join(", ");
  const stock = listing?.fulfillment.map((f) => `${f.quantity ?? "?"} ${f.channel === "DEFAULT" ? "selbst versendet" : "bei Amazon (FBA)"}`).join(", ");
  return (
    <section className="card">
      <h3>Amazon-Angebot</h3>
      <p className="muted small">Hat der Kunde recht, weil das Angebot bei Amazon falsch ist (z. B. 2 statt 1 Flasche), kannst du es hier deaktivieren. Es ist danach nicht mehr kaufbar. Preis, Bestand und Text bleiben; wieder öffnen geht in Seller Central (Enddatum des Angebots entfernen).</p>
      {canEdit && (
        <div className="stack">
          <label>Amazon-SKU (Händler-SKU)
            <input list={`skus-${caseId}`} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="z. B. Artikelnummer" spellCheck={false} />
            <datalist id={`skus-${caseId}`}>{skus.map((s) => <option key={s} value={s} />)}</datalist>
          </label>
          {skus.length > 0 && <span className="muted small">Vorschläge aus den Artikelnummern der Bestellung in weclapp. Bitte prüfen, ob die SKU bei Amazon gleich heißt.</span>}
          {marketplaceIds.length > 1 && (
            <label>Marktplatz
              <select value={marketplaceId} onChange={(e) => setMarketplaceId(e.target.value)}>
                {marketplaceIds.map((m) => <option key={m} value={m}>{amazonMarketplaceLabel(m)}</option>)}
              </select>
            </label>
          )}
          <div className="row"><button onClick={() => void lookup()} disabled={busy || !sku.trim()}>Angebot bei Amazon prüfen</button></div>
        </div>
      )}
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className={`notice ${notice.tone} small`}>{notice.text}</p>}
      {listing && (
        <div className="facts">
          <div className="kv"><span>Titel</span><strong>{listing.itemName ?? "–"}</strong></div>
          <div className="kv"><span>ASIN / SKU</span><span>{listing.asin ?? "–"} · {listing.sku || sku}</span></div>
          <div className="kv"><span>Marktplatz</span><span>{amazonMarketplaceLabel(listing.marketplaceId)}</span></div>
          <div className="kv"><span>Status</span><span className={`pill ${listing.canClose ? "ok" : "muted"}`}>{listing.status.includes("BUYABLE") ? "kaufbar" : "nicht kaufbar"}</span></div>
          {price && <div className="kv"><span>Preis</span><span>{price}</span></div>}
          {stock && <div className="kv"><span>Bestand</span><span>{stock}</span></div>}
          {listing.issues.length > 0 && <p className="small warn-text">Hinweise von Amazon: {listing.issues.map((i) => i.message).join("; ")}</p>}
          {listing.canClose ? (
            canEdit && <div className="row"><button className="danger" disabled={busy} onClick={() => dialog.current?.showModal()}>Angebot deaktivieren …</button></div>
          ) : (
            <p className="small muted">Dieses Angebot ist schon nicht kaufbar. Nichts zu tun.</p>
          )}
        </div>
      )}
      <dialog ref={dialog} className="confirm-dialog" aria-labelledby={`amz-confirm-${caseId}`}>
        <h3 id={`amz-confirm-${caseId}`}>Amazon-Angebot deaktivieren?</h3>
        {listing && (
          <p>„{listing.itemName ?? listing.sku}“<br /><span className="muted small">SKU {listing.sku || sku} · ASIN {listing.asin ?? "–"} · {amazonMarketplaceLabel(listing.marketplaceId)}</span></p>
        )}
        <p className="small">Kunden können das Angebot danach nicht mehr kaufen. SupportX setzt dafür bei Amazon ein Enddatum in der Vergangenheit. Wieder öffnen geht nur in Seller Central.</p>
        <div className="row">
          <button className="danger" onClick={() => void close()}>Ja, deaktivieren</button>
          <button onClick={() => dialog.current?.close()}>Abbrechen</button>
        </div>
      </dialog>
      {actions.length > 0 && (
        <>
          <h4>Bisher in diesem Fall</h4>
          <ul className="history">
            {actions.map((a) => (
              <li key={a.id}>
                <span className="muted small">{fmtDate(a.created_at)}</span> SKU {a.sku}{a.asin ? ` (${a.asin})` : ""}, {amazonMarketplaceLabel(a.marketplace_id)} <span className={`pill ${LISTING_STATE[a.state].tone}`}>{LISTING_STATE[a.state].label}</span>
                <div className="muted small">von {a.requested_by}{a.submission_id ? ` · Amazon-Vorgang ${a.submission_id}` : ""}{a.error ? ` · ${a.error}` : ""}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
