/**
 * Forwarding one mail of a case to other addresses. Pure helpers shared by the
 * service, the UI and the tests: recipient parsing, the mode per case and the
 * text of a relay-safe forward.
 */
import type { SourcePlatform } from "./contracts.ts";

export const MAX_FORWARD_RECIPIENTS = 10;
export const MAX_FORWARD_COMMENT = 5000;

/** Platforms whose mails arrive through a buyer relay address that must stay in the mailbox. */
const RELAY_PLATFORMS: ReadonlySet<string> = new Set(["amazon", "ebay", "kaufland", "shop_apotheke"]);

/** Sender domains of marketplace relay addresses, also when no routing rule set the platform. */
const RELAY_DOMAINS = [/(^|\.)marketplace\.amazon\.[a-z.]+$/, /(^|\.)members\.ebay\.[a-z.]+$/];

const EMAIL = /^[^\s@<>(),;:"\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const EMAIL_IN_TEXT = /[^\s@<>(),;:"'\[\]]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

export type ForwardMode = "original" | "text";

export function isRelayAddress(address: string): boolean {
  const domain = address.toLowerCase().split("@")[1] ?? "";
  return RELAY_DOMAINS.some((d) => d.test(domain));
}

/**
 * Original forward only for plain mail cases. A marketplace relay mail goes out
 * as text without addresses: the relay address identifies the buyer and would let
 * the recipient write to the customer around the marketplace.
 */
export function forwardMode(platform: SourcePlatform | string, addresses: ReadonlyArray<string>): ForwardMode {
  if (RELAY_PLATFORMS.has(platform)) return "text";
  return addresses.some(isRelayAddress) ? "text" : "original";
}

/** Split a typed list ("a@x.de, b@y.de; c@z.de") into checked, de-duplicated addresses. */
export function parseRecipients(input: string | ReadonlyArray<string>): { valid: string[]; invalid: string[] } {
  const parts = (typeof input === "string" ? [input] : [...input]).flatMap((p) => p.split(/[\s,;]+/)).map((p) => p.trim().replace(/^<|>$/g, "")).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const a = p.toLowerCase();
    if (!EMAIL.test(a) || a.length > 254) invalid.push(p);
    else if (!valid.includes(a)) valid.push(a);
  }
  return { valid, invalid };
}

/** "Fwd: Betreff", without stacking prefixes. */
export function forwardSubject(subject: string): string {
  const base = subject.replace(/^\s*((fwd?|wg|aw|re)\s*:\s*)+/i, "").trim();
  return `Fwd: ${base || "(ohne Betreff)"}`.slice(0, 500);
}

/** Every mail address in a text replaced by a placeholder. */
export function maskAddresses(text: string): string {
  return text.replace(EMAIL_IN_TEXT, "[Adresse entfernt]");
}

const PLATFORM_NAME: Record<string, string> = { amazon: "Amazon", ebay: "eBay", kaufland: "Kaufland", shop_apotheke: "Shop Apotheke", docmorris: "DocMorris", shopify: "Shopify", email: "E-Mail" };

/** Body of a relay-safe forward: own comment, then the original text with all addresses removed. */
export function forwardText(input: { comment: string; platform: string; receivedAt: Date | string; subject: string; direction: "inbound" | "outbound"; body: string; leftOut?: ReadonlyArray<string> }): string {
  const when = new Date(input.receivedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
  const from = input.direction === "inbound" ? `Kunde über ${PLATFORM_NAME[input.platform] ?? input.platform}` : "wir (Kundenservice)";
  const lines = [
    ...(input.comment.trim() ? [input.comment.trim(), ""] : []),
    "---------- Weitergeleitete Nachricht ----------",
    `Von: ${from}`,
    `Datum: ${when}`,
    `Betreff: ${maskAddresses(input.subject) || "(ohne Betreff)"}`,
    "",
    maskAddresses(input.body).trim(),
  ];
  if (input.leftOut?.length) lines.push("", `Nicht mitgesendet (zu groß): ${input.leftOut.join(", ")}`);
  return lines.join("\n");
}
