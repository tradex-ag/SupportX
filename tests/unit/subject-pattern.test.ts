import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categorizeMail } from "../../packages/core/category.ts";
import { checkSubjectPattern, firstVariableOffset, groupSubjects, matchesSubjectPattern, subjectPattern } from "../../packages/core/subject-pattern.ts";

// Neutral subjects shaped like marketplace notices; all numbers are made up.
const REFUNDS = [
  "26.95 EUR Rückerstattung veranlasst – Bestellung 302-1111111-1111111",
  "18.3 EUR Rückerstattung veranlasst – Bestellung 306-2222222-2222222",
];
const CLAIMS = [
  "Dein SAFE-T-Antrag 10001-20002-3000003 wurde für die Bestellung 302-4444444-4444444 eingereicht",
  "Dein SAFE-T-Antrag 10004-20005-3000006 wurde für die Bestellung 028-5555555-5555555 eingereicht",
];
const RETURNS = ["Benachrichtigung zur Rücksendegenehmigung für die Bestellung 302-6666666-6666666"];
const FIXED = "Fehler bei Bestand Synchronisation";

describe("subject patterns", () => {
  it("turns amounts, order and claim numbers into placeholders wherever they sit", () => {
    assert.equal(subjectPattern(REFUNDS[0]!), "* EUR Rückerstattung veranlasst - Bestellung *");
    assert.equal(subjectPattern(CLAIMS[0]!), "Dein SAFE-T-Antrag * wurde für die Bestellung * eingereicht");
    assert.equal(subjectPattern(RETURNS[0]!), "Benachrichtigung zur Rücksendegenehmigung für die Bestellung *");
    assert.equal(subjectPattern(FIXED), FIXED);
    assert.equal(subjectPattern("Bestellung 123 456  #789"), "Bestellung *", "neighbouring numbers become one placeholder");
  });

  it("the individual part starts at very different positions, so a fixed character cut cannot work", () => {
    assert.equal(firstVariableOffset(REFUNDS[0]!), 0);
    assert.equal(firstVariableOffset(CLAIMS[0]!), 19);
    assert.equal(firstVariableOffset(RETURNS[0]!), 61);
    assert.equal(firstVariableOffset(FIXED), null);
  });

  it("groups subjects of one kind together and counts them", () => {
    const groups = groupSubjects([...REFUNDS, ...CLAIMS, ...RETURNS, FIXED, FIXED]);
    assert.deepEqual(groups.map((g) => [g.pattern, g.count]), [
      ["* EUR Rückerstattung veranlasst - Bestellung *", 2],
      ["Dein SAFE-T-Antrag * wurde für die Bestellung * eingereicht", 2],
      ["Fehler bei Bestand Synchronisation", 2],
      ["Benachrichtigung zur Rücksendegenehmigung für die Bestellung *", 1],
    ]);
    assert.equal(groups[0]!.fixedPrefix, 0);
  });

  it("matches every subject of the kind, ignoring dash style, spacing and case", () => {
    const p = subjectPattern(CLAIMS[0]!);
    for (const s of CLAIMS) assert.ok(matchesSubjectPattern(p, s));
    assert.ok(matchesSubjectPattern(p, "dein safe-t-antrag 9 wurde  für die bestellung 1 eingereicht"));
    assert.ok(matchesSubjectPattern(subjectPattern(REFUNDS[0]!), "5 EUR Rückerstattung veranlasst - Bestellung 1"));
    assert.ok(!matchesSubjectPattern(p, REFUNDS[0]!));
    assert.ok(!matchesSubjectPattern(p, "Dein SAFE-T-Antrag  wurde für die Bestellung 1 eingereicht"), "a placeholder needs content");
  });

  it("does not catch replies, forwards or a customer's longer subject", () => {
    const p = subjectPattern(REFUNDS[0]!);
    assert.ok(!matchesSubjectPattern(p, `AW: ${REFUNDS[0]}`));
    assert.ok(!matchesSubjectPattern(p, `WG: ${REFUNDS[0]}`));
    assert.ok(!matchesSubjectPattern(subjectPattern(RETURNS[0]!), `${RETURNS[0]} – wo bleibt mein Geld?`));
    assert.ok(!matchesSubjectPattern("Nachricht von * zur Bestellung *", "Nachricht von Erika Muster zur Bestellung 1"), "one * is one word");
    assert.ok(matchesSubjectPattern("Nachricht von * * zur Bestellung *", "Nachricht von Erika Muster zur Bestellung 1 2"));
  });

  it("treats everything except * literally", () => {
    assert.ok(matchesSubjectPattern("Antrag (neu) für Bestellung *", "Antrag (neu) für Bestellung 7"));
    assert.ok(!matchesSubjectPattern("Antrag (neu) für Bestellung *", "Antrag neu für Bestellung 7"));
    assert.ok(!matchesSubjectPattern("Antrag.für.Bestellung *", "AntragXfürXBestellung 7"));
  });

  it("refuses patterns that would catch almost everything", () => {
    assert.equal(checkSubjectPattern("*").ok, false);
    assert.equal(checkSubjectPattern("* EUR *").ok, false);
    assert.equal(checkSubjectPattern("   ").ok, false);
    assert.equal(checkSubjectPattern("x".repeat(301)).ok, false);
    assert.deepEqual(checkSubjectPattern("  Dein  Antrag ** *  eingereicht "), { ok: true, pattern: "Dein Antrag * * eingereicht" });
    assert.ok(!matchesSubjectPattern("*", "irgendwas"));
  });
});

describe("subject rules in sorting", () => {
  const mail = (subject: string, from = "kunde@example.invalid") => ({ from: { address: from }, subject, bodyText: "Hallo", headers: {}, hasOrderReference: true });
  const rule = { id: "r1", matchType: "subject_pattern" as const, pattern: subjectPattern(CLAIMS[0]!), category: "info" as const };

  it("files matching mails as info and names the rule", () => {
    const d = categorizeMail(mail(CLAIMS[1]!, "system@shop.example.invalid"), [rule]);
    assert.deepEqual(d, { category: "info", source: "rule", reason: `Betreff-Muster „${rule.pattern}“`, ruleId: "r1" });
    assert.equal(categorizeMail(mail("Frage zu Bestellung 302-1"), [rule]).source, "auto");
  });

  it("an address rule beats a subject rule, a subject rule beats a domain rule", () => {
    const addr = { matchType: "from_address" as const, pattern: "system@shop.example.invalid", category: "support" as const };
    const dom = { matchType: "from_domain" as const, pattern: "shop.example.invalid", category: "support" as const };
    assert.equal(categorizeMail(mail(CLAIMS[1]!, "system@shop.example.invalid"), [rule, addr]).category, "support");
    assert.equal(categorizeMail(mail(CLAIMS[1]!, "other@shop.example.invalid"), [dom, rule]).category, "info");
  });
});
