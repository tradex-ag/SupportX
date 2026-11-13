import type { MessageAddress } from "./contracts.ts";
import { matchesSubjectPattern } from "./subject-pattern.ts";

/**
 * Is a new mail a customer request, or information/advertising (newsletters,
 * marketplace promotions, partner announcements)? Only "support" mails become
 * cases with order matching and a reply draft. The decision is explainable and
 * a person can always overrule it.
 */
export type MailCategory = "support" | "info";

export interface CategoryRule {
  id?: string;
  /** from_address before subject_pattern before from_domain: the more specific rule wins. */
  matchType: "from_domain" | "from_address" | "subject_pattern";
  pattern: string;
  category: MailCategory;
}

export interface CategoryDecision {
  category: MailCategory;
  source: "auto" | "rule";
  reason: string;
  /** The operator rule that decided, for its hit counter. */
  ruleId?: string;
}

interface CategoryInput {
  from: MessageAddress;
  subject: string;
  bodyText: string;
  headers: Readonly<Record<string, string>>;
  hasOrderReference: boolean;
}

const BULK_SENDER = /^(newsletter|news|marketing|promo(tion)?s?|kampagne|campaign|mailing|info-?mail|partner(-?news)?|no-?reply-?marketing)\b/i;
const PARTNER_SALUTATION = /\b(liebe[rs]? (marketplace-?|marktplatz-?|vertriebs-?|handels-?)?partner(in(nen)?)?|sehr geehrte[rs]? (marketplace-?|marktplatz-?)?partner|dear (marketplace |valued )?(partner|seller|merchant)s?|hallo (liebe )?partner)\b/i;
const PROMO_WORDS = /\b(newsletter|webinar|voucher-?aktion\w*|rabattaktion\w*|aktionszeitraum|promotion(s)?|kampagne\w*|campaign\w*|jetzt (für [^.]{0,40})?anmelden|sign up now|register now|black friday|cyber monday|singles day|prime day|sale\b|deals? of the|top brands|in demand on our marketplace|nicht mehr erhalten|vom newsletter abmelden|unsubscribe|abbestellen)\b/i;
const CUSTOMER_WORDS = /\b(meine bestellung|meiner bestellung|mein paket|meine lieferung|ich habe (bestellt|gekauft)|wann kommt|nicht (erhalten|angekommen)|retour\w*|rücksend\w*|erstatt\w*|reklamation|beschädigt|falsche[rn]? artikel|my order|my parcel|i ordered|where is my)\b/i;

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

function ruleHit(rule: CategoryRule, from: string, subject: string): boolean {
  if (rule.matchType === "subject_pattern") return matchesSubjectPattern(rule.pattern, subject);
  const pattern = rule.pattern.trim().toLowerCase().replace(/^@/, "");
  if (!pattern) return false;
  if (rule.matchType === "from_address") return from === pattern;
  const domain = domainOf(from);
  return domain === pattern || domain.endsWith(`.${pattern}`);
}

/** "Hier ist eine Kopie der E-Mail, die du an Erika gesendet hast." (and the English form). */
export const OWN_COPY = /hier ist eine kopie (der|deiner|ihrer) (e-?mail|nachricht),? die (du|sie) an .{1,80}? gesendet ha(st|ben)|here is a copy of the (e-?mail|message) you sent to/i;
export const OWN_COPY_REASON = "Kopie einer eigenen Nachricht an den Käufer";

