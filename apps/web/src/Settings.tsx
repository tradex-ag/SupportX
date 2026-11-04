import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, PLATFORM_LABEL } from "./api.ts";
import { DEADLINE_PLATFORMS, DEFAULT_REPLY_DEADLINES, MAX_DEADLINE_HOURS } from "../../../packages/core/deadline.ts";
import { SNIPPET_PLACEHOLDERS } from "../../../packages/core/snippet-placeholders.ts";
import { API_MARKETS, MAIL_MARKETS, MARKET_KIND, marketSetup, microsoftSetup, weclappSetup, type ChannelSetup, type StepAction } from "./setup-steps.ts";

type Role = "owner" | "agent" | "viewer";
interface Account { id: string; name: string; platform: string; order_scope_field: string; order_scope_value: string; paused: boolean }
type ChannelKind = "microsoft_graph" | "ebay_messages" | "kaufland_tickets" | "mirakl_inbox";
interface Connection {
  id: string; kind: ChannelKind; display_name: string;
  config: {
    mailbox?: string; tenantId?: string; clientId?: string; ownAddresses?: string[]; pushNotifications?: boolean; graphBaseUrl?: string;
    ruName?: string; sandbox?: boolean; sellerUsername?: string; storefronts?: string[]; baseUrl?: string; shopId?: string;
    backgroundSyncAllowed?: boolean; backgroundSyncEvidence?: string; pollIntervalSec?: number;
  };
  has_secret: boolean; default_merchant_account_id: string | null; default_source_platform: string; send_enabled: boolean; paused: boolean; health: string; last_sync_at: string | null; last_error: string | null;
}
interface Rule { id: string; connection_id: string; priority: number; match_type: string; pattern: string; source_platform: string; merchant_account_name: string | null }
interface Route { id: string; connection_id: string; source_platform: string; evidence_note: string; verified_at: string; verified_by: string | null }
interface Descriptor { platform: string; label: string; transport: string; implementation: string; receive: string; reply: string; accountTestNeeded: string[]; notes: string }
interface SettingsData {
  workspace: { name: string; auto_invoice?: "off" | "draft" | "send"; reply_signature: string; reply_tone: string; allowed_link_prefixes: string[]; ai_enabled: boolean; has_ai_key: boolean; ai_key_hint: string | null; setup_confirmations: Record<string, { at: string; by: string | null }>; reply_deadlines?: Record<string, number>; automations?: Record<string, { mode: "off" | "draft" | "send"; since: string | null }> };
  accounts: Account[]; connections: Connection[]; rules: Rule[]; routes: Route[];
  erp: null | { base_url: string; search_fields: string[]; has_secret: boolean; status: string; last_checked_at: string | null; last_error: string | null };
  categoryRules: Array<{ id: string; match_type: string; pattern: string; category: "support" | "info" }>;
  jobs: Array<{ type: string; status: string; count: number; last_error: string | null }>;
  catalog: Descriptor[]; ai: { provider: string; model: string; promptVersion: string }; sendMode: string; demoMode: boolean;
}

const PLATFORMS = ["email", "amazon", "ebay", "kaufland", "shop_apotheke", "docmorris", "shopify"];
const IMPL_LABEL: Record<string, string> = { implemented: "umgesetzt", via_microsoft_mail: "über Microsoft-Postfach", planned: "geplant" };
const KIND_LABEL: Record<ChannelKind, string> = { microsoft_graph: "Microsoft-Postfach", ebay_messages: "eBay", kaufland_tickets: "Kaufland", mirakl_inbox: "Shop Apotheke" };
const CAP_LABEL: Record<string, string> = { not_implemented: "nicht umgesetzt", documented: "dokumentiert, ungetestet", configured: "umgesetzt, Kontotest offen", verified: "mit Konto geprüft" };

