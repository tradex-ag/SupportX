import { useCallback, useEffect, useState } from "react";
import { api, ApiError, ROLE_LABEL } from "./api.ts";
import { Inbox } from "./Inbox.tsx";
import { Refunds } from "./Refunds.tsx";
import { Report } from "./Report.tsx";
import { Settings } from "./Settings.tsx";
import { parseSettingsTab, settingsHash } from "./settings-tabs.ts";

interface Me {
  user: { id: string; email: string; display_name: string };
  workspaces: Array<{ id: string; name: string; role: "owner" | "agent" | "viewer" }>;
  demoMode: boolean;
  sendMode: string;
}

interface Brand { productName: string; tagline: string; logoUrl: string | null }
const DEFAULT_BRAND: Brand = { productName: "SupportX", tagline: "Support-Posteingang für Marktplatz-Händler", logoUrl: null };

/** Product name and logo of this installation (theme.json); colours and fonts come from /theme.css. */
function useBrand(): Brand {
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  useEffect(() => {
    api<Brand>("GET", "/api/theme").then((b) => { setBrand(b); document.title = b.productName; }, () => {});
  }, []);
  return brand;
}

function Wordmark({ brand, big }: { brand: Brand; big?: boolean }) {
  if (brand.logoUrl) return <img className={big ? "logo big" : "logo"} src={brand.logoUrl} alt={brand.productName} />;
  const Tag = big ? "h1" : "span";
  return <Tag className={big ? "wordmark big" : "wordmark"}><i className="sq" aria-hidden="true" />{brand.productName.toUpperCase()}</Tag>;
}

/** Look of the selected workspace (uploaded DESIGN.md and logo), layered over the installation theme. */
function useWorkspaceTheme(workspaceId: string | null): { name: string | null; logoUrl: string | null } {
  const [own, setOwn] = useState<{ name: string | null; logoUrl: string | null }>({ name: null, logoUrl: null });
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    const load = () => api<{ css: string; productName: string; custom: unknown; logoUrl: string | null }>("GET", `/api/w/${workspaceId}/theme`).then((t) => {
      if (!alive) return;
      let el = document.getElementById("ws-theme");
      if (!el) {
        el = document.createElement("style");
        el.id = "ws-theme";
        document.head.appendChild(el);
      }
      el.textContent = t.css;
      setOwn({ name: t.custom ? t.productName : null, logoUrl: t.logoUrl });
    }, () => {});
    void load();
    window.addEventListener("supportx-theme", load);
    return () => { alive = false; window.removeEventListener("supportx-theme", load); };
  }, [workspaceId]);
  return own;
}

