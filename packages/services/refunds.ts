import { groupRefunds, parseAmountInput, type RefundCandidate, type RefundListItem } from "../core/refund-list.ts";
import { many, withTx } from "../storage/db.ts";
import type { Queryable } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/**
 * Refund list ("Erstattungen"): cases with the outcome "Erstattet" or
 * "Teilweise erstattet", marketplace refund notices and cases a person added,
 * grouped per order (core/refund-list.ts). A person ticks off a refund once the
 * credit note is done in the ERP; SupportX itself never refunds and never
 * writes to the ERP.
 */
export type RefundFilter = "open" | "done" | "all";

const UUID = /^[0-9a-f-]{36}$/i;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

/** Bound on how far back the list looks; done refunds older than this drop off the list. */
const MAX_CANDIDATES = 2000;

async function candidates(db: Queryable, ws: string): Promise<RefundCandidate[]> {
  const rows = await many<Record<string, any>>(
    db,
    `SELECT c.id, c.subject, c.source_platform, c.customer_name, c.customer_address, c.outcome, c.outcome_note, c.outcome_at, c.last_message_at, c.order_references,
            ol.external_order_id,
            CASE WHEN ol.snapshot IS NULL THEN NULL ELSE jsonb_build_object(
              'orderNumber', ol.snapshot->'orderNumber', 'orderNumberAtCustomer', ol.snapshot->'orderNumberAtCustomer',
              'lines', coalesce(ol.snapshot->'lines', '[]'), 'invoices', coalesce(ol.snapshot->'invoices', '[]'), 'returns', ol.snapshot->'returns') END AS snapshot,
            e.id AS entry_id, e.added_manually, e.removed_at, e.amount_cents, e.currency, e.note, e.credit_note_number, e.done_at, e.updated_at AS entry_updated_at,
            du.display_name AS done_by_name
       FROM conversations c
       LEFT JOIN order_links ol ON ol.workspace_id = c.workspace_id AND ol.conversation_id = c.id AND ol.is_current AND ol.status = 'unique'
       LEFT JOIN refund_entries e ON e.workspace_id = c.workspace_id AND e.conversation_id = c.id
       LEFT JOIN users du ON du.id = e.done_by
      WHERE c.workspace_id = $1
        AND (c.outcome IN ('refund','partial_refund') OR e.id IS NOT NULL
          -- Prefilter for marketplace refund notices; core/refund-due.ts decides.
          OR c.subject ~* '(erstattung|refund|rembourse)')
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT ${MAX_CANDIDATES}`,
    [ws],
  );
  return rows.map((r) => ({
    conversationId: r.id,
    subject: r.subject,
    platform: r.source_platform,
    customerName: r.customer_name,
    customerAddress: r.customer_address,
    outcome: r.outcome,
    outcomeNote: r.outcome_note,
    outcomeAt: iso(r.outcome_at),
    lastMessageAt: iso(r.last_message_at),
    orderReferences: Array.isArray(r.order_references) ? r.order_references : [],
    externalOrderId: r.external_order_id,
    order: r.snapshot
      ? {
          ...(r.snapshot.orderNumber ? { orderNumber: r.snapshot.orderNumber } : {}),
          ...(r.snapshot.orderNumberAtCustomer ? { orderNumberAtCustomer: r.snapshot.orderNumberAtCustomer } : {}),
          lines: r.snapshot.lines,
          invoices: r.snapshot.invoices,
          ...(r.snapshot.returns ? { returns: r.snapshot.returns } : {}),
        }
      : null,
    entry: r.entry_id
      ? {
          addedManually: r.added_manually,
          removed: !!r.removed_at,
          amountCents: r.amount_cents,
          currency: r.currency,
          note: r.note,
          creditNoteNumber: r.credit_note_number,
          doneAt: iso(r.done_at),
          doneByName: r.done_by_name,
          updatedAt: iso(r.entry_updated_at),
        }
      : null,
  }));
}

export async function listRefunds(ctx: AppContext, actor: Actor, filter: RefundFilter): Promise<{ items: RefundListItem[]; counts: { open: number; done: number } }> {
  const all = groupRefunds(await candidates(ctx.db, actor.workspaceId));
  const counts = { open: all.filter((i) => !i.done).length, done: all.filter((i) => i.done).length };
  const items = filter === "all" ? all : all.filter((i) => (filter === "done" ? !!i.done : !i.done));
  return { items: items.slice(0, 500), counts };
}

/** Where one case stands on the refund list, for the case view. */
export async function caseRefundStatus(ctx: AppContext, ws: string, conversationId: string): Promise<{ state: "none" | "open" | "done"; item: RefundListItem | null; removed: boolean }> {
  const rows = await candidates(ctx.db, ws);
  const own = rows.find((r) => r.conversationId === conversationId);
  const item = groupRefunds(rows).find((i) => i.conversationIds.includes(conversationId)) ?? null;
  return { state: item ? (item.done ? "done" : "open") : "none", item, removed: !!own?.entry?.removed };
}

/** All ids must be cases of this workspace; otherwise nothing changes (same 404 for foreign and unknown). */
async function assertCases(db: Queryable, ws: string, ids: ReadonlyArray<string>): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > 50 || unique.some((id) => !UUID.test(id))) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  const found = await many<{ id: string }>(db, "SELECT id FROM conversations WHERE workspace_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [ws, unique]);
  if (found.length !== unique.length) throw new ServiceError(404, "NOT_FOUND", "Fall nicht gefunden.");
  return unique;
}

