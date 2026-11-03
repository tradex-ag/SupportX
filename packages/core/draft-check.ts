import type { AllowedFact, OrderRecord } from "./contracts.ts";
import { hasDeliveredEvidence, hasDispatchEvidence } from "./facts.ts";
import { openPlaceholders } from "./snippets.ts";

export interface DraftIssue {
  /** `block` prevents approval until the text is changed; `warn` must be acknowledged by the reviewer. */
  severity: "block" | "warn";
  code:
    | "UNKNOWN_FACT"
    | "UNVERIFIED_LINK"
    | "DISPATCH_CLAIM_UNSUPPORTED"
    | "DELIVERY_CLAIM_UNSUPPORTED"
    | "COMPLETED_ACTION_CLAIM"
    | "DELIVERY_PROMISE"
    | "ORDER_NOT_CONFIRMED"
    | "HEALTH_REVIEW"
    | "RECIPIENT_IN_TEXT"
    | "FILES_NOT_SUPPORTED"
    | "PLACEHOLDER_OPEN"
    | "MARKETPLACE_CONTACT"
    | "MARKETPLACE_LINK"
    | "MARKETPLACE_REVIEW"
    | "MARKETPLACE_MARKETING"
    | "EMPTY";
  message: string;
}

export interface DraftCheckInput {
  text: string;
  citedFactIds: ReadonlyArray<string>;
  facts: ReadonlyArray<AllowedFact>;
  order: OrderRecord | null;
  orderStatus: "unique" | "ambiguous" | "missing" | "error" | "not_checked";
  /** Operator-approved link prefixes (shop FAQ, return portal, signature). */
  allowedLinkPrefixes: ReadonlyArray<string>;
  /** Where the reply goes (amazon, ebay, …); marketplaces get their messaging rules checked. */
  sourcePlatform?: string;
}

/** Platforms whose buyer messaging forbids contact details and advertising. */
const MARKETPLACES: Readonly<Record<string, string>> = { amazon: "Amazon", ebay: "eBay", kaufland: "Kaufland", shop_apotheke: "Shop Apotheke", docmorris: "DocMorris" };
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i;
// Only numbers that are clearly phone numbers: labelled, or in international form. Order and parcel numbers stay out.
const PHONE_IN_TEXT = /\b(?:tel|telefon(?:nummer)?|phone|fon|mobil|handy|whatsapp|hotline)\.?\s*:?\s*[+(\d]|\+\d{2}[\s\d/()-]{6,}\d/i;
const REVIEW_REQUEST = /\b(positive[nrs]? (bewertung|rezension|feedback)|(5|fünf) sterne|bewertung (abgeben|hinterlassen|schreiben)|rezension (abgeben|hinterlassen|schreiben)|(bewerten|rezensieren) sie (uns|den artikel|das produkt)|leave (us )?(a )?(positive )?(review|feedback)|5[- ]star)/i;
const MARKETING = /\b(gutschein-?codes?|rabatt-?codes?|newsletter|besuchen sie (doch )?(auch )?unseren (online-?)?shop|in unserem (eigenen |online-?)?shop|auf unserer (web)?seite (bestellen|kaufen)|discount code|visit our (web)?(shop|store|site))\b/i;

const URL = /https?:\/\/[^\s<>()"']+/gi;
const NEGATION = /(nicht|noch nicht|kein|keine|not|bisher nicht|leider nicht)\s+(\S+\s+){0,2}$/i;

function unnegatedMatch(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
    if (!NEGATION.test(before)) return true;
  }
  return false;
}

const DISPATCH_WORDS = /\b(versendet|verschickt|unterwegs|auf dem weg|an den versanddienstleister übergeben|has been shipped|on its way|dispatched)\b/gi;
const DELIVERY_WORDS = /\b(zugestellt|ausgeliefert|delivered)\b/gi;
const COMPLETED_ACTIONS = [
  /\b(haben|habe|wurde|wurden|ist|sind)\s+(\S+\s+){0,4}(erstattet|gutgeschrieben|zurücküberwiesen|refunded)\b/i,
  /\b(erstattung|rückerstattung|gutschrift)\s+(\S+\s+){0,3}(veranlasst|ausgeführt|angewiesen|durchgeführt|erfolgt)\b/i,
  /\b(ersatz(lieferung)?|neue[ns]? (artikel|paket|lieferung))\s+(\S+\s+){0,4}(versendet|verschickt|veranlasst|auf den weg gebracht)\b/i,
  /\b(bestellung|auftrag)\s+(\S+\s+){0,3}(storniert|cancelled)\b/i,
  /\b(retoure|rücksendung|retourenlabel|rücksendeetikett)\s+(\S+\s+){0,4}(angelegt|erstellt|gebucht|beigefügt|anbei)\b/i,
];
const PROMISES = /\b(morgen|übermorgen|garantiert|spätestens|bis (zum|ende)|voraussichtlich (am|bis)|innerhalb (von )?\d+\s*(werk)?tagen|in (\d+|ein|zwei|drei) (werk)?tagen)\b/i;

/**
 * Server-side claim check for every draft revision, whether written by an AI
 * provider or edited by a person. It is deliberately conservative: it cannot
 * prove a text true, but it stops the specific failure modes the operating rules
 * forbid (invented links, dispatch/delivery claims without ERP evidence,
 * completed refunds/replacements that no action provider confirmed).
 */
export function checkDraft(input: DraftCheckInput): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const text = input.text.trim();
  if (!text) return [{ severity: "block", code: "EMPTY", message: "Der Entwurf ist leer." }];

  const known = new Set(input.facts.map((f) => f.id));
  const unknown = input.citedFactIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    issues.push({ severity: "block", code: "UNKNOWN_FACT", message: `Der Vorschlag verweist auf unbekannte Fakten: ${unknown.join(", ")}.` });
  }

  const factText = input.facts.map((f) => f.text).join("\n");
  for (const match of text.matchAll(URL)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    const verified = factText.includes(url) || input.allowedLinkPrefixes.some((p) => p && url.startsWith(p));
    if (!verified) {
      issues.push({ severity: "block", code: "UNVERIFIED_LINK", message: `Link nicht durch ERP-Daten oder freigegebene Links belegt: ${url}` });
    }
  }

  const lower = text.toLowerCase();
  if (unnegatedMatch(lower, DELIVERY_WORDS) && !hasDeliveredEvidence(input.order)) {
    issues.push({ severity: "block", code: "DELIVERY_CLAIM_UNSUPPORTED", message: "Der Text spricht von Zustellung, das ERP enthält aber keinen Zustellvermerk." });
  } else if (unnegatedMatch(lower, DISPATCH_WORDS) && !hasDispatchEvidence(input.order)) {
    issues.push({ severity: "block", code: "DISPATCH_CLAIM_UNSUPPORTED", message: "Der Text spricht von Versand, das ERP enthält aber keine Versandbuchung." });
  }

  if (COMPLETED_ACTIONS.some((pattern) => pattern.test(text))) {
    issues.push({
      severity: "block",
      code: "COMPLETED_ACTION_CLAIM",
      message: "Der Text stellt eine Erstattung, Ersatzlieferung, Stornierung oder Retourenbuchung als erledigt dar. Solche Aktionen sind in dieser Version nicht angebunden und nicht bestätigt.",
    });
  }
  if (PROMISES.test(text)) {
    issues.push({ severity: "warn", code: "DELIVERY_PROMISE", message: "Der Text enthält eine Termin- oder Fristzusage. Bitte prüfen, ob sie belegt ist." });
  }
  if (input.orderStatus !== "unique" && input.citedFactIds.some((id) => id.startsWith("order") || id.startsWith("shipment"))) {
    issues.push({ severity: "block", code: "ORDER_NOT_CONFIRMED", message: "Der Text nutzt Bestelldaten, obwohl die Zuordnung nicht eindeutig ist." });
  }
  const open = openPlaceholders(text);
  if (open.length > 0) {
    issues.push({ severity: "block", code: "PLACEHOLDER_OPEN", message: `Im Text steht noch ein Platzhalter ohne Wert: ${open.join(", ")}. Bitte ausfüllen oder entfernen.` });
  }
  issues.push(...marketplaceIssues(text, input));
  return issues;
}

