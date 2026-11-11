import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../../packages/core/timeline.ts";

const msg = (id: string, at: string, extra: Partial<{ direction: string; kind: string; outbox_id: string | null }> = {}) =>
  ({ id, direction: "inbound", kind: "customer", received_at: at, outbox_id: null, ...extra });
const out = (id: string, state: string, created: string, dispatched: string | null = null) =>
  ({ id, state, body: `Antwort ${id}`, expected_recipient: "kunde@example.test", attempts: 1, last_error: null, dispatched_at: dispatched, created_at: created, updated_at: created });

describe("case history as a chat", () => {
  it("puts our sent reply right under the customer message it answers, in time order", () => {
    const t = buildTimeline(
      [msg("m1", "2026-11-01T10:00:00Z"), msg("m2", "2026-11-03T09:00:00Z")],
      [out("o1", "provider_accepted", "2026-11-02T08:00:00Z", "2026-11-02T08:01:00Z")],
    );
    assert.deepEqual(t.map((e) => (e.type === "message" ? e.message.id : e.reply.id)), ["m1", "o1", "m2"]);
    assert.equal(t[1]?.at, "2026-11-02T08:01:00Z");
  });

  it("shows planned and failed replies, leaves withdrawn ones out", () => {
    const t = buildTimeline([msg("m1", "2026-11-01T10:00:00Z")], [
      out("planned", "planned", "2026-11-01T11:00:00Z"),
      out("failed", "failed", "2026-11-01T12:00:00Z"),
      out("gone", "suppressed", "2026-11-01T13:00:00Z"),
    ]);
    assert.deepEqual(t.filter((e) => e.type === "reply").map((e) => e.type === "reply" && e.reply.id), ["planned", "failed"]);
  });

  it("merges the mailbox copy of a sent reply into one entry", () => {
    const t = buildTimeline(
      [msg("m1", "2026-11-01T10:00:00Z"), msg("echo", "2026-11-01T11:02:00Z", { direction: "outbound", kind: "echo", outbox_id: "o1" })],
      [out("o1", "confirmed", "2026-11-01T11:00:00Z", "2026-11-01T11:00:30Z")],
    );
    assert.equal(t.length, 2);
    const reply = t[1];
    assert.ok(reply?.type === "reply");
    assert.equal(reply.echoId, "echo");
  });

  it("keeps an echo whose outbox entry was withdrawn, and replies sent outside SupportX", () => {
    const t = buildTimeline(
      [msg("echo", "2026-11-01T11:02:00Z", { direction: "outbound", kind: "echo", outbox_id: "gone" }), msg("manual", "2026-11-01T12:00:00Z", { direction: "outbound", kind: "manual_external" })],
      [out("gone", "suppressed", "2026-11-01T11:00:00Z")],
    );
    assert.deepEqual(t.map((e) => e.type === "message" && e.message.id), ["echo", "manual"]);
  });

  it("lists every follow-up reply, a message stays before a reply with the same time", () => {
    const t = buildTimeline(
      [msg("m1", "2026-11-01T10:00:00Z"), msg("m2", "2026-11-02T10:00:00Z")],
      [out("o2", "planned", "2026-11-02T10:00:00Z"), out("o1", "provider_accepted", "2026-11-01T10:30:00Z", "2026-11-01T10:31:00Z")],
    );
    assert.deepEqual(t.map((e) => (e.type === "message" ? e.message.id : e.reply.id)), ["m1", "o1", "m2", "o2"]);
  });
});
