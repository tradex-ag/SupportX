/**
 * Setup checklist per channel for the settings page: only what the merchant must do.
 * Reply routes and routing rules are not steps here: sending stays locked until a
 * route is checked (connection card → Erweitert), and mail markets are recognised
 * by sender (built in for Amazon, otherwise mails arrive as plain e-mail).
 * Pure (no React, no fetch) so it can be unit-tested; the state comes only from
 * the settings payload. A step that happens outside SupportX (e.g. a setting in
 * Seller Central) has `external`: SupportX cannot see it, so it only counts as
 * done once an owner has ticked it off (`confirmations`).
 */

export type StepAction = "connect" | "ebay_login" | "check" | "rule" | "route" | "erp" | "confirm" | "unconfirm";

export interface SetupStep {
  key: string;
  title: string;
  hint?: string;
  done: boolean;
  external?: boolean;
  action?: StepAction;
}

export interface ChannelSetup {
  key: string;
  label: string;
  way: string;
  connected: boolean;
  error: string | null;
  steps: SetupStep[];
  /** First open step. */
  next: SetupStep | null;
  /** Replies for this marketplace: which connection sends them and whether that is allowed. Null until connected. */
  sending?: { connectionId: string; on: boolean } | null;
}

export interface SetupInput {
  connections: ReadonlyArray<{ id: string; kind: string; health: string; paused: boolean; last_error: string | null; default_source_platform: string; send_enabled?: boolean; config: { sellerUsername?: string; mailbox?: string } }>;
  accounts: ReadonlyArray<{ platform: string; paused: boolean }>;
  rules: ReadonlyArray<{ connection_id: string; source_platform: string }>;
  routes: ReadonlyArray<{ connection_id: string; source_platform: string }>;
  erp: null | { has_secret: boolean; status: string; last_error: string | null };
  /** Owner tick-offs for external steps, by platform. */
  confirmations?: Readonly<Record<string, { at: string; by: string | null }>>;
  /** The installation brings its own eBay keyset: the merchant only signs in at eBay. */
  ebayOperatorApp?: boolean;
}

export const API_MARKETS = ["kaufland", "ebay", "shop_apotheke"] as const;
export const MAIL_MARKETS = ["amazon", "docmorris", "shopify"] as const;
export type Market = (typeof API_MARKETS)[number] | (typeof MAIL_MARKETS)[number];

export const MARKET_KIND: Record<(typeof API_MARKETS)[number], string> = { kaufland: "kaufland_tickets", ebay: "ebay_messages", shop_apotheke: "mirakl_inbox" };
const LABEL: Record<Market, string> = { kaufland: "Kaufland", ebay: "eBay", shop_apotheke: "Shop Apotheke", amazon: "Amazon", docmorris: "DocMorris", shopify: "Shopify" };
const WAY: Record<Market, string> = {
  kaufland: "Schnittstelle (Tickets)", ebay: "Schnittstelle (Nachrichten)", shop_apotheke: "Schnittstelle (Mirakl)",
  amazon: "per Mail über das Postfach", docmorris: "per Mail über das Postfach", shopify: "per Mail über das Postfach",
};
const ZUGANG: Record<(typeof API_MARKETS)[number], { title: string; hint: string }> = {
  kaufland: { title: "Client Key und Secret Key eintragen", hint: "Kaufland Seller Portal → Einstellungen → API. Ein bestehendes Schlüsselpaar kopieren, nicht neu erzeugen." },
  ebay: { title: "eBay-Anwendung eintragen (App ID, Cert ID, RuName)", hint: "Einmalig durch den Betreiber dieser SupportX-Installation aus seinem eBay-Entwicklerkonto. Der Händler meldet sich danach nur noch bei eBay an." },
  shop_apotheke: { title: "Backoffice-Adresse und API-Schlüssel eintragen", hint: "Mirakl-Backoffice von Shop Apotheke → Benutzer → API-Schlüssel." },
};
const EXTERN: Record<(typeof MAIL_MARKETS)[number], { title: string; hint: string }> = {
  amazon: { title: "In Seller Central das Postfach eintragen", hint: "Einstellungen → Benachrichtigungen: Käufer-Nachrichten an das Postfach. Nachrichten-Berechtigungen: das Postfach als Absender erlauben, sonst kommen Antworten nicht an." },
  docmorris: { title: "Im DocMorris-Partnerportal das Postfach eintragen", hint: "Die Adresse für Kundenanfragen auf das Postfach setzen." },
  shopify: { title: "In Shopify das Postfach eintragen", hint: "Kontaktformular und Shop-Mails an das Postfach leiten." },
};

function finish(key: string, label: string, way: string, steps: SetupStep[], connected: boolean, error: string | null): ChannelSetup {
  return { key, label, way, steps, connected, error, next: steps.find((s) => !s.done) ?? null };
}

const healthy = (c: { health: string; paused: boolean }) => c.health === "ok" && !c.paused;