/**
 * Messaging rules of the marketplaces: no own e-mail addresses or phone numbers, no
 * advertising, on Amazon no links that the order does not need and no review requests.
 * Warnings, because a person may know better (e.g. a recall hotline), but they must
 * be confirmed before approval.
 */
function marketplaceIssues(text: string, input: DraftCheckInput): DraftIssue[] {
  const name = input.sourcePlatform ? MARKETPLACES[input.sourcePlatform] : undefined;
  if (!name) return [];
  const issues: DraftIssue[] = [];
  if (EMAIL_IN_TEXT.test(text) || PHONE_IN_TEXT.test(text)) {
    issues.push({ severity: "warn", code: "MARKETPLACE_CONTACT", message: `${name} erlaubt in Käufernachrichten keine eigenen E-Mail-Adressen oder Telefonnummern (auch nicht in der Signatur). Bitte entfernen, sonst droht eine Sperre der Nachrichtenfunktion.` });
  }
  if (MARKETING.test(text)) {
    issues.push({ severity: "warn", code: "MARKETPLACE_MARKETING", message: `${name} verbietet Werbung und Verweise auf den eigenen Shop in Käufernachrichten (Gutscheine, Newsletter, „bestellen Sie bei uns“).` });
  }
  if (input.sourcePlatform === "amazon") {
    const factText = input.facts.map((f) => f.text).join("\n");
    const extra = [...text.matchAll(URL)].map((m) => m[0].replace(/[.,;:!?]+$/, "")).filter((url) => !factText.includes(url));
    if (extra.length > 0) {
      issues.push({ severity: "warn", code: "MARKETPLACE_LINK", message: `Amazon erlaubt Links nur, wenn sie für die Bestellung nötig sind (z. B. Sendungsverfolgung). Bitte prüfen: ${extra.join(", ")}` });
    }
    if (REVIEW_REQUEST.test(text)) {
      issues.push({ severity: "warn", code: "MARKETPLACE_REVIEW", message: "Amazon verbietet, in Nachrichten um (positive) Bewertungen zu bitten oder dafür etwas anzubieten. Dafür gibt es in Seller Central „Bewertung anfordern“." });
    }
  }
  return issues;
}

export function hasBlockingIssue(issues: ReadonlyArray<DraftIssue>): boolean {
  return issues.some((i) => i.severity === "block");
}
