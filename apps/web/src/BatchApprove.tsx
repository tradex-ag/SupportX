import { useEffect, useState } from "react";
import { api, PLATFORM_LABEL } from "./api.ts";

interface Item {
  conversationId: string; subject: string; customer: string | null; platform: string;
  draftId: string | null; version: number | null; body: string | null; ready: boolean; reasons: string[];
}

/** Read several ready replies on one page and approve them at once. */
export function BatchApprove({ workspaceId, ids, onDone, onOpen, onClear }: { workspaceId: string; ids: string[]; onDone: () => void; onOpen: (id: string) => void; onClear: () => void }) {
  const base = `/api/w/${workspaceId}`;
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string> | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    setResults(null);
    api<{ items: Item[] }>("POST", `${base}/batch/candidates`, { conversationIds: ids }).then((r) => setItems(r.items), (e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key]);

  if (!items) return <div className="center muted">{error ?? "Lädt …"}</div>;
  const ready = items.filter((i) => i.ready && i.draftId && i.version);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ results: Array<{ draftId: string; ok: boolean; error?: string }> }>("POST", `${base}/batch/approve-send`, { items: ready.map((i) => ({ draftId: i.draftId, expectedVersion: i.version })) });
      setResults(Object.fromEntries(r.results.map((x) => [x.draftId, x.ok ? "ok" : x.error ?? "Fehler"])));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sentCount = results ? Object.values(results).filter((v) => v === "ok").length : 0;

  return (
    <div className="case batch">
      <div className="case-head">
        <h2>{ids.length === 1 ? "1 Antwort ausgewählt" : `${ids.length} Antworten ausgewählt`}</h2>
        <p className="muted small">Bitte jede Antwort lesen. Freigegeben wird genau der Text, der hier steht. Entwürfe mit Hinweisen werden nur einzeln im Fall freigegeben.</p>
        <div className="row wrap">
          {!results && <button className="primary" disabled={busy || ready.length === 0} onClick={send}>{busy ? "Wird gesendet …" : ready.length === 0 ? "Keine davon gemeinsam freigebbar" : ready.length === 1 ? "1 Antwort freigeben und senden" : `${ready.length} Antworten freigeben und senden`}</button>}
          <button onClick={onClear}>{results ? "Fertig" : "Auswahl aufheben"}</button>
        </div>
        {results && <p className={sentCount === ready.length ? "notice ok" : "notice bad"}>{sentCount} von {ready.length} freigegeben und zum Senden übergeben.</p>}
        {error && <p className="notice bad">{error}</p>}
      </div>
      {items.map((i) => {
        const result = i.draftId ? results?.[i.draftId] : undefined;
        return (
          <section key={i.conversationId} className={i.ready ? "card" : "card dimmed"}>
            <div className="row">
              <button className="link" onClick={() => onOpen(i.conversationId)}>{i.subject || "(ohne Betreff)"}</button>
              <span className="muted small">{[PLATFORM_LABEL[i.platform] ?? i.platform, i.customer].filter(Boolean).join(" · ")}</span>
            </div>
            {i.body && <pre className="body">{i.body}</pre>}
            {i.reasons.length > 0 && <p className="state warn small">Nicht dabei: {i.reasons.join(" ")}</p>}
            {result && <p className={result === "ok" ? "state ok small" : "state bad small"}>{result === "ok" ? "Freigegeben und zum Senden übergeben." : result}</p>}
          </section>
        );
      })}
    </div>
  );
}
