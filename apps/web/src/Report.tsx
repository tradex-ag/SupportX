import { useEffect, useState } from "react";
import { api, PLATFORM_LABEL } from "./api.ts";
import { OUTCOME_LABEL } from "./CaseView.tsx";
import { INTENT_LABEL } from "./Inbox.tsx";

interface ReportData {
  days: number;
  cases: number;
  byTopic: Record<string, number>;
  byPlatform: Record<string, number>;
  outcomes: Record<string, number>;
  firstReply: { answered: number; medianHours: number | null; withDeadline: number; inTime: number; overdueOpen: number };
  articles: Array<{ article: string; number: string | null; total: number; byTopic: Record<string, number> }>;
}

const fmtHours = (h: number) => (h < 1 ? `${Math.round(h * 60)} Min.` : `${h.toLocaleString("de-DE")} Std.`);

function Counts({ data, labels }: { data: Record<string, number>; labels: Record<string, string> }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="muted small">Noch keine Daten.</p>;
  return (
    <table>
      <tbody>{rows.map(([k, n]) => <tr key={k}><td>{labels[k] ?? k}</td><td className="num">{n}</td></tr>)}</tbody>
    </table>
  );
}

/** Evaluation from SupportX's own data: no AI, nothing is fetched from outside. */
export function Report({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api<ReportData>("GET", `/api/w/${workspaceId}/report?days=${days}`).then(setData, (e) => setError((e as Error).message));
  }, [workspaceId, days]);

  return (
    <div className="settings-scroll"><div className="settings report">
      <div className="settings-title wide row">
        <h2>Auswertung</h2>
        <div className="row">
          {[7, 30, 90].map((d) => <button key={d} className={days === d ? "chip active" : "chip"} onClick={() => setDays(d)}>{d} Tage</button>)}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <p className="muted">Lädt …</p> : (
        <>
          <section className="card">
            <h3>Antwortzeit</h3>
            <p className="muted">{data.cases} Kundenanfragen mit erster Nachricht in den letzten {data.days} Tagen.</p>
            <div className="kv"><span>Beantwortet</span><span>{data.firstReply.answered} von {data.cases}</span></div>
            <div className="kv"><span>Erste Antwort im Median nach</span><span>{data.firstReply.medianHours === null ? "–" : fmtHours(data.firstReply.medianHours)}</span></div>
            <div className="kv"><span>In der Frist beantwortet</span><span>{data.firstReply.withDeadline ? `${data.firstReply.inTime} von ${data.firstReply.withDeadline} (${Math.round((data.firstReply.inTime / data.firstReply.withDeadline) * 100)} %)` : "keine Frist eingestellt"}</span></div>
            <div className="kv"><span>Überfällig und noch offen</span><span className={data.firstReply.overdueOpen ? "state bad" : ""}>{data.firstReply.overdueOpen}</span></div>
            <p className="muted small">Zählt Antworten über SupportX und Antworten aus Seller Central (Amazons Kopie). „In der Frist“ zählt beantwortete Fälle und solche, deren Frist schon abgelaufen ist. Frist laut Einstellungen.</p>
          </section>
          <section className="card">
            <h3>Anliegen</h3>
            <Counts data={data.byTopic} labels={INTENT_LABEL} />
          </section>
          <section className="card">
            <h3>Kanäle</h3>
            <Counts data={data.byPlatform} labels={PLATFORM_LABEL} />
          </section>
          <section className="card">
            <h3>Ergebnis</h3>
            <Counts data={data.outcomes} labels={OUTCOME_LABEL} />
            <p className="muted small">Aus „Was wurde danach gemacht?“ im Fall.</p>
          </section>
          <section className="card wide">
            <h3>Probleme je Artikel</h3>
            <p className="muted">Fälle mit „Beschädigt“, „Falscher Artikel“ oder „Rücksendung“, nach den Artikeln der zugeordneten Bestellung in weclapp. Eine Bestellung mit mehreren Artikeln zählt bei jedem.</p>
            {data.articles.length === 0 ? <p className="muted small">Keine solchen Fälle mit eindeutiger Bestellung.</p> : (
              <table>
                <thead><tr><th>Artikel</th><th className="num">Fälle</th><th className="num">Beschädigt</th><th className="num">Falsch</th><th className="num">Rücksendung</th></tr></thead>
                <tbody>
                  {data.articles.map((a) => (
                    <tr key={`${a.number}:${a.article}`}>
                      <td>{a.article}{a.number && <span className="muted small"> · {a.number}</span>}</td>
                      <td className="num">{a.total}</td>
                      <td className="num">{a.byTopic.damaged_item ?? 0}</td>
                      <td className="num">{a.byTopic.wrong_item ?? 0}</td>
                      <td className="num">{a.byTopic.return_request ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div></div>
  );
}
