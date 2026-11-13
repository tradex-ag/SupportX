import { many, one, withTx, type Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { createUser, hashPassword } from "./auth.ts";
import { requireRole, ServiceError, type Actor, type AppContext, type Role } from "./context.ts";

/**
 * Team of a workspace: owners add colleagues with a role and a start password,
 * change roles, set a new password and remove people. Passwords are only ever
 * stored as hashes and never returned.
 *
 * A user can belong to several workspaces (e.g. a service provider). An owner
 * here may therefore only set a password for someone who belongs to no other
 * workspace; otherwise one customer could take over a login used elsewhere.
 */
export interface TeamMember { userId: string; email: string; displayName: string; role: Role; isMe: boolean; otherWorkspaces: boolean; activeSessions: number }

const ROLES: ReadonlyArray<Role> = ["owner", "agent", "viewer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ownerOnly(actor: Actor): string {
  requireRole(actor, ["owner"]);
  if (actor.type !== "user") throw new ServiceError(403, "FORBIDDEN", "Nur Inhaber können das Team bearbeiten.");
  return actor.userId;
}

function checkRole(role: string): Role {
  if (!ROLES.includes(role as Role)) throw new ServiceError(400, "BAD_ROLE", "Unbekannte Rolle.");
  return role as Role;
}

export async function listTeam(ctx: AppContext, actor: Actor): Promise<TeamMember[]> {
  const me = ownerOnly(actor);
  const rows = await many<{ user_id: string; email: string; display_name: string; role: Role; other: boolean; sessions: number }>(
    ctx.db,
    `SELECT u.id AS user_id, u.email, u.display_name, m.role,
            EXISTS (SELECT 1 FROM memberships o WHERE o.user_id = u.id AND o.workspace_id <> m.workspace_id) AS other,
            (SELECT count(*)::int FROM user_sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, u.display_name`,
    [actor.workspaceId],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, isMe: r.user_id === me, otherWorkspaces: r.other, activeSessions: r.sessions }));
}

/**
 * Adds a colleague. A new login gets the start password the owner typed; an
 * email that already has a login elsewhere joins with its own password (the
 * start password is ignored and nothing about the other workspace is revealed
 * beyond "already has a login").
 */
export async function addTeamMember(ctx: AppContext, actor: Actor, input: { email: string; displayName: string; role: string; password: string }): Promise<{ userId: string; existingLogin: boolean }> {
  ownerOnly(actor);
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const role = checkRole(input.role);
  if (!EMAIL.test(email) || email.length > 320) throw new ServiceError(400, "BAD_EMAIL", "Bitte eine gültige E-Mail-Adresse eintragen.");
  if (!displayName || displayName.length > 200) throw new ServiceError(400, "BAD_NAME", "Bitte einen Namen eintragen.");
  return withTx(ctx.db, async (tx) => {
    const found = await one<{ id: string; memberships: number }>(tx, "SELECT u.id, (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id) AS memberships FROM users u WHERE u.email = $1 FOR UPDATE", [email]);
    if (found) {
      const member = await one(tx, "SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [actor.workspaceId, found.id]);
      if (member) throw new ServiceError(409, "ALREADY_MEMBER", "Diese Person ist schon im Team.");
    }
    // A login without any workspace (removed earlier) belongs to nobody: it starts again with the new password.
    const existingLogin = Boolean(found && found.memberships > 0);
    let userId: string;
    if (!found) userId = await createUser(tx, { email, displayName, password: input.password });
    else {
      userId = found.id;
      if (!existingLogin) await tx.query("UPDATE users SET password_hash = $2, display_name = $3 WHERE id = $1", [userId, await hashPassword(input.password), displayName]);
    }
    await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [actor.workspaceId, userId, role]);
    await audit(tx, actor, "team.member_added", "user", userId, { role, existingLogin });
    return { userId, existingLogin };
  });
}

async function memberRole(q: Queryable, workspaceId: string, userId: string): Promise<Role> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new ServiceError(404, "NOT_FOUND", "Diese Person ist nicht im Team.");
  const m = await one<{ role: Role }>(q, "SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE", [workspaceId, userId]);
  if (!m) throw new ServiceError(404, "NOT_FOUND", "Diese Person ist nicht im Team.");
  return m.role;
}

