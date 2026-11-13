import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { actorFor, login } from "../../packages/services/auth.ts";
import { addTeamMember, listTeam, removeTeamMember, setTeamPassword, setTeamRole } from "../../packages/services/team.ts";
import { listRefunds } from "../../packages/services/refunds.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";
import { addNote } from "../../packages/services/cases.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("Team", () => {
  it("lets an owner add a colleague who can log in with the start password and work in this workspace only", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");

    // Only owners manage the team.
    await assert.rejects(listTeam(h.ctx, s.agent), { status: 403 });
    await assert.rejects(addTeamMember(h.ctx, s.viewer, { email: "x@example.invalid", displayName: "X", role: "agent", password: "start-passwort-1" }), { status: 403 });

    await assert.rejects(addTeamMember(h.ctx, s.owner, { email: "kein-mail", displayName: "Maria", role: "agent", password: "start-passwort-1" }), { status: 400 });
    await assert.rejects(addTeamMember(h.ctx, s.owner, { email: "maria@example.invalid", displayName: "Maria", role: "agent", password: "kurz" }), { status: 400 });
    const added = await addTeamMember(h.ctx, s.owner, { email: " Maria@Example.invalid ", displayName: "Maria", role: "agent", password: "start-passwort-1" });
    assert.equal(added.existingLogin, false);
    await assert.rejects(addTeamMember(h.ctx, s.owner, { email: "maria@example.invalid", displayName: "Maria", role: "viewer", password: "start-passwort-1" }), { status: 409 });

    const team = await listTeam(h.ctx, s.owner);
    const maria = team.find((m) => m.email === "maria@example.invalid")!;
    assert.equal(maria.role, "agent");
    assert.ok(!("password_hash" in maria) && !("passwordHash" in maria), "no password in the list");
    assert.equal(team.find((m) => m.userId === s.ownerUserId)!.isMe, true);

    const session = await login(h.ctx.db, "maria@example.invalid", "start-passwort-1");
    const mariaActor = await actorFor(h.ctx.db, session.userId, s.workspaceId);
    assert.equal((mariaActor as { role: string }).role, "agent");
    await listRefunds(h.ctx, mariaActor, "open");
    await assert.rejects(actorFor(h.ctx.db, session.userId, other.workspaceId), { status: 404 });

    // The other workspace's owner cannot see or touch her.
    assert.equal((await listTeam(h.ctx, other.owner)).some((m) => m.userId === added.userId), false);
    await assert.rejects(setTeamRole(h.ctx, other.owner, added.userId, "owner"), { status: 404 });
    await assert.rejects(setTeamPassword(h.ctx, other.owner, added.userId, "fremdes-passwort-1"), { status: 404 });
    await assert.rejects(removeTeamMember(h.ctx, other.owner, added.userId), { status: 404 });

    // Role change and a new password, which ends her sessions.
    await setTeamRole(h.ctx, s.owner, added.userId, "viewer");
    assert.equal(((await actorFor(h.ctx.db, session.userId, s.workspaceId)) as { role: string }).role, "viewer");
    await setTeamPassword(h.ctx, s.owner, added.userId, "neues-passwort-22");
    const sessions = await h.ctx.db.query("SELECT 1 FROM user_sessions WHERE user_id = $1", [added.userId]);
    assert.equal(sessions.rowCount, 0);
    await assert.rejects(login(h.ctx.db, "maria@example.invalid", "start-passwort-1"), { status: 401 });
    await login(h.ctx.db, "maria@example.invalid", "neues-passwort-22");

    const audits = await h.ctx.db.query<{ action: string; details: unknown }>("SELECT action, details FROM audit_events WHERE workspace_id = $1 AND action LIKE 'team.%' ORDER BY id", [s.workspaceId]);
    assert.deepEqual(audits.rows.map((r) => r.action), ["team.member_added", "team.role_changed", "team.password_set"]);
    assert.ok(!JSON.stringify(audits.rows).includes("passwort"), "no password in the audit log");

    // Removal locks her out; adding her again starts with a fresh password.
    const removed = await removeTeamMember(h.ctx, s.owner, added.userId);
    assert.equal(removed.loginDeleted, true);
    await assert.rejects(login(h.ctx.db, "maria@example.invalid", "neues-passwort-22"), { status: 401 });
    const again = await addTeamMember(h.ctx, s.owner, { email: "maria@example.invalid", displayName: "Maria", role: "agent", password: "wieder-da-passwort" });
    assert.equal(again.existingLogin, false);
    await login(h.ctx.db, "maria@example.invalid", "wieder-da-passwort");
  });

  it("keeps a shared login's password with its owner and always keeps one owner", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");

    // The agent of the other workspace joins here: own password stays, the start password is ignored.
    const shared = await addTeamMember(h.ctx, s.owner, { email: "agent@anderer-h-ndler.example.invalid", displayName: "Gast", role: "viewer", password: "wird-ignoriert-1" });
    assert.equal(shared.existingLogin, true);
    await assert.rejects(login(h.ctx.db, "agent@anderer-h-ndler.example.invalid", "wird-ignoriert-1"), { status: 401 });
    await login(h.ctx.db, "agent@anderer-h-ndler.example.invalid", "test-passwort-123");
    assert.equal((await listTeam(h.ctx, s.owner)).find((m) => m.userId === shared.userId)!.otherWorkspaces, true);
    await assert.rejects(setTeamPassword(h.ctx, s.owner, shared.userId, "uebernahme-pw-1"), { status: 409 });

    // Removing a shared login only ends access here.
    const r = await removeTeamMember(h.ctx, s.owner, shared.userId);
    assert.equal(r.loginDeleted, false);
    await login(h.ctx.db, "agent@anderer-h-ndler.example.invalid", "test-passwort-123");
    assert.equal(((await actorFor(h.ctx.db, shared.userId, other.workspaceId)) as { role: string }).role, "agent");

    // Owners cannot demote or remove themselves, and the last owner stays.
    const ownerUserId = s.ownerUserId;
    await assert.rejects(setTeamRole(h.ctx, s.owner, ownerUserId, "agent"), { status: 409 });
    await assert.rejects(removeTeamMember(h.ctx, s.owner, ownerUserId), { status: 409 });
    const agentId = (s.agent as { userId: string }).userId;
    await setTeamRole(h.ctx, s.owner, agentId, "owner");
    const second = { type: "user" as const, userId: agentId, workspaceId: s.workspaceId, role: "owner" as const };
    await setTeamRole(h.ctx, second, ownerUserId, "agent");
    const now = { type: "user" as const, userId: ownerUserId, workspaceId: s.workspaceId, role: "agent" as const };
    await assert.rejects(listTeam(h.ctx, now), { status: 403 });
    assert.equal((await listTeam(h.ctx, second)).filter((m) => m.role === "owner").length, 1);
  });

  it("keeps the history of a removed colleague and disables the login", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const agentId = (s.agent as { userId: string }).userId;
    await addNote(h.ctx, s.agent, conv.id, "Kunde angerufen");
    await login(h.ctx.db, s.agentEmail, "test-passwort-123");

    const r = await removeTeamMember(h.ctx, s.owner, agentId);
    assert.equal(r.loginDeleted, false, "the note still points at the user");
    await assert.rejects(login(h.ctx.db, s.agentEmail, "test-passwort-123"), { status: 401 });
    assert.equal((await h.ctx.db.query("SELECT 1 FROM user_sessions WHERE user_id = $1", [agentId])).rowCount, 0);
    assert.equal((await h.ctx.db.query("SELECT 1 FROM internal_notes WHERE author_user_id = $1", [agentId])).rowCount, 1);

    // Added again later: same person, fresh start password.
    const again = await addTeamMember(h.ctx, s.owner, { email: s.agentEmail, displayName: "Wieder da", role: "agent", password: "neuer-start-pw-1" });
    assert.equal(again.userId, agentId);
    assert.equal(again.existingLogin, false);
    await login(h.ctx.db, s.agentEmail, "neuer-start-pw-1");
  });
});