export function Settings({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ card: string; action: StepAction } | null>(null);
  const base = `/api/w/${workspaceId}`;
  const owner = role === "owner";

  const load = useCallback(async () => {
    try {
      setData(await api<SettingsData>("GET", `${base}/settings`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, success?: (result: unknown) => string) => {
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (success) setNotice(success(result));
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return <div className="center muted">{error ?? "Lädt …"}</div>;
  const checkResult = (r: unknown) => {
    const res = r as { ok: boolean; detail: string };
    return `${res.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${res.detail}`;
  };

  const mailboxCount = (c: Connection) => (c.kind === "microsoft_graph" ? data.connections.filter((x) => x.kind === "microsoft_graph" && x.config.mailbox === c.config.mailbox).length : 1);
  const closePanel = () => setPanel(null);
  const checkFirst = (kind: string) => {
    const c = data.connections.find((x) => x.kind === kind);
    if (c) void act(() => api("POST", `${base}/connections/${c.id}/check`), checkResult);
  };
  const connectionCard = (c: Connection) => (
    <ConnectionCard
      key={c.id}
      c={c}
      owner={owner}
      duplicate={mailboxCount(c) > 1}
      base={base}
      act={act}
      checkResult={checkResult}
    />
  );

  return (
    <div className="settings-scroll"><div className="settings">
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}
      {!owner && <p className="notice muted">Nur Inhaber können Einstellungen ändern.</p>}

      <h2 className="settings-title">Anbindungen</h2>
      <p className="muted settings-sub">Jede Karte zeigt, was erledigt ist und was als Nächstes zu tun ist. Ein grüner Innenrand heißt: Nachrichten kommen an. Antworten bleiben Entwürfe, bis ein Antwortweg geprüft und der Versand freigeschaltet ist.</p>

      <SetupCard setup={microsoftSetup(data)} owner={owner} onAction={(a) => a === "check" ? checkFirst("microsoft_graph") : setPanel({ card: "microsoft", action: a })}>
        {data.connections.filter((c) => c.kind === "microsoft_graph").map((c) => connectionCard(c))}
        {owner && panel?.card === "microsoft" && panel.action === "connect" && <GraphForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections`, body), () => "Postfach verbunden. Die ersten Mails kommen in wenigen Minuten."); }} />}
      </SetupCard>

      <SetupCard setup={weclappSetup(data)} owner={owner} onAction={(a) => a === "check" ? void act(() => api("POST", `${base}/erp/check`), checkResult) : setPanel({ card: "weclapp", action: a })}>
        {data.erp && (
          <div className="facts">
            <div className="kv"><span>Adresse</span><code>{data.erp.base_url}</code></div>
            <div className="kv"><span>Zugang</span><span>{data.erp.has_secret ? "Token hinterlegt" : "Token fehlt"}{data.erp.last_checked_at ? ` · geprüft ${fmtDate(data.erp.last_checked_at)}` : ""}</span></div>
            <div className="kv"><span>Gesucht wird in</span><span>{data.erp.search_fields.join(", ")}</span></div>
          </div>
        )}
        {owner && (panel?.card === "weclapp" || !data.erp) && <ErpForm current={data.erp?.base_url ?? ""} onSubmit={(body) => { closePanel(); void act(() => api("PUT", `${base}/erp`, body), () => "weclapp gespeichert. Bitte einmal „Verbindung testen“."); }} />}
        {owner && data.erp && panel?.card !== "weclapp" && <div className="row"><button onClick={() => setPanel({ card: "weclapp", action: "erp" })}>Adresse oder Token ändern</button></div>}
      </SetupCard>

      <h2 className="settings-title">Marktplätze</h2>
      {[...API_MARKETS, ...MAIL_MARKETS].map((m) => {
        const kind = (API_MARKETS as readonly string[]).includes(m) ? MARKET_KIND[m as (typeof API_MARKETS)[number]] : null;
        const own = kind ? data.connections.filter((c) => c.kind === kind) : [];
        const graph = data.connections.find((c) => c.kind === "microsoft_graph");
        const open = (a: string) => panel?.card === m && panel.action === a;
        const onAction = (a: StepAction) => {
          if (a === "check" && kind) return checkFirst(kind);
          if (a === "confirm" || a === "unconfirm") return void act(() => api("POST", `${base}/setup-confirmations`, { platform: m, done: a === "confirm" }), () => a === "confirm" ? "Abgehakt." : "Haken entfernt.");
          if (a === "ebay_login" && own[0]) return void act(async () => { const r = await api<{ url: string }>("POST", `${base}/connections/${own[0]!.id}/ebay/authorize`); window.location.assign(r.url); });
          setPanel({ card: m, action: a });
        };
        return (
          <SetupCard key={m} setup={marketSetup(m, { ...data, confirmations: data.workspace.setup_confirmations })} owner={owner} onAction={onAction} graphMailbox={kind ? undefined : graph?.config.mailbox}
            serverSendOff={data.sendMode !== "enabled"}
            onSending={(on) => {
              const setup = marketSetup(m, { ...data, confirmations: data.workspace.setup_confirmations });
              if (!setup.sending) return;
              if (on && !window.confirm(`Antworten für ${PLATFORM_LABEL[m]} freischalten?\n\nJede Antwort geht erst raus, wenn du sie im Fall freigibst. Die erste Antwort bitte einmal im Marktplatz kontrollieren.`)) return;
              void act(() => api("POST", `${base}/connections/${setup.sending!.connectionId}/platform-sending`, { sourcePlatform: m, enabled: on }), () => on ? `Versand für ${PLATFORM_LABEL[m]} freigeschaltet.` : `Versand für ${PLATFORM_LABEL[m]} gesperrt.`);
            }}>
            {own.map((c) => connectionCard(c))}
            {owner && open("connect") && m === "ebay" && <EbayForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/ebay`, body), () => "eBay angelegt. Jetzt „Bei eBay anmelden“ klicken."); }} />}
            {owner && open("connect") && m === "kaufland" && <KauflandForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/kaufland`, body), () => "Kaufland verbunden. Bitte einmal „Verbindung testen“."); }} />}
            {owner && open("connect") && m === "shop_apotheke" && <MiraklForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/mirakl`, body), () => "Shop Apotheke verbunden. Bitte einmal „Verbindung testen“."); }} />}
          </SetupCard>
        );
      })}

      <h2 className="settings-title">Weitere Einstellungen</h2>
      {owner && (
        <section className="card">
          <h3>Auswertung</h3>
          <p className="muted small">Alle Kundenanfragen mit Kundentext, gesendeter Antwort und Maßnahme als CSV, z. B. für Excel. Grundlage, um Antworten später weiter zu automatisieren.</p>
          <a className="button" href={`${base}/export/cases.csv`} download>Fälle als CSV herunterladen</a>
        </section>
      )}
      <section className="card">
        <h3>Werbung erkennen</h3>
        <p className="muted">Newsletter, Aktionen und Partner-Infos erkennt SupportX selbst und legt sie unter „Werbung &amp; Infos“ ab, ohne Antwortentwurf. Liegt es einmal daneben, im Fall umschalten und dabei „Alle von …“ wählen. Das merkt sich SupportX hier.</p>
        {data.categoryRules.length === 0 ? <p className="small muted">Noch keine eigenen Absender-Regeln.</p> : (
          <table>
            <thead><tr><th>Absender</th><th>immer als</th><th /></tr></thead>
            <tbody>{data.categoryRules.map((r) => (
              <tr key={r.id}>
                <td><code>{r.match_type === "from_domain" ? `@${r.pattern}` : r.pattern}</code></td>
                <td>{r.category === "info" ? "Werbung/Info" : "Kundenanfrage"}</td>
                <td>{owner && <button className="link" onClick={() => act(() => api("DELETE", `${base}/category-rules/${r.id}`), () => "Regel entfernt.")}>entfernen</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <WorkspaceForm data={data} owner={owner} onSave={(body) => act(() => api("PUT", `${base}/settings`, body), () => "Gespeichert.")} />

      <SnippetsCard base={base} canEdit={role !== "viewer"} />
      <DeadlinesCard value={data.workspace.reply_deadlines ?? {}} owner={owner} onSave={(replyDeadlines) => act(() => api("PUT", `${base}/settings`, { replyDeadlines }), () => "Antwortfrist gespeichert.")} />

      <DocumentsCard base={base} owner={owner} />
      <AutoInvoiceCard value={data.workspace.auto_invoice ?? "off"} owner={owner} onChange={(autoInvoice) => void act(() => api("PUT", `${base}/settings`, { autoInvoice }), () => "Gespeichert.")} />
      <AutoParcelCard value={data.workspace.automations?.parcel_status?.mode ?? "off"} owner={owner} onChange={(mode) => void act(() => api("POST", `${base}/automations`, { topic: "parcel_status", mode }), () => "Gespeichert.")} />

      <DesignCard base={base} owner={owner} />

      <AiKeyCard
        data={data}
        owner={owner}
        onSave={(apiKey) => act(() => api("POST", `${base}/ai-key`, { apiKey }), () => (apiKey ? "Schlüssel geprüft und gespeichert. Neue Entwürfe schreibt jetzt Claude." : "Eigener Schlüssel entfernt."))}
        onCheck={() => act(() => api("POST", `${base}/ai-key/check`), checkResult)}
      />

      <PasswordForm onSubmit={(body) => act(() => api("POST", "/api/password", body), () => "Passwort geändert. Andere angemeldete Geräte sind abgemeldet.")} />

      <details className="card wide">
        <summary><h3>Technik und Stand der Kanäle</h3></summary>
        <div className="kv"><span>Versand</span><strong>{data.sendMode === "enabled" ? "möglich, je Postfach freizuschalten" : "aus, nur Entwürfe"}</strong></div>
        <div className="kv"><span>KI</span><span>{data.ai.provider} · {data.ai.model} · Prompt {data.ai.promptVersion}</span></div>
        {data.jobs.length > 0 && (
          <>
            <h4>Hintergrundaufgaben</h4>
            <ul>{data.jobs.map((j) => <li key={`${j.type}${j.status}`} className="small">{JOB_LABEL[j.type] ?? j.type}: {j.count} × {JOB_STATUS[j.status] ?? j.status}{j.last_error ? ` – ${j.last_error}` : ""}</li>)}</ul>
          </>
        )}
        <h4>Kanäle</h4>
        <table>
          <thead><tr><th>Kanal</th><th>Weg</th><th>Status</th><th>Empfang</th><th>Antwort</th><th>Offene Kontotests</th></tr></thead>
          <tbody>
            {data.catalog.map((d) => (
              <tr key={d.platform}>
                <td><strong>{d.label}</strong><div className="muted small">{d.notes}</div></td>
                <td className="small">{d.transport}</td>
                <td>{IMPL_LABEL[d.implementation] ?? d.implementation}</td>
                <td className="small">{CAP_LABEL[d.receive] ?? d.receive}</td>
                <td className="small">{CAP_LABEL[d.reply] ?? d.reply}</td>
                <td className="small"><ul>{d.accountTestNeeded.map((t) => <li key={t}>{t}</li>)}</ul></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="small muted credit">SupportX ist Open Source (<a href="https://github.com/tradexag/supportx" target="_blank" rel="noopener">AGPL-3.0, Quellcode</a>), ein Produkt von <a href="https://aseio.app" target="_blank" rel="noopener">ASEIO</a> · TradeX International AG, Lars Orlamünde</p>
    </div></div>
  );
}

function SetupCard({ setup, owner, onAction, graphMailbox, onSending, serverSendOff, children }: {
  setup: ChannelSetup; owner: boolean; onAction: (a: StepAction) => void; graphMailbox?: string;
  onSending?: (on: boolean) => void; serverSendOff?: boolean; children?: React.ReactNode;
}) {
  const doneCount = setup.steps.filter((s) => s.done).length;
  const countable = setup.steps.length;
  const pill = setup.error ? { cls: "pill bad", label: "Fehler" } : setup.connected ? { cls: "pill ok", label: "Angebunden" } : doneCount === 0 ? { cls: "pill muted", label: "Nicht eingerichtet" } : { cls: "pill warn", label: `${doneCount} von ${countable} erledigt` };
  const ACTION_LABEL: Record<StepAction, string> = { connect: "Jetzt eintragen", ebay_login: "Bei eBay anmelden", check: "Verbindung testen", rule: "Regel anlegen", route: "Antwortweg vermerken", erp: "Jetzt eintragen", confirm: "Erledigt, abhaken", unconfirm: "Haken entfernen" };
  return (
    <section className={`card setup${setup.connected && !setup.error ? " connected" : ""}`} aria-label={setup.label}>
      <div className="setup-head">
        <div>
          <h3 className="setup-name">{setup.label}</h3>
          <div className="muted small">{setup.way}{graphMailbox ? ` · ${graphMailbox}` : ""}</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      {setup.error && <p className="notice bad small">{explainError(setup.error)}</p>}
      {setup.next ? (
        <div className="next-step">
          <div><span className="next-label">Als Nächstes</span><strong>{setup.next.title}</strong>{setup.next.hint && <div className="muted small">{setup.next.hint}</div>}</div>
          {owner && setup.next.action && <button className="primary" onClick={() => onAction(setup.next!.action!)}>{ACTION_LABEL[setup.next.action]}</button>}
        </div>
      ) : (
        <p className="done-line small">Alles eingerichtet.</p>
      )}
      <ol className="steps">
        {setup.steps.map((s, i) => (
          <li key={s.key} className={s.done ? "done" : s.external ? "external" : s === setup.next ? "current" : ""}>
            <span className="mark" aria-hidden="true">{s.done ? "✓" : s.external ? "→" : i + 1}</span>
            <span className="step-body">
              <span className="step-title">{s.title}{s.external && <span className="tag"> · dort erledigen</span>}{s.done && <span className="sr-only"> (erledigt)</span>}</span>
              {s.hint && s !== setup.next && (!s.done || s.external) && <span className="muted small">{s.hint}</span>}
            </span>
            {owner && (!s.done || s.action === "unconfirm") && s.action && s !== setup.next && <button className="link" onClick={() => onAction(s.action!)}>{ACTION_LABEL[s.action]}</button>}
          </li>
        ))}
      </ol>
      {setup.sending && (
        <div className="send-line">
          <span>Antworten senden: <strong>{setup.sending.on ? "freigeschaltet" : "aus, nur Entwürfe"}</strong>
            {setup.sending.on && serverSendOff && <span className="warn-text"> · auf dem Server noch gesperrt</span>}
            {setup.sending.on && <span className="muted small"> · jede Antwort erst nach deiner Freigabe im Fall</span>}
          </span>
          {owner && onSending && <button className={setup.sending.on ? "" : "primary"} onClick={() => onSending(!setup.sending!.on)}>{setup.sending.on ? "Versand sperren" : "Versand freischalten"}</button>}
        </div>
      )}
      {children}
    </section>
  );
}

const JOB_LABEL: Record<string, string> = { "mail.sync": "Mails abrufen", "case.enrich": "Bestellung suchen", "case.draft": "Entwurf schreiben", "outbox.dispatch": "Versand", "outbox.reconcile": "Versand bestätigen", "mail.subscription": "Benachrichtigung erneuern" };
const JOB_STATUS: Record<string, string> = { queued: "wartet", running: "läuft", failed: "fehlgeschlagen" };

/** Turns raw provider errors into a sentence that says what to do. */
function explainError(raw: string): string {
  if (/AADSTS7000215|invalid client secret/i.test(raw)) return "Der geheime Schlüssel ist falsch. Unter „Schlüssel austauschen“ den „Wert“ aus Entra eintragen (nicht die „Geheime ID“).";
  if (/AADSTS7000222|expired/i.test(raw)) return "Der geheime Schlüssel ist abgelaufen. In Entra einen neuen anlegen und unter „Schlüssel austauschen“ eintragen.";
  if (/AADSTS700016/i.test(raw)) return "Die Anwendungs-ID passt nicht zum Microsoft-Mandanten.";
  if (/AADSTS90002/i.test(raw)) return "Die Verzeichnis-ID (Mandant) ist unbekannt.";
  if (/403|Access ?Denied|ErrorAccessDenied/i.test(raw)) return "Microsoft verweigert den Zugriff auf dieses Postfach. Der Exchange-Admin muss die Freigabe für genau dieses Postfach einrichten.";
  return raw;
}

function ConnectionCard({ c, owner, duplicate, base, act, checkResult }: {
  c: Connection; owner: boolean; duplicate: boolean; base: string;
  act: (fn: () => Promise<unknown>, success?: (result: unknown) => string) => Promise<void>; checkResult: (r: unknown) => string;
}) {
  const [secretOpen, setSecretOpen] = useState(false);
  const status = c.paused ? { label: "Pausiert", cls: "pill warn" } : c.health === "ok" ? { label: "Verbunden", cls: "pill ok" } : c.health === "error" ? { label: "Fehler", cls: "pill bad" } : { label: "Noch nicht geprüft", cls: "pill muted" };
  const graph = c.kind === "microsoft_graph";
  const where = graph ? `im Microsoft-Postfach` : `bei ${KIND_LABEL[c.kind]}`;
  const ident = graph ? c.config.mailbox : c.kind === "ebay_messages" ? c.config.sellerUsername ?? "noch nicht angemeldet" : c.kind === "mirakl_inbox" ? c.config.baseUrl : c.config.storefronts?.length ? `Storefronts ${c.config.storefronts.join(", ")}` : "alle Storefronts";
  const ebayLogin = () => act(async () => { const r = await api<{ url: string }>("POST", `${base}/connections/${c.id}/ebay/authorize`); window.location.assign(r.url); });
  const remove = () => {
    if (!window.confirm(`Verbindung „${c.display_name}“ (${ident}) löschen?\n\nAlle Fälle, die über diese Verbindung geholt wurden, werden in SupportX mitgelöscht. ${where.charAt(0).toUpperCase() + where.slice(1)} bleibt alles unverändert.`)) return;
    void act(() => api("DELETE", `${base}/connections/${c.id}`), (r) => `Verbindung gelöscht${(r as { deletedCases: number }).deletedCases ? `, ${(r as { deletedCases: number }).deletedCases} Fälle entfernt` : ""}.`);
  };
  return (
    <div className="connection">
      <div className="conn-head">
        <div>
          <div className="row wrap"><strong className="conn-name">{c.display_name}</strong><span className="pill muted">{KIND_LABEL[c.kind] ?? c.kind}</span><span className={status.cls}>{status.label}</span></div>
          <div className="muted small"><code>{ident}</code> · Letzter Abruf: {c.last_sync_at ? fmtDate(c.last_sync_at) : "noch nie"}</div>
        </div>
        {owner && (
          <div className="row wrap">
            {c.kind === "ebay_messages" && !c.config.sellerUsername ? <button className="primary" onClick={ebayLogin}>Bei eBay anmelden</button> : <button className="primary" disabled={c.paused} onClick={() => act(() => api("POST", `${base}/connections/${c.id}/sync`), () => "Abruf gestartet. Neue Mails erscheinen in wenigen Minuten im Posteingang.")}>Jetzt abrufen</button>}
            <button onClick={() => act(() => api("POST", `${base}/connections/${c.id}/check`), checkResult)}>Verbindung testen</button>
          </div>
        )}
      </div>
      {duplicate && <p className="notice warn small">Dieses Postfach ist mehrfach verbunden, dadurch kommt jede Mail doppelt an. Behalte eine Verbindung, die anderen löschen.</p>}
      {c.kind === "mirakl_inbox" && !c.config.backgroundSyncAllowed && <p className="notice small">Shop Apotheke liest SupportX nur, wenn du „Jetzt abrufen“ klickst. So verlangt es Mirakl, bis Shop Apotheke einen automatischen Abruf erlaubt.</p>}
      {c.last_error && !c.paused && <p className="notice bad small">{explainError(c.last_error)}</p>}
      {owner && (
        <div className="row wrap">
          {graph && <button onClick={() => setSecretOpen(!secretOpen)}>Schlüssel austauschen</button>}
          {c.kind === "ebay_messages" && c.config.sellerUsername && <button onClick={ebayLogin}>Bei eBay neu anmelden</button>}
          <button onClick={() => act(() => api("POST", `${base}/connections/${c.id}/paused`, { paused: !c.paused }))}>{c.paused ? "Fortsetzen" : "Pausieren"}</button>
          <button className="danger" onClick={remove}>Löschen</button>
        </div>
      )}
      {secretOpen && owner && <SecretForm onSubmit={(clientSecret) => { setSecretOpen(false); void act(() => api("POST", `${base}/connections/${c.id}/secret`, { clientSecret }), () => "Schlüssel ausgetauscht. Bitte einmal „Verbindung testen“."); }} />}
    </div>
  );
}

function SecretField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const v = value.trim();
  const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  return (
    <label>
      Geheimer Clientschlüssel
      <div className="row"><input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setShow(!show)}>{show ? "verbergen" : "anzeigen"}</button></div>
      <span className={looksLikeId ? "error small" : "muted small"}>
        {looksLikeId ? "Das ist die „Geheime ID“. Gebraucht wird die Spalte „Wert“ daneben." : v ? `Beginnt mit ${v.slice(0, 3)}…, ${v.length} Zeichen. In Entra steht er als „${v.slice(0, 3)}***“.` : "In Entra unter „Zertifikate & Geheimnisse“ die Spalte „Wert“ kopieren, nicht „Geheime ID“."}
      </span>
    </label>
  );
}

function SecretForm({ onSubmit }: { onSubmit: (secret: string) => void }) {
  const [secret, setSecret] = useState("");
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit(secret); }}>
      <SecretField value={secret} onChange={setSecret} />
      <div className="row"><button type="submit" className="primary">Schlüssel speichern</button></div>
    </form>
  );
}

function PasswordForm({ onSubmit }: { onSubmit: (body: { oldPassword: string; newPassword: string }) => Promise<void> }) {
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [repeat, setRepeat] = useState("");
  const mismatch = repeat !== "" && repeat !== newPassword;
  return (
    <section className="card">
      <h3>Mein Passwort</h3>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (mismatch) return; await onSubmit({ oldPassword, newPassword }); setOld(""); setNew(""); setRepeat(""); }}>
        <label>Bisheriges Passwort<input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" required /></label>
        <label>Neues Passwort (mindestens 10 Zeichen)<input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" minLength={10} required /></label>
        <label>Neues Passwort wiederholen<input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required /></label>
        {mismatch && <p className="error">Die beiden neuen Passwörter sind nicht gleich.</p>}
        <div className="row"><button type="submit" className="primary" disabled={mismatch}>Passwort ändern</button></div>
      </form>
    </section>
  );
}