/** Our own words inside Amazon's copy: the part between "Beginnmeldung" and "Endmeldung". */
export function ownCopyText(body: string): string {
  const start = /-{3,}\s*(beginnmeldung|begin message)\s*-{3,}/i.exec(body);
  if (!start) return body.trim();
  const rest = body.slice(start.index + start[0].length);
  const end = /-{3,}\s*(endmeldung|end message)\s*-{3,}/i.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

/**
 * Automatic notices a marketplace sends to the seller itself (Seller Central: return
 * authorisations, refunds issued, SAFE-T claims filed, …). Nobody waits for an answer,
 * so they are information with no deadline. They still name the order and show up in
 * the history of the customer's case for that order.
 *
 * Amazon relays buyer mails from <id>@marketplace.amazon.<tld>; its own system mails
 * come from the bare amazon.<tld> domain, so the two never mix. Other senders are set
 * up by the operator with a sender rule ("immer Werbung/Info").
 */
export const SYSTEM_NOTICE_REASON = "Systemmeldung des Marktplatzes";
const SYSTEM_SENDERS: ReadonlyArray<{ platform: string; domain: RegExp }> = [
  { platform: "Amazon", domain: /^amazon\.(de|at|fr|it|es|nl|pl|se|ie|com\.be|com\.tr|co\.uk|com)$/ },
];
/** A claim against us (A-bis-z, chargeback) needs a response: it stays a request even from a system sender. */
const CLAIM_AGAINST_US = /(a-bis-z|a-to-z|garantieantrag|chargeback|rückbuchung)/i;

/** Marketplace name when the mail is one of its automatic seller notices, else null. */
export function systemNoticeOf(input: { from: MessageAddress; subject: string }): string | null {
  const domain = domainOf(input.from.address.toLowerCase());
  const sender = SYSTEM_SENDERS.find((s) => s.domain.test(domain));
  if (!sender || CLAIM_AGAINST_US.test(input.subject)) return null;
  return sender.platform;
}

const RULE_ORDER: Record<CategoryRule["matchType"], number> = { from_address: 0, subject_pattern: 1, from_domain: 2 };

export function ruleReason(rule: Pick<CategoryRule, "matchType" | "pattern">): string {
  return rule.matchType === "subject_pattern" ? `Betreff-Muster „${rule.pattern}“` : `Regel für ${rule.pattern}`;
}

export function categorizeMail(input: CategoryInput, rules: ReadonlyArray<CategoryRule> = []): CategoryDecision {
  const from = input.from.address.toLowerCase();
  // The operator's own rules always win; the more specific rule first.
  const rule = [...rules].sort((a, b) => RULE_ORDER[a.matchType] - RULE_ORDER[b.matchType]).find((r) => ruleHit(r, from, input.subject));
  if (rule) return { category: rule.category, source: "rule", reason: ruleReason(rule), ...(rule.id ? { ruleId: rule.id } : {}) };

  // Amazon mails us a copy of every message we send to a buyer: our own words, not a request.
  if (OWN_COPY.test(`${input.subject}\n${input.bodyText.slice(0, 2000)}`)) return { category: "info", source: "auto", reason: OWN_COPY_REASON };
  // Seller notices name an order and words like "Rückerstattung", yet nobody asked anything.
  if (systemNoticeOf(input)) return { category: "info", source: "auto", reason: SYSTEM_NOTICE_REASON };

  const reasons: string[] = [];
  let score = 0;
  const h = input.headers;
  if (h["list-unsubscribe"] || h["list-id"]) { score += 2; reasons.push("Abmeldelink im Kopf der Mail"); }
  if (/^(bulk|list|junk)$/i.test(h["precedence"] ?? "")) { score += 2; reasons.push("als Massenmail gekennzeichnet"); }
  if (h["feedback-id"] || h["x-campaign"] || h["x-campaign-id"] || h["x-mc-user"]) { score += 1; reasons.push("Kampagnen-Kennung"); }
  if (BULK_SENDER.test(from.split("@")[0] ?? "")) { score += 1; reasons.push("Absender ist ein Newsletter-Konto"); }
  const text = `${input.subject}\n${input.bodyText.slice(0, 5000)}`;
  if (PARTNER_SALUTATION.test(text)) { score += 2; reasons.push("Anrede an Händler oder Partner"); }
  const promo = new Set((text.match(new RegExp(PROMO_WORDS.source, "gi")) ?? []).map((w) => w.toLowerCase()));
  if (promo.size) { score += Math.min(promo.size, 2); reasons.push(`Werbebegriffe (${[...promo].slice(0, 3).join(", ")})`); }

  // A concrete order or a customer complaint keeps the mail a request, whatever it looks like.
  if (input.hasOrderReference || CUSTOMER_WORDS.test(text)) return { category: "support", source: "auto", reason: "Kundenanliegen erkannt" };
  if (score >= 2) return { category: "info", source: "auto", reason: reasons.join(", ") };
  return { category: "support", source: "auto", reason: "keine Werbemerkmale" };
}