export function App() {
  const installBrand = useBrand();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // A settings tab in the URL hash (e.g. after a reload) opens the settings on that tab.
  const [view, setViewState] = useState<"inbox" | "refunds" | "report" | "settings">(() => (parseSettingsTab(window.location.hash) ? "settings" : "inbox"));
  const setView = useCallback((next: "inbox" | "refunds" | "report" | "settings") => {
    setViewState(next);
    // The hash only names a settings tab; drop it on other pages so a reload lands there.
    if (next !== "settings" && window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);
  // A case opened from another page (e.g. the refund list) shows in the inbox.
  const [openCase, setOpenCase] = useState<{ id: string; n: number } | null>(null);
  const [refundsOpen, setRefundsOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Me>("GET", "/api/me");
      setMe(data);
      setWorkspaceId((current) => current ?? data.workspaces[0]?.id ?? null);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) console.error(error);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const own = useWorkspaceTheme(me ? workspaceId : null);
  // Open refunds for the menu, refreshed every minute.
  useEffect(() => {
    if (!me || !workspaceId) return;
    let alive = true;
    const load = () => api<{ counts: { open: number } }>("GET", `/api/w/${workspaceId}/refunds?filter=open`).then((r) => { if (alive) setRefundsOpen(r.counts.open); }, () => {});
    void load();
    const timer = setInterval(load, 60_000);
    // A case changed its outcome: update the count at once.
    window.addEventListener("supportx-refunds", load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("supportx-refunds", load); };
  }, [me, workspaceId]);
  const brand = { ...installBrand, productName: own.name ?? installBrand.productName, logoUrl: own.logoUrl ?? installBrand.logoUrl };

  // Return from the eBay consent: finish it with a same-origin API call (the session
  // cookie is SameSite=strict and is not sent on eBay's redirect itself).
  const [oauthNotice, setOauthNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!me) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("ebay_code");
    const state = params.get("ebay_state");
    const failed = params.get("ebay_error");
    if (!code && !failed) return;
    window.history.replaceState(null, "", `${window.location.pathname}${settingsHash("marktplaetze")}`);
    setView("settings");
    if (failed || !code || !state) {
      setOauthNotice(`eBay-Anmeldung nicht abgeschlossen (${failed ?? "unvollständig"}).`);
      return;
    }
    api<{ sellerUsername: string }>("POST", "/api/oauth/ebay/complete", { code, state })
      .then((r) => setOauthNotice(`eBay-Konto ${r.sellerUsername} verbunden. Nachrichten werden jetzt abgerufen, Antworten bleiben Entwürfe.`))
      .catch((error: Error) => setOauthNotice(`eBay-Anmeldung fehlgeschlagen: ${error.message}`));
  }, [me]);

  if (loading) return <div className="center muted">Lädt …</div>;
  if (!me) return <Login onDone={load} brand={installBrand} />;
  const workspace = me.workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="app">
      {me.demoMode && (
        <div className="demo-banner">
          DEMO – alle Kunden, Bestellungen, Pakete und Postfächer sind synthetisch. weclapp und Microsoft werden durch lokale Testdoubles ersetzt.
        </div>
      )}
      <header className="topbar">
        <Wordmark brand={brand} />
        {me.workspaces.length > 1 ? (
          <select value={workspaceId ?? ""} onChange={(e) => setWorkspaceId(e.target.value)}>
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        ) : (
          <span className="muted">{workspace?.name}</span>
        )}
        <nav>
          <button className={view === "inbox" ? "tab active" : "tab"} onClick={() => { setOpenCase(null); setView("inbox"); }}>Posteingang</button>
          <button className={view === "refunds" ? "tab active" : "tab"} onClick={() => setView("refunds")} title="Erstattungen, die in weclapp noch zu machen sind">
            Erstattungen{refundsOpen ? <span className="count" aria-label={`${refundsOpen} offen`}>{refundsOpen}</span> : null}
          </button>
          <button className={view === "report" ? "tab active" : "tab"} onClick={() => setView("report")}>Auswertung</button>
          <button className={view === "settings" ? "tab active" : "tab"} onClick={() => setView("settings")}>Einstellungen</button>
        </nav>
        <span className={me.sendMode === "enabled" ? "pill warn" : "pill muted"} title="Installationsweiter Versandmodus">
          {me.sendMode === "enabled" ? "Versand möglich (je Verbindung)" : "Nur Entwürfe"}
        </span>
        <span className="spacer" />
        <span className="muted">{me.user.display_name}{workspace ? ` · ${ROLE_LABEL[workspace.role]}` : ""}</span>
        <button className="link" onClick={async () => { await api("POST", "/api/logout"); setMe(null); }}>Abmelden</button>
      </header>
      {oauthNotice && <p className="notice" role="status">{oauthNotice} <button className="link" onClick={() => setOauthNotice(null)}>schließen</button></p>}
      {!workspace ? (
        <div className="center muted">Kein Arbeitsbereich zugeordnet.</div>
      ) : view === "inbox" ? (
        <Inbox workspaceId={workspace.id} role={workspace.role} openCase={openCase} />
      ) : view === "refunds" ? (
        <Refunds workspaceId={workspace.id} role={workspace.role} onCounts={setRefundsOpen}
          onOpenCase={(id) => { setOpenCase((o) => ({ id, n: (o?.n ?? 0) + 1 })); setView("inbox"); }} />
      ) : view === "report" ? (
        <Report workspaceId={workspace.id} />
      ) : (
        <Settings workspaceId={workspace.id} role={workspace.role} />
      )}
    </div>
  );
}

function Login({ onDone, brand }: { onDone: () => void; brand: Brand }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h: { demoMode?: boolean }) => setDemo(!!h.demoMode)).catch(() => undefined);
  }, []);
  return (
    <form
      className="login card"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api("POST", "/api/login", { email, password });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <Wordmark brand={brand} big />
      {brand.tagline && <p className="label">/ {brand.tagline}</p>}
      {demo && (
        <p className="notice warn">
          Demo mit synthetischen Daten. Anmeldung: <code>inhaber@demo-haendler.example.invalid</code> oder <code>service@demo-haendler.example.invalid</code>, Passwort <code>demo-passwort-nur-lokal</code>.
        </p>
      )}
      <label>E-Mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
      <label>Passwort<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit">Anmelden</button>
      <p className="small muted credit">SupportX ist Open Source (<a href="https://github.com/tradex-ag/SupportX" target="_blank" rel="noopener">AGPL-3.0, Quellcode</a>), ein Produkt von <a href="https://aseio.app" target="_blank" rel="noopener">ASEIO</a> · TradeX International AG, Lars Orlamünde</p>
    </form>
  );
}