function AiKeyCard({ data, owner, onSave, onCheck }: { data: SettingsData; owner: boolean; onSave: (apiKey: string | null) => Promise<void>; onCheck: () => Promise<void> }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(false);
  const ws = data.workspace;
  const serverClaude = data.ai.provider === "claude";
  const state = !ws.ai_enabled ? "Aus: Entwürfe kommen aus Regelvorlagen." : ws.has_ai_key ? "Claude mit eigenem Schlüssel (gespeichert)." : serverClaude ? "Claude mit dem Schlüssel dieser Installation." : "Kein Claude-Schlüssel: Entwürfe kommen aus Regelvorlagen.";
  return (
    <section className="card">
      <h3>KI für Antwortentwürfe</h3>
      <p className="muted">{state}</p>
      <p className="muted">Die Zuordnung zu Bestellungen läuft immer ohne KI. Claude formuliert nur den Entwurf, und jeder Entwurf wird vor dem Versand von einem Menschen geprüft.</p>
      {owner && ws.has_ai_key && !editing && (
        <div className="row">
          <button type="button" onClick={() => setEditing(true)}>Schlüssel ändern</button>
          <button type="button" onClick={() => void onCheck()}>Schlüssel testen</button>
          <button type="button" onClick={() => { if (window.confirm("Eigenen Claude-Schlüssel entfernen?")) void onSave(null); }}>Entfernen</button>
        </div>
      )}
      {owner && (!ws.has_ai_key || editing) && (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); await onSave(key); setKey(""); setEditing(false); }}>
          <label>Eigener Claude-API-Schlüssel (aus console.anthropic.com, beginnt mit „sk-ant-“)
            <div className="row"><input type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={ws.has_ai_key ? "neuen Schlüssel eintragen, um ihn zu ersetzen" : "sk-ant-…"} required /><button type="button" onClick={() => setShow(!show)}>{show ? "verbergen" : "anzeigen"}</button></div>
          </label>
          <div className="row">
            <button type="submit" className="primary">Prüfen und speichern</button>
            {editing && <button type="button" onClick={() => { setKey(""); setEditing(false); }}>Abbrechen</button>}
          </div>
        </form>
      )}
      <p className="muted small">Der Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt. Kosten rechnet Anthropic direkt mit dem Inhaber des Schlüssels ab. Gilt für alle neuen Entwürfe dieses Arbeitsbereichs.</p>
    </section>
  );
}