export function microsoftSetup(input: SetupInput): ChannelSetup {
  const graph = input.connections.filter((c) => c.kind === "microsoft_graph");
  const steps: SetupStep[] = [
    { key: "connect", title: "Postfach verbinden", hint: "Verzeichnis-ID, Anwendungs-ID und den Wert des Client Secrets aus Entra eintragen.", done: graph.length > 0, action: "connect" },
    { key: "check", title: "Verbindung testen", done: graph.some(healthy), action: "check" },
  ];
  const err = graph.find((c) => c.health === "error" && !c.paused)?.last_error ?? null;
  return finish("microsoft", "Microsoft-Postfach", "Grundlage für Amazon, DocMorris und Shopify", steps, graph.some(healthy), err);
}

export function weclappSetup(input: SetupInput): ChannelSetup {
  const steps: SetupStep[] = [
    { key: "erp", title: "Adresse und API-Token eintragen", hint: "Eigener weclapp-Benutzer nur mit Leserechten, nicht der Token eines anderen Programms.", done: !!input.erp?.has_secret, action: "erp" },
    { key: "check", title: "Verbindung testen", done: input.erp?.status === "ok", action: "check" },
  ];
  return finish("weclapp", "weclapp", "Bestelldaten, nur lesend", steps, input.erp?.status === "ok", input.erp?.status === "error" ? input.erp.last_error : null);
}

export function marketSetup(market: Market, input: SetupInput): ChannelSetup {
  if (market === "kaufland" || market === "ebay" || market === "shop_apotheke") {
    const own = input.connections.filter((c) => c.kind === MARKET_KIND[market]);
    if (market === "ebay" && input.ebayOperatorApp) {
      // Like ASEIO: one click to eBay, no keys to type. The login creates the connection if needed.
      const steps: SetupStep[] = [
        { key: "ebay_login", title: "Bei eBay mit dem Verkäuferkonto anmelden", hint: "Du wirst zu eBay geleitet, meldest dich mit dem Verkäuferkonto an und stimmst zu. Schlüssel musst du keine eintragen.", done: own.some((c) => !!c.config.sellerUsername), action: "ebay_login" },
        { key: "check", title: "Verbindung testen", done: own.some(healthy), action: own.length ? "check" : undefined },
      ];
      if (!steps[1]!.action) delete steps[1]!.action;
      const err = own.find((c) => c.health === "error" && !c.paused)?.last_error ?? null;
      return { ...finish(market, LABEL[market], WAY[market], steps, own.some(healthy), err), sending: sendingOf(market, own.find(healthy), input) };
    }
    const steps: SetupStep[] = [{ key: "connect", ...ZUGANG[market], done: own.length > 0, action: "connect" }];
    if (market === "ebay") steps.push({ key: "ebay_login", title: "Bei eBay mit dem Verkäuferkonto anmelden", done: own.some((c) => !!c.config.sellerUsername), action: "ebay_login" });
    steps.push({ key: "check", title: "Verbindung testen", done: own.some(healthy), action: "check" });
    // Without a connection, "test" and "log in" have nothing to act on.
    if (own.length === 0) for (const step of steps) if (step.action !== "connect") delete step.action;
    const err = own.find((c) => c.health === "error" && !c.paused)?.last_error ?? null;
    return { ...finish(market, LABEL[market], WAY[market], steps, own.some(healthy), err), sending: sendingOf(market, own.find(healthy), input) };
  }
  const graph = input.connections.filter((c) => c.kind === "microsoft_graph");
  const mailboxOk = graph.some(healthy);
  const confirmed = input.confirmations?.[market];
  const external: SetupStep = confirmed
    ? { key: "external", title: EXTERN[market].title, hint: `Abgehakt${confirmed.by ? ` von ${confirmed.by}` : ""} am ${fmtDay(confirmed.at)}.`, done: true, external: true, action: "unconfirm" }
    : { key: "external", ...EXTERN[market], hint: `${EXTERN[market].hint} Danach hier abhaken, SupportX kann das nicht selbst sehen.`, done: false, external: true, action: "confirm" };
  const steps: SetupStep[] = [
    external,
    { key: "mailbox", title: "Microsoft-Postfach verbunden und geprüft", hint: "Siehe Karte „Microsoft-Postfach“.", done: mailboxOk },
  ];
  const connected = !!confirmed && mailboxOk;
  return { ...finish(market, LABEL[market], WAY[market], steps, connected, null), sending: connected ? sendingOf(market, graph.find(healthy), input) : null };
}

function sendingOf(market: Market, connection: SetupInput["connections"][number] | undefined, input: SetupInput): ChannelSetup["sending"] {
  if (!connection) return null;
  const routed = input.routes.some((r) => r.connection_id === connection.id && r.source_platform === market);
  return { connectionId: connection.id, on: routed && !!connection.send_enabled };
}

function fmtDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