/** Creates the rows for the cases if missing, so a group can be ticked as a whole. */
async function ensureEntries(tx: Queryable, actor: Actor, ids: ReadonlyArray<string>): Promise<void> {
  await tx.query(
    `INSERT INTO refund_entries (workspace_id, conversation_id, created_by)
     SELECT $1, x, $3 FROM unnest($2::uuid[]) x
     ON CONFLICT (workspace_id, conversation_id) DO NOTHING`,
    [actor.workspaceId, ids, actorId(actor)],
  );
}

/**
 * Ticks a refund as done in the ERP (or takes the tick back). Applies to all
 * cases of the group, so the customer case and the marketplace notice agree.
 */
export async function setRefundDone(ctx: AppContext, actor: Actor, input: { conversationIds: string[]; done: boolean; creditNoteNumber?: string | null }): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  const creditNote = input.creditNoteNumber?.trim().slice(0, 100) || null;
  await withTx(ctx.db, async (tx) => {
    const ids = await assertCases(tx, actor.workspaceId, input.conversationIds);
    await ensureEntries(tx, actor, ids);
    if (input.done) {
      // Keep who ticked first when a case of the group was already done.
      await tx.query(
        `UPDATE refund_entries SET done_at = coalesce(done_at, now()), done_by = CASE WHEN done_at IS NULL THEN $3 ELSE done_by END,
                credit_note_number = coalesce($4, credit_note_number), removed_at = NULL, updated_at = now()
          WHERE workspace_id = $1 AND conversation_id = ANY($2::uuid[])`,
        [actor.workspaceId, ids, actorId(actor), creditNote],
      );
    } else {
      await tx.query("UPDATE refund_entries SET done_at = NULL, done_by = NULL, updated_at = now() WHERE workspace_id = $1 AND conversation_id = ANY($2::uuid[])", [actor.workspaceId, ids]);
    }
    await audit(tx, actor, input.done ? "refund.done" : "refund.reopened", "conversation", ids[0]!, { conversationIds: ids, ...(creditNote ? { creditNote } : {}) });
  });
}

/** Amount ("12,50"), note and credit note number for a refund, stored on all cases of the group. */
export async function setRefundDetails(ctx: AppContext, actor: Actor, input: { conversationIds: string[]; amount?: string | null; note?: string | null; creditNoteNumber?: string | null }): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  let amount: number | null | undefined;
  if (input.amount !== undefined) {
    amount = input.amount === null ? null : parseAmountInput(input.amount);
    if (amount === undefined) throw new ServiceError(400, "INVALID", "Betrag bitte als Zahl eingeben, z. B. 12,50.");
  }
  const note = input.note === undefined ? undefined : input.note?.trim().slice(0, 1000) || null;
  const creditNote = input.creditNoteNumber === undefined ? undefined : input.creditNoteNumber?.trim().slice(0, 100) || null;
  await withTx(ctx.db, async (tx) => {
    const ids = await assertCases(tx, actor.workspaceId, input.conversationIds);
    await ensureEntries(tx, actor, ids);
    await tx.query(
      `UPDATE refund_entries SET
         amount_cents = CASE WHEN $3 THEN $4::int ELSE amount_cents END,
         currency = CASE WHEN $3 THEN CASE WHEN $4::int IS NULL THEN NULL ELSE coalesce(currency, 'EUR') END ELSE currency END,
         note = CASE WHEN $5 THEN $6 ELSE note END,
         credit_note_number = CASE WHEN $7 THEN $8 ELSE credit_note_number END,
         updated_at = now()
       WHERE workspace_id = $1 AND conversation_id = ANY($2::uuid[])`,
      [actor.workspaceId, ids, amount !== undefined, amount ?? null, note !== undefined, note ?? null, creditNote !== undefined, creditNote ?? null],
    );
    await audit(tx, actor, "refund.details", "conversation", ids[0]!, { conversationIds: ids, ...(amount !== undefined ? { amountCents: amount } : {}) });
  });
}

/** Puts a case on the list by hand, or back after it was taken off. */
export async function addToRefundList(ctx: AppContext, actor: Actor, conversationId: string): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  await withTx(ctx.db, async (tx) => {
    const [id] = await assertCases(tx, actor.workspaceId, [conversationId]);
    await tx.query(
      `INSERT INTO refund_entries (workspace_id, conversation_id, added_manually, created_by) VALUES ($1, $2, true, $3)
       ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET added_manually = true, removed_at = NULL, updated_at = now()`,
      [actor.workspaceId, id, actorId(actor)],
    );
    await audit(tx, actor, "refund.added", "conversation", id!, {});
  });
}

/** Takes cases off the list (e.g. a notice that needs no credit note). */
export async function removeFromRefundList(ctx: AppContext, actor: Actor, conversationIds: string[]): Promise<void> {
  requireRole(actor, ["owner", "agent"]);
  await withTx(ctx.db, async (tx) => {
    const ids = await assertCases(tx, actor.workspaceId, conversationIds);
    await ensureEntries(tx, actor, ids);
    await tx.query("UPDATE refund_entries SET removed_at = now(), added_manually = false, updated_at = now() WHERE workspace_id = $1 AND conversation_id = ANY($2::uuid[])", [actor.workspaceId, ids]);
    await audit(tx, actor, "refund.removed", "conversation", ids[0]!, { conversationIds: ids });
  });
}
