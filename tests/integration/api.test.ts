import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../../apps/server/app.ts";
import { addNote } from "../../packages/services/cases.ts";
import { many } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness, type SeededWorkspace } from "./harness.ts";

describe("HTTP API: authentication, CSRF and workspace isolation", () => {
  let h: Harness;
  let app: FastifyInstance;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  let cookieA = "";
  let caseB = "";
  let caseA = "";

  before(async () => {
    h = await createHarness();
    a = await seedWorkspace(h, "Händler A");
    b = await seedWorkspace(h, "Händler B");
    loadDemoMails(h.graph);
    await syncAndDrain(h, a);
    await syncAndDrain(h, b);
    caseA = (await caseByThread(h, a, "conv-amazon-wismo")).id;
    caseB = (await caseByThread(h, b, "conv-amazon-wismo")).id;
    app = await buildServer(h.ctx);
    const res = await app.inject({ method: "POST", url: "/api/login", headers: { "x-supportx-request": "1" }, payload: { email: a.agentEmail, password: "test-passwort-123" } });
    assert.equal(res.statusCode, 200);
    cookieA = String(res.headers["set-cookie"]).split(";")[0]!;
  });
  after(async () => {
    await app.close();
    await h.close();
    await closeDb();
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/w/${a.workspaceId}/cases` });
    assert.equal(res.statusCode, 401);
  });

  it("rejects state changes without the CSRF header", async () => {
    const res = await app.inject({ method: "POST", url: `/api/w/${a.workspaceId}/cases/${caseA}/notes`, headers: { cookie: cookieA }, payload: { body: "x" } });
    assert.equal(res.statusCode, 403);
  });

  it("lists only own cases", async () => {
    const res = await app.inject({ method: "GET", url: `/api/w/${a.workspaceId}/cases?filter=all`, headers: { cookie: cookieA } });
    assert.equal(res.statusCode, 200);
    const ids = (res.json() as { cases: Array<{ id: string }> }).cases.map((c) => c.id);
    assert.ok(ids.includes(caseA));
    assert.ok(!ids.includes(caseB));
  });

  it("returns 404 for another workspace and for its objects", async () => {
    const other = await app.inject({ method: "GET", url: `/api/w/${b.workspaceId}/cases`, headers: { cookie: cookieA } });
    assert.equal(other.statusCode, 404);
    const foreignCase = await app.inject({ method: "GET", url: `/api/w/${a.workspaceId}/cases/${caseB}`, headers: { cookie: cookieA } });
    assert.equal(foreignCase.statusCode, 404);
    const draftsB = await many<{ id: string; version: number }>(h.ctx.db, "SELECT id, version FROM drafts WHERE workspace_id = $1 LIMIT 1", [b.workspaceId]);
    const send = await app.inject({
      method: "POST", url: `/api/w/${a.workspaceId}/drafts/${draftsB[0]!.id}/send`, headers: { cookie: cookieA, "x-supportx-request": "1" }, payload: { expectedVersion: draftsB[0]!.version, acknowledgeWarnings: true },
    });
    assert.equal(send.statusCode, 404);
  });

  it("never exposes credentials in settings", async () => {
    const res = await app.inject({ method: "GET", url: `/api/w/${a.workspaceId}/settings`, headers: { cookie: cookieA } });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /demo-graph-secret|demo-weclapp-token|clientState/);
  });

  it("keeps internal notes out of the AI input", async () => {
    await addNote(h.ctx, a.agent, caseA, "INTERN: Kunde ist schwierig");
    const seen: string[] = [];
    const original = h.ctx.ai.propose.bind(h.ctx.ai);
    h.ctx.ai = { ...h.ctx.ai, id: h.ctx.ai.id, model: h.ctx.ai.model, promptVersion: h.ctx.ai.promptVersion, propose: async (input) => { seen.push(JSON.stringify(input)); return original(input); } };
    const url = `/api/w/${a.workspaceId}/cases/${caseA}/redraft`;
    const headers = { cookie: cookieA, "x-supportx-request": "1" };
    assert.equal((await app.inject({ method: "POST", url, headers })).statusCode, 400, "no reply without a decision");
    const res = await app.inject({ method: "POST", url, headers, payload: { decision: "customer_right" } });
    assert.equal(res.statusCode, 200);
    const { drainJobs } = await import("../../packages/services/worker.ts");
    await drainJobs(h.ctx);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((s) => s.includes('"decision":"customer_right"')), "the decision reaches the writer");
    assert.ok(seen.every((s) => !s.includes("INTERN: Kunde ist schwierig")));
  });

  it("changes the own password and ends the other sessions", async () => {
    const loginB = (password: string): Promise<LightMyRequestResponse> => app.inject({ method: "POST", url: "/api/login", headers: { "x-supportx-request": "1" }, payload: { email: b.agentEmail, password } });
    const first = String((await loginB("test-passwort-123")).headers["set-cookie"]).split(";")[0]!;
    const second = String((await loginB("test-passwort-123")).headers["set-cookie"]).split(";")[0]!;
    const change = (cookie: string, payload: object): Promise<LightMyRequestResponse> => app.inject({ method: "POST", url: "/api/password", headers: { cookie, "x-supportx-request": "1" }, payload });
    assert.equal((await change(first, { oldPassword: "falsch-falsch", newPassword: "neues-passwort-456" })).statusCode, 400);
    assert.equal((await change(first, { oldPassword: "test-passwort-123", newPassword: "kurz" })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/password", headers: { cookie: first }, payload: { oldPassword: "test-passwort-123", newPassword: "neues-passwort-456" } })).statusCode, 403);
    assert.equal((await change(first, { oldPassword: "test-passwort-123", newPassword: "neues-passwort-456" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: first } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: second } })).statusCode, 401);
    assert.equal((await loginB("test-passwort-123")).statusCode, 401);
    assert.equal((await loginB("neues-passwort-456")).statusCode, 200);
  });
});

describe("installation theme over HTTP", () => {
  it("serves the theme to the login page without a session", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "theme-"));
    writeFileSync(path.join(dir, "theme.json"), JSON.stringify({ productName: "Kundenservice", logo: "logo.svg", colors: { primary: "#2f6b2a" } }));
    writeFileSync(path.join(dir, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    writeFileSync(path.join(dir, "secret.env"), "nope");
    const h2 = await createHarness();
    const app2 = await buildServer({ ...h2.ctx, config: { ...h2.ctx.config, THEME_DIR: dir } });
    try {
      const meta = await app2.inject({ method: "GET", url: "/api/theme" });
      assert.equal(meta.statusCode, 200);
      assert.deepEqual(meta.json(), { productName: "Kundenservice", tagline: "Support-Posteingang für Marktplatz-Händler", logoUrl: "/theme/logo.svg" });
      const css = await app2.inject({ method: "GET", url: "/theme.css" });
      assert.match(css.body, /--primary:#2f6b2a/);
      assert.equal((await app2.inject({ method: "GET", url: "/theme/logo.svg" })).statusCode, 200);
      // Only image and font files leave the theme folder (anything else falls through to the app shell).
      assert.doesNotMatch((await app2.inject({ method: "GET", url: "/theme/secret.env" })).body, /nope/);
      assert.doesNotMatch((await app2.inject({ method: "GET", url: "/theme/theme.json" })).body, /"productName"/);
      assert.doesNotMatch((await app2.inject({ method: "GET", url: "/theme/..%2fsecret.env" })).body, /nope/);
    } finally {
      await app2.close();
      await h2.close();
    }
  });
});
