import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, MATCH_LABEL, OUTBOX_LABEL, PLATFORM_LABEL } from "./api.ts";
import { CaseView } from "./CaseView.tsx";
import { deadlineState } from "../../../packages/core/deadline.ts";

type Role = "owner" | "agent" | "viewer";

interface CaseRow {
  id: string;
  subject: string;
  status: string;
  category: "support" | "info";
  category_reason: string | null;
  source_platform: string;
  customer_address: string | null;
  customer_name: string | null;
  order_match_status: string;
  last_message_at: string | null;
  last_error: string | null;
  merchant_account_name: string | null;
  assignee_name: string | null;
  draft_status: string | null;
  intent: string | null;
  outbox_state: string | null;
  message_count: number;
  snooze_until: string | null;
  topic: string | null;
  open_by: string | null;
  waiting_since: string | null;
  reply_hours: number | null;
}

const FILTERS = [
  { id: "open", label: "Anfragen", count: "open" },
  { id: "needs_attention", label: "Klärung nötig", count: "needs_attention" },
  { id: "waiting", label: "Wartet", count: null },
  { id: "closed", label: "Erledigt", count: null },
  { id: "info", label: "Werbung & Infos", count: "info" },
  { id: "all", label: "Alle", count: null },
] as const;
type Counts = { open: number; needs_attention: number; info: number };

/** One short line saying where the case stands, instead of a row of badges. */
function caseState(c: CaseRow): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (c.category === "info") return { text: c.category_reason ? `Erkannt: ${c.category_reason}` : "Werbung oder Info", tone: "muted" };
  if (c.last_error) return { text: "Fehler, bitte ansehen", tone: "bad" };
  if (c.outbox_state === "delivery_uncertain" || c.outbox_state === "failed") return { text: OUTBOX_LABEL[c.outbox_state] ?? c.outbox_state, tone: "bad" };
  if (c.outbox_state && c.outbox_state !== "suppressed") return { text: `Antwort ${OUTBOX_LABEL[c.outbox_state] ?? c.outbox_state}`, tone: "ok" };
  if (c.status === "closed") return { text: "Erledigt", tone: "muted" };
  if (c.status === "waiting") return { text: c.snooze_until ? `Wartet, Wiedervorlage ${fmtDay(c.snooze_until)}` : "Wartet auf Kunde", tone: "muted" };
  if (c.status === "open" && c.snooze_until && new Date(c.snooze_until) <= new Date()) return { text: `Wiedervorlage vom ${fmtDay(c.snooze_until)}`, tone: "warn" };
  if (c.order_match_status === "pending") return { text: "Wird vorbereitet …", tone: "muted" };
  if (c.draft_status === "proposed" || c.draft_status === "edited") {
    const match = MATCH_LABEL[c.order_match_status];
    return c.order_match_status === "unique" ? { text: "Antwortentwurf bereit", tone: "ok" } : { text: `Entwurf bereit · Bestellung ${match?.label ?? c.order_match_status}`, tone: "warn" };
  }
  return { text: `Bestellung ${MATCH_LABEL[c.order_match_status]?.label ?? c.order_match_status}`, tone: "warn" };
}

export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

export const INTENT_LABEL: Record<string, string> = {
  parcel_status: "Paketstatus",
  wrong_item: "Falscher Artikel",
  damaged_item: "Beschädigt",
  return_request: "Rücksendung",
  invoice: "Rechnung",
  product_question: "Produktfrage",
  other: "Sonstiges",
};

export function Inbox({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("open");
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  // Search after a short pause in typing, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim().length >= 2 ? search.trim() : ""), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const q = (query ? `&q=${encodeURIComponent(query)}` : "") + (topic ? `&topic=${topic}` : "");
      const data = await api<{ cases: CaseRow[]; counts: Counts }>("GET", `/api/w/${workspaceId}/cases?filter=${filter}${q}`);
      setCases(data.cases);
      setCounts(data.counts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceId, filter, query, topic]);
  // Re-draw the countdowns every minute even when nothing new arrives.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="inbox">
      <aside className="case-list">
        <div className="list-head">
        <div className="case-search">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Suchen: Bestellnummer, Name, Mail, Text …" aria-label="Fälle durchsuchen" />
          <select value={topic} onChange={(e) => { setTopic(e.target.value); setSelected(null); }} aria-label="Nach Anliegen filtern" className={topic ? "active" : ""}>
            <option value="">Alle Anliegen</option>
            {Object.entries(INTENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className={query ? "filters dimmed" : "filters"}>
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id && !query ? "chip active" : "chip"} onClick={() => { setFilter(f.id); setSearch(""); setQuery(""); setSelected(null); }}>
              {f.label}{f.count && counts ? <span className="count">{counts[f.count]}</span> : null}
            </button>
          ))}
        </div>
        </div>
        {query && <p className="muted small pad">{cases.length === 200 ? "Mehr als 200" : cases.length} {cases.length === 1 ? "Treffer" : "Treffer"} für „{query}“ in allen Fällen. <button className="link" onClick={() => setSearch("")}>Suche löschen</button></p>}
        {!query && filter === "info" && <p className="muted small pad">Newsletter, Aktionen und Partner-Infos. Sie bekommen keinen Antwortentwurf. Ist eine Kundenanfrage dabei, im Fall auf „Ist eine Kundenanfrage“ klicken.</p>}
        {error && <p className="error pad">{error}</p>}
        {cases.length === 0 && <p className="muted pad">{query ? "Nichts gefunden." : "Hier ist gerade nichts."}</p>}
        <ul>
          {cases.map((c) => {
            const state = caseState(c);
            const due = deadlineState(c.waiting_since, c.reply_hours);
            return (
              <li key={c.id} className={selected === c.id ? "case-item selected" : "case-item"} onClick={() => setSelected(c.id)}>
                <div className="row">
                  <span className="muted small ellipsis">{c.customer_name || c.customer_address}</span>
                  <span className="muted small nowrap">{fmtDate(c.last_message_at)}</span>
                </div>
                <div className="subject">{c.subject || "(ohne Betreff)"}</div>
                <div className="row wrap small">
                  <span className="tag">{PLATFORM_LABEL[c.source_platform] ?? c.source_platform}</span>
                  {c.category === "support" && (c.topic ?? c.intent) && <span className="muted">{INTENT_LABEL[(c.topic ?? c.intent)!] ?? c.topic ?? c.intent}</span>}
                  <span className={`state ${state.tone}`}>{state.text}</span>
                  {due && <span className={`deadline ${due.tone}`} title={`Antwort fällig bis ${fmtDate(due.dueAt.toISOString())} (${c.reply_hours} Std. ab der Kundennachricht)`}><i aria-hidden="true" />{due.label}</span>}
                </div>
                {c.open_by && <div className="small presence-line">Gerade offen bei {c.open_by}</div>}
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="case-detail">
        {selected ? <CaseView key={selected} workspaceId={workspaceId} caseId={selected} role={role} onChanged={load} /> : <div className="center muted">Fall auswählen</div>}
      </main>
    </div>
  );
}
