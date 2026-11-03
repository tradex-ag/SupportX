import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase, leavePresence, listCases, reopenDueFollowUps, setStatus, touchPresence, updateWorkspaceSettings } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { OWN_COPY_REASON } from "../../packages/core/category.ts";
import { renderSnippet, snippetDraft } from "../../packages/services/replies.ts";
import { deleteSnippet, listSnippets, saveSnippet } from "../../packages/services/snippets.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

type Seeded = Awaited<ReturnType<typeof seedWorkspace>>;
type Row = { id: string; due_at: string | null; reply_hours: number | null; waiting_since: string | null; open_by: string | null; status: string; snooze_until: string | null };

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

async function conversation(ws: Seeded, input: { key: string; platform: string; subject: string; name?: string; refs?: string[]; messages: Array<{ dir: "inbound" | "outbound"; at: Date; body: string }> }): Promise<string> {
  const db = h!.ctx.db;
  const row = await db.query<{ id: string }>(
    `INSERT INTO conversations (workspace_id, connection_id, external_thread_key, source_platform, subject, customer_address, customer_name, order_references, last_message_at, order_match_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'missing') RETURNING id`,
    [ws.workspaceId, ws.connectionId, input.key, input.platform, input.subject, `${input.key}@kunde.example.invalid`, input.name ?? null, JSON.stringify((input.refs ?? []).map((value) => ({ value, kind: "amazon_order" })))],
  );
  const id = row.rows[0]!.id;
  let n = 0;
  let latest: string | null = null;
  for (const m of input.messages) {
    const msg = await db.query<{ id: string }>(
      `INSERT INTO messages (workspace_id, conversation_id, connection_id, external_message_id, direction, kind, from_address, subject, body_text, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [ws.workspaceId, id, ws.connectionId, `${input.key}-${n++}`, m.dir, m.dir === "inbound" ? "customer" : "manual_external", m.dir === "inbound" ? `${input.key}@kunde.example.invalid` : "service@demo.invalid", input.subject, m.body, m.at],
    );
    if (m.dir === "inbound") latest = msg.rows[0]!.id;
  }
  await db.query("UPDATE conversations SET latest_inbound_message_id = $3 WHERE workspace_id = $1 AND id = $2", [ws.workspaceId, id, latest]);
  return id;
}

describe("0.6.0 basics", () => {
  it("sorts open cases by the deadline that runs out first and lets the owner change the hours", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const answered = await conversation(s, { key: "a", platform: "amazon", subject: "Beantwortet", messages: [{ dir: "inbound", at: hoursAgo(30), body: "Frage" }, { dir: "outbound", at: hoursAgo(29), body: "Antwort" }] });
    const mail = await conversation(s, { key: "b", platform: "email", subject: "Mail", messages: [{ dir: "inbound", at: hoursAgo(1), body: "Frage" }] });
    const amazon = await conversation(s, { key: "c", platform: "amazon", subject: "Amazon", messages: [{ dir: "inbound", at: hoursAgo(25), body: "Erste" }, { dir: "outbound", at: hoursAgo(22), body: "Antwort" }, { dir: "inbound", at: hoursAgo(20), body: "Nachfrage" }, { dir: "inbound", at: hoursAgo(2), body: "Und?" }] });

    const rows = (await listCases(h.ctx, s.agent, "open")) as Row[];
    assert.deepEqual(rows.map((r) => r.id), [amazon, mail, answered]);
    const a = rows[0]!;
    assert.equal(a.reply_hours, 24);
    assert.ok(Math.abs(new Date(a.waiting_since!).getTime() - hoursAgo(20).getTime()) < 60_000, "clock starts at the first unanswered customer message");
    assert.equal(rows[2]!.waiting_since, null, "answered case has no deadline");
    const detail = (await getCase(h.ctx, s.agent, amazon)).conversation as Row;
    assert.equal(detail.reply_hours, 24);
    assert.ok(detail.waiting_since);

    await assert.rejects(updateWorkspaceSettings(h.ctx, s.agent, { replyDeadlines: { amazon: 12 } }), (e: ServiceError) => e.code === "FORBIDDEN");
    await assert.rejects(updateWorkspaceSettings(h.ctx, s.owner, { replyDeadlines: { amazon: 500 } }), (e: ServiceError) => e.code === "INVALID");
    await updateWorkspaceSettings(h.ctx, s.owner, { replyDeadlines: { amazon: 0 } });
    const after = (await listCases(h.ctx, s.agent, "open")) as Row[];
    assert.equal(after.find((r) => r.id === amazon)!.reply_hours, null, "0 = no deadline");
    assert.equal(after[0]!.id, mail);

    // Answered in Seller Central: Amazon's copy of our message is its own info case, and it stops the clock.
    const viaCopy = await conversation(s, { key: "d", platform: "amazon", subject: "Seller Central", refs: ["302-0000000-0000001"], messages: [{ dir: "inbound", at: hoursAgo(5), body: "Frage" }] });
    await updateWorkspaceSettings(h.ctx, s.owner, { replyDeadlines: { amazon: 24 } });
    assert.ok(((await listCases(h.ctx, s.agent, "open")) as Row[]).find((r) => r.id === viaCopy)!.waiting_since);
    const copy = await conversation(s, { key: "copy", platform: "amazon", subject: "Kopie", refs: ["302-0000000-0000001"], messages: [{ dir: "inbound", at: hoursAgo(4), body: "Hier ist eine Kopie der E-Mail, die du an d gesendet hast." }] });
    await h.ctx.db.query("UPDATE conversations SET category = 'info', category_reason = $2 WHERE id = $1", [copy, OWN_COPY_REASON]);
    assert.equal(((await listCases(h.ctx, s.agent, "open")) as Row[]).find((r) => r.id === viaCopy)!.waiting_since, null);

    await setStatus(h.ctx, s.agent, mail, "waiting");
    assert.equal(((await listCases(h.ctx, s.agent, "all")) as Row[]).find((r) => r.id === mail)!.waiting_since, null, "Wartet stops the clock");
  });

  it("searches all cases by order number, name, text and address, within the workspace only", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const one = await conversation(s, { key: "s1", platform: "amazon", subject: "Dose kaputt", name: "Erika Muster", refs: ["302-1234567-7654321"], messages: [{ dir: "inbound", at: hoursAgo(1), body: "Die Teekanne kam mit Sprung an." }] });
    const two = await conversation(s, { key: "s2", platform: "ebay", subject: "Rechnung", messages: [{ dir: "inbound", at: hoursAgo(2), body: "Bitte Rechnung 50% schneller" }] });
    await setStatus(h.ctx, s.agent, two, "closed");
    await conversation(other, { key: "s3", platform: "amazon", subject: "Fremd", name: "Erika Muster", refs: ["302-1234567-7654321"], messages: [{ dir: "inbound", at: hoursAgo(1), body: "Teekanne" }] });

    const ids = async (q: string) => ((await listCases(h!.ctx, s.agent, "open", q)) as Row[]).map((r) => r.id);
    assert.deepEqual(await ids("7654321"), [one]);
    assert.deepEqual(await ids("erika"), [one]);
    assert.deepEqual(await ids("Sprung"), [one]);
    assert.deepEqual(await ids("s2@kunde"), [two], "finds closed cases too, whatever tab is open");
    assert.deepEqual(await ids("50%"), [two]);
    assert.deepEqual(await ids("%%"), [], "wildcards are literal");
    await assert.rejects(listCases(h.ctx, s.agent, "open", "x"), (e: ServiceError) => e.code === "INVALID");
  });

  it("text blocks: the team writes them, cases fill them from weclapp, open placeholders block", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const conv = await conversation(s, { key: "t1", platform: "amazon", subject: "Wo ist mein Paket", name: "Erika Muster", messages: [{ dir: "inbound", at: hoursAgo(1), body: "Wo ist mein Paket?" }] });
    await assert.rejects(saveSnippet(h.ctx, s.viewer, { title: "X", body: "Y" }), (e: ServiceError) => e.code === "FORBIDDEN");
    await assert.rejects(saveSnippet(h.ctx, s.agent, { title: " ", body: "Y" }), (e: ServiceError) => e.code === "INVALID");
    const snippet = await saveSnippet(h.ctx, s.agent, { title: "Tracking", body: "Guten Tag {Name},\n\nIhre Sendung {Sendungsnummer}:\n{Trackinglink}\n\n{Signatur}" });
    assert.deepEqual((await listSnippets(h.ctx, s.viewer)).map((x) => x.title), ["Tracking"]);
    assert.deepEqual(await listSnippets(h.ctx, other.agent), [], "other workspace sees nothing");
    await assert.rejects(renderSnippet(h.ctx, other.agent, conv, snippet.id), (e: ServiceError) => e.code === "NOT_FOUND");

    const without = await renderSnippet(h.ctx, s.agent, conv, snippet.id);
    assert.match(without.text, /^Guten Tag Erika Muster,/);
    assert.deepEqual(without.missing.sort(), ["Sendungsnummer", "Trackinglink"]);
    const blocked = await snippetDraft(h.ctx, s.agent, conv, snippet.id);
    const d1 = (await h.ctx.db.query<{ generated_by: string; issues: Array<{ code: string; severity: string }>; body: string }>("SELECT generated_by, issues, body FROM drafts WHERE id = $1", [blocked.draftId])).rows[0]!;
    assert.equal(d1.generated_by, "snippet");
    assert.ok(d1.issues.some((i) => i.code === "PLACEHOLDER_OPEN" && i.severity === "block"));

    // With a uniquely linked order the parcel number and tracking link come from weclapp.
    const snapshot = {
      provider: "weclapp", id: "so-9", orderNumber: "AU-9", orderNumberAtCustomer: "302-1111111-2222222", tags: [], lines: [], invoices: [], retrievedAt: new Date().toISOString(),
      shipments: [{ id: "sh", statusHistory: [], items: [], parcels: [{ trackingId: "JJD000111", trackingUrl: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=", source: "parcels" }] }],
    };
    await h.ctx.db.query("INSERT INTO order_links (workspace_id, conversation_id, status, linked_by, external_order_id, snapshot, retrieved_at, is_current) VALUES ($1, $2, 'unique', 'auto', 'so-9', $3, now(), true)", [s.workspaceId, conv, JSON.stringify(snapshot)]);
    await h.ctx.db.query("UPDATE conversations SET order_match_status = 'unique' WHERE id = $1", [conv]);
    const ok = await snippetDraft(h.ctx, s.agent, conv, snippet.id);
    assert.deepEqual(ok.missing, []);
    const d2 = (await h.ctx.db.query<{ issues: Array<{ code: string; severity: string }>; body: string }>("SELECT issues, body FROM drafts WHERE id = $1", [ok.draftId])).rows[0]!;
    assert.match(d2.body, /Ihre Sendung JJD000111:\nhttps:\/\/www\.dhl\.de\/.*piececode=JJD000111/);
    assert.ok(!d2.issues.some((i) => i.severity === "block"), JSON.stringify(d2.issues));
    const superseded = (await h.ctx.db.query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [blocked.draftId])).rows[0]!;
    assert.equal(superseded.status, "superseded", "one current draft per case");

    await assert.rejects(deleteSnippet(h.ctx, other.owner, snippet.id), (e: ServiceError) => e.code === "NOT_FOUND");
    await deleteSnippet(h.ctx, s.agent, snippet.id);
    assert.deepEqual(await listSnippets(h.ctx, s.agent), []);
  });

  it("shows who else has the case open or is writing, and nobody outside the workspace", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const conv = await conversation(s, { key: "p1", platform: "amazon", subject: "Frage", messages: [{ dir: "inbound", at: hoursAgo(1), body: "Hallo" }] });
    assert.deepEqual(await touchPresence(h.ctx, s.agent, conv, true), []);
    assert.deepEqual(await touchPresence(h.ctx, s.owner, conv, false), [{ name: "agent Testhändler", editing: true }]);
    assert.deepEqual(await touchPresence(h.ctx, s.agent, conv, false), [{ name: "owner Testhändler", editing: false }]);
    const forOwner = ((await listCases(h.ctx, s.owner, "open")) as Row[])[0]!;
    assert.equal(forOwner.open_by, "agent Testhändler", "the list names the others, not oneself");
    await h.ctx.db.query("UPDATE case_presence SET seen_at = now() - interval '2 minutes' WHERE user_id = $1", [s.agent.type === "user" ? s.agent.userId : ""]);
    assert.deepEqual(await touchPresence(h.ctx, s.owner, conv, false), [], "a stale heartbeat does not count");
    await leavePresence(h.ctx, s.owner, conv);
    assert.equal(((await listCases(h.ctx, s.agent, "open")) as Row[])[0]!.open_by, null);
    await assert.rejects(touchPresence(h.ctx, other.agent, conv, false), (e: ServiceError) => e.code === "NOT_FOUND");
  });

  it("Wartet with a follow-up date reopens the case on that day", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const conv = await conversation(s, { key: "w1", platform: "ebay", subject: "Rücksendung", messages: [{ dir: "inbound", at: hoursAgo(1), body: "Ich schicke es zurück" }] });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await assert.rejects(setStatus(h.ctx, s.agent, conv, "waiting", hoursAgo(1).toISOString()), (e: ServiceError) => e.code === "INVALID");
    await assert.rejects(setStatus(h.ctx, s.agent, conv, "open", tomorrow), (e: ServiceError) => e.code === "INVALID");
    await assert.rejects(setStatus(h.ctx, s.viewer, conv, "waiting", tomorrow), (e: ServiceError) => e.code === "FORBIDDEN");
    await setStatus(h.ctx, s.agent, conv, "waiting", tomorrow);
    let row = ((await listCases(h.ctx, s.agent, "waiting")) as Row[])[0]!;
    assert.equal(new Date(row.snooze_until!).toISOString(), tomorrow);

    assert.equal(await reopenDueFollowUps(h.ctx), 0, "not before the day");
    await h.ctx.db.query("UPDATE conversations SET snooze_until = now() - interval '1 minute' WHERE id = $1", [conv]);
    assert.equal(await reopenDueFollowUps(h.ctx), 1);
    row = ((await listCases(h.ctx, s.agent, "open")) as Row[])[0]!;
    assert.equal(row.status, "open");
    assert.ok(row.snooze_until, "kept as the marker Wiedervorlage");
    await setStatus(h.ctx, s.agent, conv, "closed");
    assert.equal(((await listCases(h.ctx, s.agent, "closed")) as Row[])[0]!.snooze_until, null, "a person's status clears it");
  });
});
