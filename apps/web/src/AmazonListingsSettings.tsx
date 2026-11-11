import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api.ts";
import { AMAZON_MARKETPLACES, AMAZON_REGION_LABEL, type AmazonRegion } from "../../../packages/core/amazon-marketplaces.ts";

type Settings =
  | { configured: false }
  | { configured: true; region: AmazonRegion; sellerIdHint: string; clientIdHint: string; marketplaceIds: string[]; status: string; lastCheckedAt: string | null; lastError: string | null };

/**
 * Settings card for the Amazon Selling Partner API access that lets a person
 * close a wrong offer from a case. Stored values are shown masked only; they can
 * be changed after clicking "Ändern".
 */
export function AmazonListingsCard({ base, owner }: { base: string; owner: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Settings>("GET", `${base}/amazon-listings`).then(setData, (e: Error) => setError(e.message)), [base]);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    setError(null); setNotice(null);
    try {
      setNotice(ok(await fn()));
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  const connected = data.configured && data.status === "ok";
  const pill = !data.configured ? { cls: "pill muted", label: "Nicht eingerichtet" } : data.status === "error" ? { cls: "pill bad", label: "Fehler" } : connected ? { cls: "pill ok", label: "Angebunden" } : { cls: "pill warn", label: "Noch nicht getestet" };
  return (
    <section className={`card setup${connected ? " connected" : ""}`} aria-label="Amazon-Angebote">
      <div className="setup-head">
        <div>
          <h3 className="setup-name">Amazon-Angebote</h3>
          <div className="muted small">Selling Partner API · falsches Angebot aus dem Fall deaktivieren</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      <p className="muted small">Hat ein Kunde recht, weil das Amazon-Angebot falsch ist, kann man es im Fall mit einem Klick und einer Bestätigung deaktivieren. Nie automatisch. Die SP-API-App braucht die Rolle „Product Listing“; der Verkäufer autorisiert sie einmal in Seller Central und erhält dabei den Refresh-Token.</p>
      {error && <p className="notice bad small">{error}</p>}
      {notice && <p className="notice ok small">{notice}</p>}
      {data.configured && !editing && (
        <>
          <div className="facts">
            <div className="kv"><span>Region</span><span>{AMAZON_REGION_LABEL[data.region]}</span></div>
            <div className="kv"><span>Marktplätze</span><span>{data.marketplaceIds.map((id) => AMAZON_MARKETPLACES.find((m) => m.id === id)?.label ?? id).join(", ")}</span></div>
            <div className="kv"><span>Verkäufer-ID</span><code>{data.sellerIdHint}</code></div>
            <div className="kv"><span>LWA Client-ID</span><code>{data.clientIdHint}</code></div>
            <div className="kv"><span>Client-Secret, Refresh-Token</span><span>hinterlegt</span></div>
            {data.lastCheckedAt && <div className="kv"><span>Geprüft</span><span>{fmtDate(data.lastCheckedAt)}</span></div>}
          </div>
          {data.lastError && <p className="notice bad small">{data.lastError}</p>}
          {owner && (
            <div className="row wrap">
              <button className={connected ? "" : "primary"} onClick={() => void run(() => api("POST", `${base}/amazon-listings/check`), (r) => { const x = r as { ok: boolean; detail: string }; return `${x.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${x.detail}`; })}>Verbindung testen</button>
              <button onClick={() => setEditing(true)}>Ändern</button>
              <button className="danger" onClick={() => { if (window.confirm("Amazon-Zugang entfernen? Angebote lassen sich dann nicht mehr aus dem Fall deaktivieren. Bei Amazon ändert sich nichts.")) void run(() => api("DELETE", `${base}/amazon-listings`), () => "Amazon-Zugang entfernt."); }}>Entfernen</button>
            </div>
          )}
        </>
      )}
      {owner && (!data.configured || editing) && (
        <AmazonForm
          current={data.configured ? data : null}
          onCancel={data.configured ? () => setEditing(false) : undefined}
          onSubmit={(body) => void run(() => api("PUT", `${base}/amazon-listings`, body), () => "Gespeichert. Bitte einmal „Verbindung testen“.")}
        />
      )}
      {!owner && !data.configured && <p className="small muted">Nur Inhaber können den Zugang eintragen.</p>}
    </section>
  );
}

function AmazonForm({ current, onSubmit, onCancel }: {
  current: Extract<Settings, { configured: true }> | null; onSubmit: (body: Record<string, unknown>) => void; onCancel?: () => void;
}) {
  const [region, setRegion] = useState<AmazonRegion>(current?.region ?? "eu");
  const [markets, setMarkets] = useState<string[]>(current?.marketplaceIds ?? ["A1PA6795UKMFR9"]);
  const [sellerId, setSellerId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const keep = current ? "leer lassen = bleibt wie gespeichert" : undefined;
  const inRegion = AMAZON_MARKETPLACES.filter((m) => m.region === region);
  const toggle = (id: string) => setMarkets((ms) => (ms.includes(id) ? ms.filter((x) => x !== id) : [...ms, id]));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const only = (v: string) => (v.trim() ? v.trim() : undefined);
        onSubmit({ region, marketplaceIds: markets.filter((m) => inRegion.some((x) => x.id === m)), sellerId: only(sellerId), clientId: only(clientId), clientSecret: only(clientSecret), refreshToken: only(refreshToken) });
      }}
    >
      <label>Region
        <select value={region} onChange={(e) => setRegion(e.target.value as AmazonRegion)}>
          {(Object.keys(AMAZON_REGION_LABEL) as AmazonRegion[]).map((r) => <option key={r} value={r}>{AMAZON_REGION_LABEL[r]}</option>)}
        </select>
      </label>
      <fieldset className="stack">
        <legend className="small">Marktplätze, auf denen Angebote deaktiviert werden dürfen</legend>
        <div className="row wrap">
          {inRegion.map((m) => <label key={m.id} className="row small"><input type="checkbox" checked={markets.includes(m.id)} onChange={() => toggle(m.id)} /> {m.label}</label>)}
        </div>
      </fieldset>
      <label>Verkäufer-ID (Merchant Token, Seller Central → Einstellungen → Kontoinformationen → Händlertoken)
        <input value={sellerId} onChange={(e) => setSellerId(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? `${current.sellerIdHint} (${keep})` : "z. B. A1B2C3D4E5F6G7"} required={!current} />
      </label>
      <label>LWA Client-ID der SP-API-App
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? `${current.clientIdHint} (${keep})` : "amzn1.application-oa2-client.…"} required={!current} />
      </label>
      <label>LWA Client-Secret
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? keep : "amzn1.oa2-cs.v1.…"} required={!current} />
      </label>
      <label>Refresh-Token aus der Autorisierung des Verkäufers
        <input type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder={current ? keep : "Atzr|…"} required={!current} />
      </label>
      <p className="muted small">Client-Secret und Refresh-Token werden verschlüsselt gespeichert und nie wieder angezeigt. SupportX legt keine Zugangsdaten bei Amazon an und erneuert keine.</p>
      <div className="row">
        <button type="submit" className="primary">Speichern</button>
        {onCancel && <button type="button" onClick={onCancel}>Abbrechen</button>}
      </div>
    </form>
  );
}