async function assertAnotherOwner(q: Queryable, workspaceId: string, userId: string): Promise<void> {
  const others = await one<{ n: number }>(q, "SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner' AND user_id <> $2", [workspaceId, userId]);
  if (!others || others.n === 0) throw new ServiceError(409, "LAST_OWNER", "Der Arbeitsbereich braucht mindestens einen Inhaber.");
}

export async function setTeamRole(ctx: AppContext, actor: Actor, userId: string, roleInput: string): Promise<void> {
  const me = ownerOnly(actor);
  const role = checkRole(roleInput);
  if (userId === me) throw new ServiceError(409, "OWN_ROLE", "Die eigene Rolle kann nur ein anderer Inhaber ändern.");
  await withTx(ctx.db, async (tx) => {
    const before = await memberRole(tx, actor.workspaceId, userId);
    if (before === role) return;
    if (before === "owner") await assertAnotherOwner(tx, actor.workspaceId, userId);
    await tx.query("UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [actor.workspaceId, userId, role]);
    await audit(tx, actor, "team.role_changed", "user", userId, { from: before, to: role });
  });
}

/** New password for a colleague who forgot it; all their sessions end. */
export async function setTeamPassword(ctx: AppContext, actor: Actor, userId: string, password: string): Promise<void> {
  const me = ownerOnly(actor);
  if (userId === me) throw new ServiceError(409, "OWN_PASSWORD", "Das eigene Passwort bitte unter „Mein Passwort“ ändern.");
  const hash = await hashPassword(password);
  await withTx(ctx.db, async (tx) => {
    await memberRole(tx, actor.workspaceId, userId);
    const other = await one(tx, "SELECT 1 FROM memberships WHERE user_id = $1 AND workspace_id <> $2 LIMIT 1", [userId, actor.workspaceId]);
    if (other) throw new ServiceError(409, "SHARED_LOGIN", "Diese Person nutzt den Login auch in einem anderen Arbeitsbereich. Das Passwort kann sie nur selbst ändern.");
    await tx.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, hash]);
    await tx.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
    await audit(tx, actor, "team.password_set", "user", userId);
  });
}

/**
 * Removes a colleague from this workspace. A login that belongs to no other
 * workspace is deleted with its sessions; a shared login only loses access here.
 */
export async function removeTeamMember(ctx: AppContext, actor: Actor, userId: string): Promise<{ loginDeleted: boolean }> {
  const me = ownerOnly(actor);
  if (userId === me) throw new ServiceError(409, "OWN_REMOVE", "Sich selbst kann man nicht entfernen.");
  return withTx(ctx.db, async (tx) => {
    const role = await memberRole(tx, actor.workspaceId, userId);
    if (role === "owner") await assertAnotherOwner(tx, actor.workspaceId, userId);
    await tx.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [actor.workspaceId, userId]);
    const other = await one(tx, "SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1", [userId]);
    let loginDeleted = false;
    if (!other) {
      loginDeleted = await deleteLoginIfUnreferenced(tx, userId);
    }
    await audit(tx, actor, "team.member_removed", "user", userId, { role, loginDeleted });
    return { loginDeleted };
  });
}

/**
 * Users are referenced by drafts, notes, approvals etc. If any such row keeps
 * the user, the login is disabled instead (sessions end, password unusable),
 * so history stays intact.
 */
async function deleteLoginIfUnreferenced(tx: Queryable, userId: string): Promise<boolean> {
  await tx.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
  await tx.query("SAVEPOINT team_delete_user");
  try {
    await tx.query("DELETE FROM users WHERE id = $1", [userId]);
    await tx.query("RELEASE SAVEPOINT team_delete_user");
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== "23503") throw err;
    await tx.query("ROLLBACK TO SAVEPOINT team_delete_user");
    await tx.query("UPDATE users SET password_hash = 'disabled' WHERE id = $1", [userId]);
    return false;
  }
}
