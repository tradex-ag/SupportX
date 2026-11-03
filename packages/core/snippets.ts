import type { OrderRecord } from "./contracts.ts";
import { trackingHref } from "./tracking.ts";
import { SNIPPET_PLACEHOLDERS, type SnippetPlaceholder } from "./snippet-placeholders.ts";

/**
 * Text blocks the team writes once and reuses, with placeholders filled from the
 * case and from weclapp. No AI is involved. A placeholder without a value stays
 * in the text, so the draft check blocks it until a person fills it in.
 */
export { SNIPPET_PLACEHOLDERS, type SnippetPlaceholder } from "./snippet-placeholders.ts";

const NAMES = Object.keys(SNIPPET_PLACEHOLDERS) as SnippetPlaceholder[];
/** {Name}, {bestellnummer} … (case-insensitive, spaces inside the braces allowed). */
export const PLACEHOLDER_PATTERN = new RegExp(`\\{\\s*(${NAMES.join("|")})\\s*\\}`, "gi");

export interface SnippetContext {
  customerName: string | null;
  /** Only an order that is uniquely linked to the case; otherwise null. */
  order: OrderRecord | null;
  signature: string;
}

function day(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
}

export function placeholderValues(c: SnippetContext): Partial<Record<SnippetPlaceholder, string>> {
  const parcels = c.order?.shipments.flatMap((s) => s.parcels) ?? [];
  const ids = [...new Set(parcels.map((p) => p.trackingId?.trim()).filter((x): x is string => !!x))];
  const links = [...new Set(parcels.map((p) => trackingHref(p.trackingUrl, p.trackingId)).filter((x): x is string => !!x))];
  const values: Partial<Record<SnippetPlaceholder, string>> = {
    Name: c.customerName?.trim() || undefined,
    Bestellnummer: c.order?.orderNumberAtCustomer ?? c.order?.orderNumber,
    Auftragsnummer: c.order?.orderNumber,
    Bestelldatum: day(c.order?.orderDate),
    Sendungsnummer: ids.length ? ids.join(", ") : undefined,
    Trackinglink: links.length ? links.join("\n") : undefined,
    Signatur: c.signature.trim() || undefined,
  };
  return values;
}

/** Fills what is known; returns the names that stay open. */
export function fillSnippet(text: string, c: SnippetContext): { text: string; missing: SnippetPlaceholder[] } {
  const values = placeholderValues(c);
  const missing = new Set<SnippetPlaceholder>();
  const filled = text.replace(PLACEHOLDER_PATTERN, (whole, raw: string) => {
    const name = NAMES.find((n) => n.toLowerCase() === raw.toLowerCase())!;
    const value = values[name];
    if (value === undefined) {
      missing.add(name);
      return `{${name}}`;
    }
    return value;
  });
  return { text: filled, missing: [...missing] };
}

/** Placeholders still in a text (for the draft check). */
export function openPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => `{${m[1]}}`))];
}
