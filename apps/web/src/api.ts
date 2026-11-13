export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** All calls send x-supportx-request (CSRF guard on the server) and the session cookie. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "x-supportx-request": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? res.status), String(data.message ?? res.statusText));
  return data as T;
}

export const fmtDate = (value: unknown): string => {
  if (!value) return "–";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
};

export const PLATFORM_LABEL: Record<string, string> = {
  email: "E-Mail", amazon: "Amazon", ebay: "eBay", kaufland: "Kaufland", shop_apotheke: "Shop Apotheke", docmorris: "DocMorris", shopify: "Shopify",
};

export const MATCH_LABEL: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  pending: { label: "wird geprüft", tone: "muted" },
  unique: { label: "eindeutig", tone: "ok" },
  ambiguous: { label: "unklar – mehrere Treffer", tone: "warn" },
  missing: { label: "nicht gefunden", tone: "bad" },
  no_reference: { label: "keine Bestellnummer", tone: "warn" },
  no_account: { label: "Noch nicht gesucht", tone: "muted" },
  error: { label: "Fehler bei Abfrage", tone: "bad" },
};

export const OUTBOX_LABEL: Record<string, string> = {
  planned: "eingeplant",
  dispatching: "wird übergeben",
  provider_accepted: "vom Anbieter angenommen",
  confirmed: "gesendetes Exemplar bestätigt",
  delivery_uncertain: "Versandstatus unklar",
  failed: "fehlgeschlagen",
  suppressed: "zurückgezogen",
};

export const DRAFT_LABEL: Record<string, string> = {
  proposed: "Vorschlag", edited: "bearbeitet", superseded: "veraltet", sent: "gesendet", discarded: "verworfen",
};

/** What each role may do, in the words the team page and the header use. */
export const ROLE_LABEL: Record<"owner" | "agent" | "viewer", string> = { owner: "Inhaber", agent: "Bearbeiter", viewer: "Nur lesen" };
export const ROLE_HINT: Record<"owner" | "agent" | "viewer", string> = {
  owner: "alles, auch Einstellungen, Zugangsdaten und Team",
  agent: "Fälle bearbeiten, antworten, Erstattungen abhaken",
  viewer: "alles sehen, nichts ändern",
};