function WorkspaceForm({ data, owner, onSave }: { data: SettingsData; owner: boolean; onSave: (body: unknown) => void }) {
  const [signature, setSignature] = useState(data.workspace.reply_signature);
  const [tone, setTone] = useState(data.workspace.reply_tone);
  const [links, setLinks] = useState(data.workspace.allowed_link_prefixes.join("\n"));
  const [aiEnabled, setAiEnabled] = useState(data.workspace.ai_enabled);
  return (
    <section className="card">
      <h3>Antworten</h3>
      <label>Signatur<textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} disabled={!owner} /></label>
      <label>Tonalität<input value={tone} onChange={(e) => setTone(e.target.value)} disabled={!owner} /></label>
      <label>Freigegebene Link-Anfänge (je Zeile, z. B. Retourenportal)<textarea rows={3} value={links} onChange={(e) => setLinks(e.target.value)} disabled={!owner} /></label>
      <label className="row"><input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} disabled={!owner} /> KI-Entwürfe verwenden (sonst Regelvorlagen)</label>
      {owner && <button onClick={() => onSave({ replySignature: signature, replyTone: tone, allowedLinkPrefixes: links.split("\n").map((l) => l.trim()).filter(Boolean), aiEnabled })}>Speichern</button>}
    </section>
  );
}

