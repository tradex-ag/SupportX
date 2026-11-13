import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { sinceLabel } from "../../../packages/core/fetch-freshness.ts";

export interface FetchState {
  id: string; kind: string; displayName: string; lastSyncAt: string | null;
  background: boolean; stale: boolean; fetching: boolean; health: string;
}

/**
 * One line per channel that needs attention in the inbox: Shop Apotheke (read
 * while the inbox is open, as Mirakl documents it) and any connection that has
 * not been read for hours. Reports "inbox on screen" to the server once a
 * minute while the tab is visible; the server decides whether a read is due.
 */
export function FetchStatus({ workspaceId, canFetch, onFetched }: { workspaceId: string; canFetch: boolean; onFetched: () => void }) {
  const [states, setStates] = useState<FetchState[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const report = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    try {
      const r = await api<{ connections: FetchState[] }>("POST", `/api/w/${workspaceId}/inbox/displayed`);
      setStates((prev) => {
        // A read just finished: reload the case list once.
        if (prev.some((p) => p.fetching && r.connections.some((c) => c.id === p.id && !c.fetching))) onFetched();
        return r.connections;
      });
    } catch { /* the case list shows connection errors already */ }
  }, [workspaceId, onFetched]);
  useEffect(() => {
    void report();
    const t = setInterval(() => void report(), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void report(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [report]);
  // While a read runs, look again sooner so the line updates.
  useEffect(() => {
    if (!states.some((s) => s.fetching)) return;
    const t = setTimeout(() => void report(), 5_000);
    return () => clearTimeout(t);
  }, [states, report]);

  const shown = states.filter((s) => s.stale || !s.background);
  if (shown.length === 0) return null;
  const fetchNow = async (id: string) => {
    setBusy(id);
    try { await api("POST", `/api/w/${workspaceId}/connections/${id}/sync`); await report(); } catch { /* shown on the next report */ } finally { setBusy(null); }
  };
  return (
    <div className="fetch-status small pad">
      {shown.map((s) => (
        <div key={s.id} className="row">
          {s.fetching ? <span className="muted">{s.displayName}: wird gerade abgerufen …</span>
            : s.stale ? <span className="deadline bad" title="Neue Nachrichten von hier fehlen womöglich im Posteingang."><i aria-hidden="true" />{s.displayName} {s.lastSyncAt ? `seit ${sinceLabel(s.lastSyncAt).replace(/^vor /, "")} nicht abgerufen` : "noch nie abgerufen"}</span>
            : <span className="muted" title="Wird automatisch abgerufen, sobald SupportX geöffnet wird, und danach alle 10 Min., solange der Posteingang offen ist. Rund um die Uhr erst nach Freigabe durch den Marktplatz.">{s.displayName}: abgerufen {sinceLabel(s.lastSyncAt)} · automatisch beim Öffnen</span>}
          {canFetch && !s.fetching && <button className="link" disabled={busy === s.id} onClick={() => void fetchNow(s.id)}>Jetzt abrufen</button>}
        </div>
      ))}
    </div>
  );
}
