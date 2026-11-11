import { createHash } from "node:crypto";
import { fetchEbayPublicKey, parseEbayDeletionNotice, parseEbaySignatureHeader, verifyEbaySignature, type EbayPublicKey } from "../connectors/ebay/account-deletion.ts";
import { many, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { ebayApp, parseSecret, type ChannelConnectionRow, type EbaySecret } from "./connections.ts";
import type { AppContext } from "./context.ts";

const keyCache = new Map<string, { key: EbayPublicKey; until: number }>();

async function publicKey(ctx: AppContext, kid: string, fetchImpl?: typeof fetch): Promise<EbayPublicKey | null> {
  const cached = keyCache.get(kid);
  if (cached && cached.until > Date.now()) return cached.key;
  // Any eBay keyset of this installation may fetch the key; production first.
  const rows = await many<ChannelConnectionRow>(ctx.db, "SELECT * FROM channel_connections WHERE kind = 'ebay_messages' AND secret_id IS NOT NULL ORDER BY (config->>'sandbox')::boolean IS TRUE, created_at");
  for (const row of rows) {
    try {
      const secret = parseSecret<EbaySecret>(await ctx.secrets.read(ctx.db, row.workspace_id, row.secret_id!), "eBay");
      const key = await fetchEbayPublicKey({ ...ebayApp(row, secret.clientSecret), fetchImpl }, kid);
      keyCache.set(kid, { key, until: Date.now() + 60 * 60_000 });
      return key;
    } catch {
      // try the next keyset
    }
  }
  return null;
}

export type DeletionOutcome = { status: 204; deletedCases: number } | { status: 412 | 400 | 503; reason: string };

/**
 * Handles one eBay account deletion notice: verifies the signature and then removes
 * every case of that eBay user from all workspaces (messages, drafts, sends included).
 */
export async function handleEbayAccountDeletion(ctx: AppContext, rawBody: string, signatureHeader: string | undefined, fetchImpl?: typeof fetch): Promise<DeletionOutcome> {
  const header = parseEbaySignatureHeader(signatureHeader);
  if (!header) return { status: 412, reason: "Signatur fehlt oder ist unlesbar." };
  const key = await publicKey(ctx, header.kid, fetchImpl);
  // Without a key eBay must try again later, so this is not acknowledged.
  if (!key) return { status: 503, reason: "Öffentlicher eBay-Schlüssel nicht abrufbar." };
  if (!verifyEbaySignature(rawBody, header, key)) return { status: 412, reason: "Signatur ungültig." };
  const notice = parseEbayDeletionNotice(rawBody);
  if (!notice) return { status: 400, reason: "Keine Kontolöschung." };
  const names = [notice.username, notice.userId].filter((v): v is string => !!v).map((v) => `ebay:${v.toLowerCase()}`);
  if (!names.length) return { status: 204, deletedCases: 0 };
  const userHash = createHash("sha256").update(names.join("|")).digest("hex").slice(0, 16);
  return withTx(ctx.db, async (tx) => {
    const cases = await many<{ id: string; workspace_id: string }>(
      tx,
      `SELECT DISTINCT c.id, c.workspace_id FROM conversations c JOIN channel_connections k ON k.workspace_id = c.workspace_id AND k.id = c.connection_id
       WHERE k.kind = 'ebay_messages'
         AND (lower(c.customer_address) = ANY($1::text[])
           OR EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND lower(m.from_address) = ANY($1::text[])))`,
      [names],
    );
    const byWorkspace = new Map<string, string[]>();
    for (const c of cases) byWorkspace.set(c.workspace_id, [...(byWorkspace.get(c.workspace_id) ?? []), c.id]);
    for (const [ws, ids] of byWorkspace) {
      await tx.query("DELETE FROM jobs WHERE workspace_id = $1 AND payload->>'conversationId' = ANY($2::text[])", [ws, ids]);
      await tx.query("DELETE FROM message_forwards WHERE workspace_id = $1 AND conversation_id = ANY($2::uuid[])", [ws, ids]);
      await tx.query("DELETE FROM outbox WHERE workspace_id = $1 AND conversation_id = ANY($2::uuid[])", [ws, ids]);
      await tx.query("DELETE FROM conversations WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [ws, ids]);
      // The audit keeps only a hash, never the eBay name.
      await audit(tx, { type: "system", workspaceId: ws }, "ebay.account_deleted", "conversation", null, { userHash, notificationId: notice.notificationId, deletedCases: ids.length });
    }
    return { status: 204 as const, deletedCases: cases.length };
  });
}