function ErpForm({ current, onSubmit }: { current: string; onSubmit: (body: unknown) => void }) {
  const [baseUrl, setBaseUrl] = useState(current);
  const [token, setToken] = useState("");
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); onSubmit({ baseUrl, ...(token ? { apiToken: token } : {}) }); setToken(""); }}>
      <input placeholder="https://<mandant>.weclapp.com/webapp/api/v2" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required size={40} />
      <input type="password" placeholder={current ? "Token (leer = unverändert)" : "API-Token"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      <button type="submit">weclapp speichern</button>
    </form>
  );
}

function GraphForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "", tenantId: "", clientId: "", clientSecret: "", mailbox: "", ownAddresses: "", defaultSourcePlatform: "email" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form
      className="stack inset"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...form, ownAddresses: form.ownAddresses.split(/[\s,]+/).filter(Boolean) });
      }}
    >
      <h4>Postfach verbinden</h4>
      <p className="muted small">Die Angaben stehen in Entra bei der App unter „Übersicht“ und „Zertifikate &amp; Geheimnisse“. Der Exchange-Admin muss den Zugriff vorher auf genau dieses Postfach beschränkt haben.</p>
      <label>Name<input placeholder="z. B. Kundenservice" value={form.displayName} onChange={set("displayName")} required /></label>
      <label>Postfach<input placeholder="service@firma.de" value={form.mailbox} onChange={set("mailbox")} required /></label>
      <label>Verzeichnis-ID (Mandant)<input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.tenantId} onChange={set("tenantId")} required /></label>
      <label>Anwendungs-ID (Client)<input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.clientId} onChange={set("clientId")} required /></label>
      <SecretField value={form.clientSecret} onChange={(v) => setForm({ ...form, clientSecret: v })} />
      <details className="more">
        <summary>Optional</summary>
        <label>Weitere eigene Absenderadressen (mit Komma)<input value={form.ownAddresses} onChange={set("ownAddresses")} /></label>
        <label>Plattform, wenn keine Regel passt<select value={form.defaultSourcePlatform} onChange={set("defaultSourcePlatform")}>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></label>
      </details>
      <div className="row"><button type="submit" className="primary">Verbinden</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function HiddenField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label>{label}<input type="password" value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" spellCheck={false} /></label>;
}

function EbayForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "eBay", clientId: "", clientSecret: "", ruName: "", sandbox: false });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, clientSecret: form.clientSecret.trim() });  }}>
      <h4>eBay verbinden</h4>
      <p className="muted small">Die Angaben stehen im eBay Developer Program unter „Application Keys“ (Production). Beim RuName als „Auth accepted URL“ eintragen: <code>{window.location.origin}/oauth/ebay/callback</code>. Danach mit dem Verkäuferkonto „Bei eBay anmelden“.</p>
      <label>Name<input value={form.displayName} onChange={set("displayName")} required /></label>
      <label>App ID (Client ID)<input value={form.clientId} onChange={set("clientId")} required autoComplete="off" /></label>
      <HiddenField label="Cert ID (Client Secret)" value={form.clientSecret} onChange={(v) => setForm({ ...form, clientSecret: v })} />
      <label>RuName<input value={form.ruName} onChange={set("ruName")} required autoComplete="off" /></label>
      <label className="row"><input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} /> Sandbox (nur zum Ausprobieren)</label>
      <div className="row"><button type="submit" className="primary">Anlegen</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function KauflandForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "Kaufland", clientKey: "", secretKey: "", storefronts: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, clientKey: form.clientKey.trim(), secretKey: form.secretKey.trim(), storefronts: form.storefronts.split(/[\s,]+/).filter(Boolean) });  }}>
      <h4>Kaufland verbinden</h4>
      <p className="muted small">Die Schlüssel stehen im Kaufland Seller Portal unter Einstellungen → API. Bestehende Schlüssel einfach kopieren, nicht neu erzeugen, sonst hören andere Programme damit auf. Tickets werden höchstens alle 5 Minuten abgefragt.</p>
      <label>Name<input value={form.displayName} onChange={set("displayName")} required /></label>
      <label>Client Key<input value={form.clientKey} onChange={set("clientKey")} required autoComplete="off" spellCheck={false} /></label>
      <HiddenField label="Secret Key" value={form.secretKey} onChange={(v) => setForm({ ...form, secretKey: v })} />
      <label>Storefronts (leer = alle, z. B. de)<input value={form.storefronts} onChange={set("storefronts")} /></label>
      <div className="row"><button type="submit" className="primary">Verbinden</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function MiraklForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "Shop Apotheke", baseUrl: "", apiKey: "", shopId: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, apiKey: form.apiKey.trim(), shopId: form.shopId.trim() || undefined });  }}>
      <h4>Shop Apotheke verbinden</h4>
      <p className="muted small">Shop Apotheke läuft auf Mirakl. Adresse und API-Schlüssel stehen im Mirakl-Backoffice oben rechts unter dem Benutzer → API-Schlüssel. Gelesen wird zunächst nur per Klick auf „Jetzt abrufen“.</p>
      <label>Name<input value={form.displayName} onChange={set("displayName")} required /></label>
      <label>Adresse der Instanz<input placeholder="https://….mirakl.net" value={form.baseUrl} onChange={set("baseUrl")} required /></label>
      <HiddenField label="API-Schlüssel" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
      <label>Shop-ID (nur bei mehreren Shops)<input value={form.shopId} onChange={set("shopId")} /></label>
      <div className="row"><button type="submit" className="primary">Verbinden</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}


interface DesignReading { theme: unknown; found: Array<{ field: string; label: string; value: string }>; warnings: string[] }
interface WorkspaceThemeInfo { custom: { productName?: string; colors: Record<string, string>; fonts: { sans?: string; mono?: string }; radius?: number } | null }

