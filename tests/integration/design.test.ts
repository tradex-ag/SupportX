import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { buildServer } from "../../apps/server/app.ts";
import { deleteLogo, getLogo, logoVersion, previewDesign, resetDesign, saveDesign, saveLogo, workspaceTheme } from "../../packages/services/design.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("workspace design", () => {
  it("only the owner previews and saves, the look stays in its workspace, reset restores the default", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const reading = previewDesign(s.owner, "Hintergrund: #ffffff\nAkzent: #6d33d6");
    assert.equal(reading.theme.colors.accent, "#6d33d6");
    assert.throws(() => previewDesign(s.agent, "Akzent: #6d33d6"), (e: { status?: number }) => e.status === 403);
    await assert.rejects(saveDesign(h.ctx, s.agent, reading.theme), (e: { status?: number }) => e.status === 403);
    await assert.rejects(saveDesign(h.ctx, s.owner, { colors: { text: "red" }, fonts: {} }), (e: { status?: number }) => e.status === 400);

    await saveDesign(h.ctx, s.owner, reading.theme);
    assert.equal((await workspaceTheme(h.ctx, s.viewer))?.colors.accent, "#6d33d6", "everyone in the workspace gets the look");
    assert.equal(await workspaceTheme(h.ctx, other.owner), null, "another workspace keeps its own look");

    await resetDesign(h.ctx, s.owner);
    assert.equal(await workspaceTheme(h.ctx, s.owner), null);
  });

  it("logo: only the owner uploads, only images, everyone in the workspace sees it, reset removes it", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
    await assert.rejects(saveLogo(h.ctx, s.agent, png), (e: { status?: number }) => e.status === 403);
    await assert.rejects(saveLogo(h.ctx, s.owner, Buffer.from("<svg/>").toString("base64")), (e: { status?: number }) => e.status === 400);
    await assert.rejects(saveLogo(h.ctx, s.owner, Buffer.alloc(300_001, 0xff).toString("base64")), (e: { status?: number }) => e.status === 413);

    await saveLogo(h.ctx, s.owner, png);
    assert.equal((await getLogo(h.ctx, s.viewer))?.type, "image/png");
    assert.equal(await getLogo(h.ctx, other.owner), null, "another workspace has no logo");
    assert.ok(await logoVersion(h.ctx, s.viewer));

    await deleteLogo(h.ctx, s.owner);
    assert.equal(await getLogo(h.ctx, s.owner), null);
    await saveLogo(h.ctx, s.owner, png);
    await saveDesign(h.ctx, s.owner, { colors: { accent: "#6d33d6" }, fonts: {} });
    await resetDesign(h.ctx, s.owner);
    assert.equal(await getLogo(h.ctx, s.owner), null, "back to standard removes the logo too");
    assert.equal(await workspaceTheme(h.ctx, s.owner), null);
  });

  it("HTTP: preview returns page CSS without saving, design.md downloads as template or current look", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const app = await buildServer(h.ctx);
    try {
      const login = await app.inject({ method: "POST", url: "/api/login", headers: { "x-supportx-request": "1" }, payload: { email: s.agentEmail.replace("agent@", "owner@"), password: "test-passwort-123" } });
      const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-supportx-request": "1" };
      const base = `/api/w/${s.workspaceId}`;

      const template = await app.inject({ method: "GET", url: `${base}/design.md`, headers });
      assert.equal(template.statusCode, 200);
      assert.match(String(template.headers["content-disposition"]), /DESIGN-Vorlage\.md/);

      const preview = await app.inject({ method: "POST", url: `${base}/design/preview`, headers, payload: { text: template.body.replace('"accent": "#d52b1e"', '"accent": "#1a4d8f"') } });
      const reading = preview.json() as { css: string; theme: Record<string, unknown> };
      assert.match(reading.css, /--signal:#1a4d8f/);
      assert.equal(await workspaceTheme(h.ctx, s.owner), null, "a preview saves nothing");

      assert.equal((await app.inject({ method: "PUT", url: `${base}/design`, headers, payload: reading.theme })).statusCode, 200);
      const current = await app.inject({ method: "GET", url: `${base}/design.md`, headers });
      assert.match(String(current.headers["content-disposition"]), /"DESIGN\.md"/);
      assert.match(current.body, /"accent": "#1a4d8f"/);

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
      assert.equal((await app.inject({ method: "PUT", url: `${base}/logo`, headers, payload: { base64: png.toString("base64") } })).statusCode, 200);
      const theme = (await app.inject({ method: "GET", url: `${base}/theme`, headers })).json() as { logoUrl: string };
      const logo = await app.inject({ method: "GET", url: theme.logoUrl, headers: { cookie: headers.cookie } });
      assert.equal(logo.statusCode, 200);
      assert.equal(logo.headers["content-type"], "image/png");
      assert.equal(logo.headers["x-content-type-options"], "nosniff");
      assert.deepEqual(logo.rawPayload, png);
    } finally {
      await app.close();
    }
  });
});
