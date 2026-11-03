import { OWN_COPY_REASON } from "../core/category.ts";
import type { OrderLineFact } from "../core/contracts.ts";
import { many, one } from "../storage/db.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

export const REPORT_DAYS = [7, 30, 90] as const;
const PROBLEM_TOPICS = ["damaged_item", "wrong_item", "return_request"] as const;

/**
 * Evaluation over the last N days, from SupportX's own data (no AI, no outside calls):
 * cases per topic and platform, first reply time and deadline kept, what was done
 * afterwards, and which weclapp articles cause damage, wrong-item and return cases.
 */
export async function supportReport(ctx: AppContext, actor: Actor, days: number) {
  requireRole(actor, ["owner", "agent", "viewer"]);
  if (!(REPORT_DAYS as readonly number[]).includes(days)) throw new ServiceError(400, "INVALID", "Zeitraum: 7, 30 oder 90 Tage.");
  const ws = actor.workspaceId;
  const since = new Date(Date.now() - days * 86_400_000);

  // First customer message per case in the period, and our first answer after it
  // (sent from SupportX, or Amazon's copy of a reply written in Seller Central).
  const replies = await many<{ id: string; source_platform: string; topic: string | null; outcome: string | null; first_in: Date; first_out: Date | null; hours: number | null }>(
    ctx.db,
    `WITH firsts AS (
       SELECT c.id, c.source_platform, c.topic, c.outcome, c.customer_address, c.order_references, min(m.received_at) AS first_in
         FROM conversations c JOIN messages m ON m.workspace_id = c.workspace_id AND m.conversation_id = c.id
        WHERE c.workspace_id = $1 AND c.category = 'support' AND m.direction = 'inbound' AND m.kind = 'customer'
        GROUP BY c.id
       HAVING min(m.received_at) >= $2)
     SELECT f.id, f.source_platform, f.topic, f.outcome, f.first_in, x.first_out,
            (SELECT nullif((w.reply_deadlines->>f.source_platform)::int, 0) FROM workspaces w WHERE w.id = $1) AS hours
       FROM firsts f
       LEFT JOIN LATERAL (
         SELECT min(t) AS first_out FROM (
           SELECT o.received_at AS t FROM messages o WHERE o.workspace_id = $1 AND o.conversation_id = f.id AND o.direction = 'outbound' AND o.received_at > f.first_in
           UNION ALL
           SELECT om.received_at FROM conversations oc JOIN messages om ON om.workspace_id = oc.workspace_id AND om.conversation_id = oc.id
            WHERE oc.workspace_id = $1 AND oc.category_reason = $3 AND om.received_at > f.first_in
              AND ((f.customer_address IS NOT NULL AND oc.customer_address = f.customer_address)
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(oc.order_references) a, jsonb_array_elements(f.order_references) b WHERE a->>'value' = b->>'value'))
         ) t) x ON true`,
    [ws, since, OWN_COPY_REASON],
  );

  const tally = (key: (r: (typeof replies)[number]) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of replies) {
      const k = key(r);
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const answered = replies.filter((r) => r.first_out);
  const durations = answered.map((r) => (new Date(r.first_out!).getTime() - new Date(r.first_in).getTime()) / 3_600_000).sort((a, b) => a - b);
  // Only cases that are decided: answered, or their deadline is over.
  const withDeadline = replies.filter((r) => r.hours && (r.first_out || Date.now() - new Date(r.first_in).getTime() > r.hours * 3_600_000));
  const inTime = withDeadline.filter((r) => r.first_out && new Date(r.first_out).getTime() - new Date(r.first_in).getTime() <= r.hours! * 3_600_000).length;
  const overdueOpen = withDeadline.filter((r) => !r.first_out && Date.now() - new Date(r.first_in).getTime() > r.hours! * 3_600_000).length;

  // Problems per article: from the order matched to the case (weclapp snapshot).
  const problemRows = await many<{ topic: string; lines: OrderLineFact[] | null }>(
    ctx.db,
    `SELECT c.topic, l.snapshot->'lines' AS lines
       FROM conversations c JOIN order_links l ON l.workspace_id = c.workspace_id AND l.conversation_id = c.id AND l.is_current AND l.status = 'unique'
      WHERE c.workspace_id = $1 AND c.category = 'support' AND c.topic = ANY($2::text[]) AND c.created_at >= $3`,
    [ws, PROBLEM_TOPICS, since],
  );
  const articles = new Map<string, { article: string; number: string | null; total: number; byTopic: Record<string, number> }>();
  for (const row of problemRows) {
    const seen = new Set<string>();
    for (const line of row.lines ?? []) {
      const key = line.articleNumber || line.articleId || line.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const a = articles.get(key) ?? { article: line.articleName || line.title, number: line.articleNumber ?? null, total: 0, byTopic: {} };
      a.total += 1;
      a.byTopic[row.topic] = (a.byTopic[row.topic] ?? 0) + 1;
      articles.set(key, a);
    }
  }
  const unsorted = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM conversations WHERE workspace_id = $1 AND category = 'support' AND created_at >= $2 AND topic IS NULL", [ws, since]);

  return {
    days,
    since: since.toISOString(),
    cases: replies.length,
    byTopic: tally((r) => r.topic ?? "other"),
    byPlatform: tally((r) => r.source_platform),
    outcomes: tally((r) => r.outcome),
    firstReply: {
      answered: answered.length,
      medianHours: durations.length ? round1(median(durations)) : null,
      withDeadline: withDeadline.length,
      inTime,
      overdueOpen,
    },
    articles: [...articles.values()].sort((a, b) => b.total - a.total).slice(0, 20),
    unsorted: unsorted?.n ?? 0,
  };
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const round1 = (n: number) => Math.round(n * 10) / 10;
