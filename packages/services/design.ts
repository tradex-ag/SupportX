import { checkTheme, readDesignMd, workspaceThemeSchema, type DesignReading, type WorkspaceTheme } from "../core/design-md.ts";
import { one } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

const MAX_CHARS = 200_000;

/** Reads an uploaded DESIGN.md and shows what would be taken over. Nothing is saved yet. */
export function previewDesign(actor: Actor, text: string): DesignReading {
  requireRole(actor, ["owner"]);
  if (text.length > MAX_CHARS) throw new ServiceError(413, "TOO_LARGE", "Die Datei ist zu groß (höchstens 200 KB).");
  if (text.includes("\u0000")) throw new ServiceError(400, "INVALID", "Das ist keine Textdatei. Bitte eine .md-Datei hochladen.");
  return readDesignMd(text);
}

/** Saves the look for this workspace. The values are checked again on the server. */
export async function saveDesign(ctx: AppContext, actor: Actor, input: unknown): Promise<{ theme: WorkspaceTheme; warnings: string[] }> {
  requireRole(actor, ["owner"]);
  const parsed = workspaceThemeSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID", "Ungültige Designwerte.");
  const { theme, warnings } = checkTheme(parsed.data);
  await ctx.db.query("UPDATE workspaces SET theme = $2 WHERE id = $1", [actor.workspaceId, JSON.stringify(theme)]);
  await audit(ctx.db, actor, "design.saved", "workspace", actor.workspaceId, { fields: Object.keys(theme.colors).length });
  return { theme, warnings };
}

/** Back to the standard look: own colours, fonts, name and logo are removed. */
export async function resetDesign(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await ctx.db.query("UPDATE workspaces SET theme = NULL, logo = NULL, logo_type = NULL, logo_updated_at = NULL WHERE id = $1", [actor.workspaceId]);
  await audit(ctx.db, actor, "design.reset", "workspace", actor.workspaceId);
}

export async function workspaceTheme(ctx: AppContext, actor: Actor): Promise<WorkspaceTheme | null> {
  const row = await one<{ theme: unknown }>(ctx.db, "SELECT theme FROM workspaces WHERE id = $1", [actor.workspaceId]);
  if (!row?.theme) return null;
  const parsed = workspaceThemeSchema.safeParse(row.theme);
  return parsed.success ? parsed.data : null;
}

export const MAX_LOGO_BYTES = 300_000;

/** The type comes from the file's first bytes, never from the name or the browser. SVG is refused (it can carry script). */
export function logoType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export async function saveLogo(ctx: AppContext, actor: Actor, base64: string): Promise<{ updatedAt: string }> {
  requireRole(actor, ["owner"]);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new ServiceError(400, "INVALID", "Die Datei ist leer.");
  if (bytes.length > MAX_LOGO_BYTES) throw new ServiceError(413, "TOO_LARGE", "Das Logo ist zu groß (höchstens 300 KB).");
  const type = logoType(bytes);
  if (!type) throw new ServiceError(400, "INVALID", "Bitte ein Logo als PNG, JPG oder WebP hochladen.");
  const row = await one<{ logo_updated_at: Date }>(ctx.db, "UPDATE workspaces SET logo = $2, logo_type = $3, logo_updated_at = now() WHERE id = $1 RETURNING logo_updated_at", [actor.workspaceId, bytes, type]);
  await audit(ctx.db, actor, "design.logo_saved", "workspace", actor.workspaceId, { type, bytes: bytes.length });
  return { updatedAt: row!.logo_updated_at.toISOString() };
}

export async function deleteLogo(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await ctx.db.query("UPDATE workspaces SET logo = NULL, logo_type = NULL, logo_updated_at = NULL WHERE id = $1", [actor.workspaceId]);
  await audit(ctx.db, actor, "design.logo_removed", "workspace", actor.workspaceId);
}

/** When the workspace has its own logo: its version stamp (for the image URL), else null. */
export async function logoVersion(ctx: AppContext, actor: Actor): Promise<string | null> {
  const row = await one<{ logo_updated_at: Date | null }>(ctx.db, "SELECT logo_updated_at FROM workspaces WHERE id = $1 AND logo IS NOT NULL", [actor.workspaceId]);
  return row?.logo_updated_at ? String(row.logo_updated_at.getTime()) : null;
}

export async function getLogo(ctx: AppContext, actor: Actor): Promise<{ bytes: Buffer; type: string } | null> {
  const row = await one<{ logo: Buffer | null; logo_type: string | null }>(ctx.db, "SELECT logo, logo_type FROM workspaces WHERE id = $1", [actor.workspaceId]);
  return row?.logo && row.logo_type ? { bytes: row.logo, type: row.logo_type } : null;
}