/** Look of this workspace from an uploaded DESIGN.md: preview first, active only after "Übernehmen". */
function DesignCard({ base, owner }: { base: string; owner: boolean }) {
  const [current, setCurrent] = useState<WorkspaceThemeInfo["custom"]>(null);
  const [reading, setReading] = useState<DesignReading | null>(null);
  const [fileName, setFileName] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const t = await api<WorkspaceThemeInfo>("GET", `${base}/theme`).catch(() => ({ custom: null }));
    setCurrent(t.custom);
  }, [base]);
  useEffect(() => void reload(), [reload]);
  const changed = () => window.dispatchEvent(new Event("supportx-theme"));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try { await fn(); } catch (err) { setMessage({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  };
  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 200_000) return setMessage({ ok: false, text: "Die Datei ist zu groß (höchstens 200 KB)." });
    setFileName(file.name);
    void run(async () => setReading(await api<DesignReading>("POST", `${base}/design/preview`, { text: await file.text() })));
  };
  const summary = current
    ? `Eigenes Design aktiv · ${Object.keys(current.colors).length} Farben${current.fonts.sans ? ` · ${current.fonts.sans.split(",")[0]!.replace(/"/g, "")}` : ""}`
    : "Standard-Design";
  const swatches = (found: DesignReading["found"]) => (
    <ul className="design-found">
      {found.map((f) => (
        <li key={f.field}>
          {f.field.startsWith("colors.") && <i className="swatch" style={{ background: f.value }} aria-hidden="true" />}
          <span>{f.label}</span>
          <code>{f.value}</code>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="card">
      <h3>Design</h3>
      <p className="muted small">{summary}</p>
      <p className="muted small">Lade eine DESIGN.md hoch. SupportX liest daraus Farben (als #rrggbb mit Rolle, z. B. „Hintergrund: #ffffff“), Schriften und den Eckenradius. Vor dem Übernehmen siehst du, was erkannt wurde. Schlecht lesbare Farbpaare werden nicht übernommen.</p>
      {owner && (
        <label className="file-pick">
          <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={busy} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="button">design.md auswählen</span>
        </label>
      )}
      {reading && (
        <div className="design-preview">
          <h4>Erkannt in {fileName}</h4>
          {reading.found.length > 0 && swatches(reading.found)}
          {reading.warnings.map((w) => <p key={w} className="small warn-text">{w}</p>)}
          <div className="row">
            {reading.found.length > 0 && <button className="primary" disabled={busy} onClick={() => void run(async () => {
              const r = await api<{ warnings: string[] }>("PUT", `${base}/design`, reading.theme);
              setReading(null);
              await reload();
              changed();
              setMessage({ ok: true, text: r.warnings.length ? `Übernommen. ${r.warnings.join(" ")}` : "Übernommen. Das Design gilt jetzt für diesen Arbeitsbereich." });
            })}>Übernehmen</button>}
            <button disabled={busy} onClick={() => setReading(null)}>Verwerfen</button>
          </div>
        </div>
      )}
      {owner && current && !reading && (
        <div className="row">
          <button disabled={busy} onClick={() => void run(async () => {
            await api("DELETE", `${base}/design`);
            await reload();
            changed();
            setMessage({ ok: true, text: "Standard-Design wiederhergestellt." });
          })}>Zurücksetzen</button>
        </div>
      )}
      {message && <p className={message.ok ? "small ok-text" : "small error"} role="status">{message.text}</p>}
      <p className="muted small">Gilt für alle in diesem Arbeitsbereich, sobald sie die Seite neu laden.</p>
    </section>
  );
}

interface DocumentRow { id: string; name: string; size: number; created_at: string }
const MAX_PDF = 3 * 1024 * 1024;
const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}

/** PDFs kept ready to attach to replies, e.g. the return instructions. */
const AUTO_INVOICE: Record<"off" | "draft" | "send", string> = {
  off: "Aus: nur auf Klick „Rechnung senden“",
  draft: "Automatisch vorbereiten: Rechnung anhängen, Senden per Klick",
  send: "Automatisch senden, wenn nichts dagegen spricht",
};

/** Customer asks for the invoice: what SupportX does on its own (no AI, fixed template). */
function AutoInvoiceCard({ value, owner, onChange }: { value: "off" | "draft" | "send"; owner: boolean; onChange: (v: "off" | "draft" | "send") => void }) {
  return (
    <section className="card">
      <h3>Rechnungsanfragen</h3>
      <p className="muted small">Fragt ein Kunde nach seiner Rechnung, holt SupportX die Rechnungs-PDF der zugeordneten Bestellung aus weclapp und antwortet aus einer festen Vorlage, ohne KI-Kosten.</p>
      <label>Bei neuen Anfragen
        <select value={value} disabled={!owner} onChange={(e) => onChange(e.target.value as "off" | "draft" | "send")}>
          {Object.entries(AUTO_INVOICE).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <p className="muted small">Automatisch gesendet wird nur, wenn die Bestellung eindeutig ist, die Rechnung als PDF vorliegt, der Kanal Dateien annimmt, der Versand für die Verbindung freigeschaltet ist und es keinen Hinweis gibt. Nennt der Kunde eine eigene Mailadresse, wird nichts automatisch gesendet und nie an diese Adresse. Gilt für Nachrichten ab jetzt, nicht für ältere.</p>
    </section>
  );
}

function DocumentsCard({ base, owner }: { base: string; owner: boolean }) {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const r = await api<{ documents: DocumentRow[] }>("GET", `${base}/documents`).catch(() => ({ documents: [] }));
    setDocs(r.documents);
  }, [base]);
  useEffect(() => void reload(), [reload]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try { setMessage({ ok: true, text: await fn() }); await reload(); } catch (err) { setMessage({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  };
  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") return setMessage({ ok: false, text: "Bitte nur PDF-Dateien hochladen." });
    if (file.size > MAX_PDF) return setMessage({ ok: false, text: `Die PDF ist zu groß (${fmtSize(file.size)}, höchstens 3 MB). Bitte verkleinern, z. B. beim Export „für Web“ wählen.` });
    void run(async () => {
      await api("POST", `${base}/documents`, { name: file.name, dataBase64: await readBase64(file) });
      return `${file.name} hinterlegt. Du kannst sie jetzt an Antworten hängen.`;
    });
  };
  const count = docs?.length ?? 0;
  return (
    <section className="card">
      <h3>Dokumente</h3>
      <p className="muted small">{count === 0 ? "Noch keine PDFs" : `${count} ${count === 1 ? "PDF" : "PDFs"} hinterlegt`}</p>
      <p className="muted small">PDFs, die ihr oft mitschickt, z. B. die Anleitung für Retouren. Im Fall wählst du sie unter der Antwort mit „PDF anhängen“. Nur PDF, höchstens 3 MB je Datei und je Antwort.</p>
      {docs && docs.length > 0 && (
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.id}>
              <a href={`${base}/documents/${d.id}`} download>{d.name}</a>
              <span className="muted small">{fmtSize(d.size)}</span>
              {owner && <button className="link" disabled={busy} onClick={() => { if (window.confirm(`„${d.name}“ aus der Liste entfernen?\n\nBereits freigegebene Antworten schicken sie trotzdem mit.`)) void run(async () => { await api("DELETE", `${base}/documents/${d.id}`); return `${d.name} entfernt.`; }); }}>entfernen</button>}
            </li>
          ))}
        </ul>
      )}
      {owner && (
        <label className="file-pick">
          <input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="button">{busy ? "Lädt hoch …" : "PDF hochladen"}</span>
        </label>
      )}
      {message && <p className={message.ok ? "small ok-text" : "small error"} role="status">{message.text}</p>}
      <p className="muted small">Bei eBay gehen keine Dateien mit, dort bitte einen Link oder den Text verwenden.</p>
    </section>
  );
}

/** Hours per platform until a customer message should be answered; saved per field on leaving it. */
function DeadlinesCard({ value, owner, onSave }: { value: Record<string, number>; owner: boolean; onSave: (v: Record<string, number>) => Promise<void> }) {
  const current = (p: string) => value[p] ?? DEFAULT_REPLY_DEADLINES[p as keyof typeof DEFAULT_REPLY_DEADLINES] ?? 0;
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <section className="card">
      <h3>Antwortfristen</h3>
      <p className="muted small">Ab der ersten unbeantworteten Kundennachricht läuft die Frist. In der Liste zeigt eine Ampel die Restzeit (gelb ab der Hälfte, rot in den letzten Stunden), und was zuerst abläuft, steht oben. „Wartet“ und „Erledigt“ halten die Uhr an. Amazon erwartet 24 Stunden, auch am Wochenende.</p>
      <div className="deadline-grid">
        {DEADLINE_PLATFORMS.map((p) => (
          <label key={p} className="field"><span>{PLATFORM_LABEL[p] ?? p}</span>
            <span className="row">
              <input type="number" min={0} max={MAX_DEADLINE_HOURS} step={1} disabled={!owner} value={draft[p] ?? String(current(p))}
                onChange={(e) => setDraft({ ...draft, [p]: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Escape") setDraft({ ...draft, [p]: String(current(p)) }); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onBlur={() => {
                  const raw = draft[p];
                  if (raw === undefined || raw === String(current(p))) return;
                  void onSave({ [p]: raw === "" ? 0 : Number(raw) }).then(() => setDraft((d) => { const n = { ...d }; delete n[p]; return n; }));
                }} />
              <span className="small muted">Std.</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted small">0 = keine Frist. Gilt sofort für alle offenen Fälle.</p>
    </section>
  );
}

interface SnippetRow { id: string; title: string; body: string; updated_at: string }

const SNIPPET_EXAMPLE = "Guten Tag {Name},\n\nvielen Dank für Ihre Nachricht zur Bestellung {Bestellnummer}. Ihr Paket hat die Sendungsnummer {Sendungsnummer}:\n{Trackinglink}\n\n{Signatur}";

/** Text blocks: written once, used in every case with data from weclapp, without AI. */
function SnippetsCard({ base, canEdit }: { base: string; canEdit: boolean }) {
  const [list, setList] = useState<SnippetRow[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ snippets: SnippetRow[] }>("GET", `${base}/snippets`).then((r) => setList(r.snippets), (e) => setMessage({ ok: false, text: (e as Error).message })), [base]);
  useEffect(() => void load(), [load]);
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text });
      setEditing(null);
      await load();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h3>Textbausteine</h3>
      <p className="muted small">Antworten, die ihr oft schreibt. Im Fall unter „Antwort“ wählen oder in einen Entwurf einfügen. Platzhalter werden aus dem Fall und aus weclapp gefüllt, ohne KI-Kosten: {Object.entries(SNIPPET_PLACEHOLDERS).map(([k, v], i) => <span key={k}>{i ? ", " : ""}<code title={v}>{`{${k}}`}</code></span>)}. Fehlt ein Wert, bleibt der Platzhalter stehen und der Entwurf lässt sich erst nach dem Ausfüllen freigeben.</p>
      {list === null ? <p className="small muted">Lädt …</p> : list.length === 0 ? <p className="small muted">Noch keine Textbausteine.</p> : (
        <ul className="snippet-list">
          {list.map((sn) => (
            <li key={sn.id}>
              <div className="row wrap"><strong>{sn.title}</strong><span className="spacer" />
                {canEdit && <><button className="link" onClick={() => setEditing({ id: sn.id, title: sn.title, body: sn.body })}>bearbeiten</button>
                <button className="link" disabled={busy} onClick={() => { if (window.confirm(`Textbaustein „${sn.title}“ löschen?`)) void run(() => api("DELETE", `${base}/snippets/${sn.id}`), "Textbaustein gelöscht."); }}>löschen</button></>}
              </div>
              <div className="small muted ellipsis">{sn.body.split("\n").find((l) => l.trim() && !/^guten tag|^hallo/i.test(l.trim())) ?? sn.body}</div>
            </li>
          ))}
        </ul>
      )}
      {canEdit && !editing && <button onClick={() => setEditing({ title: "", body: SNIPPET_EXAMPLE })}>Textbaustein anlegen</button>}
      {canEdit && editing && (
        <form className="snippet-form" onSubmit={(e) => { e.preventDefault(); void run(() => api("POST", `${base}/snippets`, editing), editing.id ? "Textbaustein gespeichert." : "Textbaustein angelegt."); }}>
          <label className="field"><span>Name</span><input value={editing.title} maxLength={120} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="z. B. Sendungsverfolgung" autoFocus /></label>
          <label className="field"><span>Text</span><textarea rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></label>
          <div className="row wrap">
            <button type="submit" className="primary" disabled={busy || !editing.title.trim() || !editing.body.trim()}>Speichern</button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Abbrechen</button>
          </div>
        </form>
      )}
      {message && <p className={message.ok ? "small notice ok" : "small error"}>{message.text}</p>}
      <p className="muted small">Gilt für alle im Team. Inhaber und Bearbeiter dürfen Textbausteine ändern.</p>
    </section>
  );
}

