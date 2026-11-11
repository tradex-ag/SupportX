/**
 * Subject patterns: "all mails with this kind of subject" as a sorting rule.
 *
 * Automatic notices (marketplaces, ERP, shop systems) reuse one subject template and
 * fill in amounts, order numbers or claim numbers. Those individual parts do not sit
 * at a fixed position: an amount can open the subject ("26.95 EUR Rückerstattung …"),
 * a claim number can sit in the middle ("Dein SAFE-T-Antrag 12345-… wurde für …").
 * A cut after N characters therefore does not work. Instead every word that contains
 * a digit is treated as individual and becomes a placeholder "*"; the remaining words
 * are the template. A person can edit the pattern before saving it.
 */

export const PLACEHOLDER = "*";
/** A pattern needs this many letters outside placeholders, so "*" alone never sorts every mail. */
export const MIN_PATTERN_LETTERS = 8;
export const MAX_PATTERN_LENGTH = 300;

const DASHES = /[\u2010-\u2015\u2212]/g;

/** Same spacing and dashes everywhere, so "–" and "-" or double spaces do not split a pattern. */
export function normalizeSubject(subject: string): string {
  return subject.replace(DASHES, "-").replace(/\s+/g, " ").trim();
}

/** "26.95 EUR Rückerstattung veranlasst – Bestellung 028-…" → "* EUR Rückerstattung veranlasst - Bestellung *". */
export function subjectPattern(subject: string): string {
  const words = normalizeSubject(subject).split(" ").filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    const variable = /\d/.test(word);
    const token = variable ? PLACEHOLDER : word;
    // Neighbouring placeholders say the same as one ("12.50 EUR" stays "* EUR", "123 456" becomes "*").
    if (token === PLACEHOLDER && out[out.length - 1] === PLACEHOLDER) continue;
    out.push(token);
  }
  return out.join(" ");
}

/** Position (0-based, in characters) of the first individual part, or null when the subject has none. */
export function firstVariableOffset(subject: string): number | null {
  const s = normalizeSubject(subject);
  const m = /\S*\d\S*/.exec(s);
  return m ? m.index : null;
}

export type PatternCheck = { ok: true; pattern: string } | { ok: false; error: string };

/** Clean up a pattern a person typed and refuse ones that would catch almost everything. */
export function checkSubjectPattern(raw: string): PatternCheck {
  const pattern = normalizeSubject(raw).replace(/\*+/g, PLACEHOLDER);
  if (!pattern) return { ok: false, error: "Das Betreff-Muster ist leer." };
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, error: `Das Betreff-Muster ist zu lang (höchstens ${MAX_PATTERN_LENGTH} Zeichen).` };
  const letters = pattern.replace(/\*/g, "").replace(/[^\p{L}]/gu, "").length;
  if (letters < MIN_PATTERN_LETTERS) return { ok: false, error: `Das Betreff-Muster braucht mindestens ${MIN_PATTERN_LETTERS} feste Buchstaben, sonst passt es auf fast jede Mail.` };
  return { ok: true, pattern };
}

/**
 * One "*" is either a run of words that all contain a digit (the unit subjectPattern()
 * replaces: "302-… 12.50") or any single word (a name a person replaced by hand).
 * So a "*" never swallows a reply prefix ("AW: 26.95 …") or text a customer appends
 * ("… Bestellung 302-… – wo bleibt mein Geld?"). For a name of two words write "* *".
 */
const DIGIT_WORD = String.raw`\S*\d\S*`;
const PLACEHOLDER_RE = String.raw`(?:${DIGIT_WORD}(?:\s+${DIGIT_WORD})*|\S+)`;

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const body = normalizeSubject(pattern)
    .split(PLACEHOLDER)
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join(PLACEHOLDER_RE);
  const re = new RegExp(`^${body}$`, "iu");
  if (cache.size > 500) cache.clear();
  cache.set(pattern, re);
  return re;
}

/**
 * Does the subject follow the pattern? The whole subject must match, so a reply
 * ("AW: …") or a forwarded copy of the notice does not count as the notice itself.
 * Each "*" stands for one word, or a run of words with digits (see PLACEHOLDER_RE).
 */
export function matchesSubjectPattern(pattern: string, subject: string): boolean {
  const checked = checkSubjectPattern(pattern);
  if (!checked.ok) return false;
  return toRegExp(checked.pattern).test(normalizeSubject(subject));
}

export interface SubjectGroup {
  pattern: string;
  count: number;
  examples: string[];
  /** Characters before the first individual part, smallest across the group; null when the subjects are fixed text. */
  fixedPrefix: number | null;
}

/** Groups subjects by pattern, largest group first: shows how much subjects of one kind really differ. */
export function groupSubjects(subjects: ReadonlyArray<string>, maxExamples = 3): SubjectGroup[] {
  const groups = new Map<string, SubjectGroup>();
  for (const subject of subjects) {
    const pattern = subjectPattern(subject);
    if (!pattern) continue;
    const g = groups.get(pattern) ?? { pattern, count: 0, examples: [], fixedPrefix: null };
    g.count++;
    if (g.examples.length < maxExamples && !g.examples.includes(subject)) g.examples.push(subject);
    const offset = firstVariableOffset(subject);
    if (offset !== null) g.fixedPrefix = g.fixedPrefix === null ? offset : Math.min(g.fixedPrefix, offset);
    groups.set(pattern, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}