const AUTO_PARCEL: Record<"off" | "draft" | "send", string> = {
  off: "Aus: Antwort erst nach Entscheidung einer Person",
  draft: "Automatisch vorbereiten: Antwort mit Trackinglink, Senden per Klick",
  send: "Automatisch senden, wenn nichts dagegen spricht",
};

/** "Wo ist mein Paket?": fixed template with the tracking link from weclapp, no AI. */
function AutoParcelCard({ value, owner, onChange }: { value: "off" | "draft" | "send"; owner: boolean; onChange: (v: "off" | "draft" | "send") => void }) {
  return (
    <section className="card">
      <h3>Paketstatus-Anfragen</h3>
      <p className="muted small">Fragt ein Kunde, wo sein Paket ist, antwortet SupportX aus einer festen Vorlage mit Lieferstand und Trackinglink aus weclapp, ohne KI-Kosten. Das Anliegen erkennt SupportX beim Eingang; im Fall lässt es sich ändern.</p>
      <label>Bei neuen Anfragen
        <select value={value} disabled={!owner} onChange={(e) => onChange(e.target.value as "off" | "draft" | "send")}>
          {Object.entries(AUTO_PARCEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <p className="muted small">Automatisch gesendet wird nur, wenn die Bestellung eindeutig ist, jede Lieferung einen Trackinglink hat, die Nachricht kein heikles Thema enthält (z. B. „nie angekommen“, Erstattung, Gesundheit), die Entwurfsprüfung keinen Hinweis hat und der Versand für den Kanal freigeschaltet ist. Sonst liegt die Antwort fertig im Fall und der Grund steht dabei. Gilt für Nachrichten ab jetzt.</p>
    </section>
  );
}
