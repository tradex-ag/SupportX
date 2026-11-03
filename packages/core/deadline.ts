/**
 * Reply deadlines per platform. Amazon expects an answer to a buyer message within
 * 24 hours, weekends and holidays included; other platforms are less strict. The
 * hours are the operator's choice per workspace (0 = no deadline). Pure, shared by
 * API and UI.
 */
export const DEADLINE_PLATFORMS = ["amazon", "ebay", "kaufland", "shop_apotheke", "docmorris", "shopify", "email"] as const;

export const DEFAULT_REPLY_DEADLINES: Readonly<Record<(typeof DEADLINE_PLATFORMS)[number], number>> = {
  amazon: 24,
  ebay: 48,
  kaufland: 48,
  shop_apotheke: 48,
  docmorris: 48,
  shopify: 48,
  email: 48,
};

export const MAX_DEADLINE_HOURS = 168;

export type DeadlineTone = "ok" | "warn" | "bad";

export interface DeadlineState {
  dueAt: Date;
  /** Negative when overdue. */
  remainingMs: number;
  tone: DeadlineTone;
  label: string;
}

const HOUR = 3_600_000;

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 6 && rest > 0) return `${hours} Std. ${rest} Min.`;
  if (hours < 48) return `${hours} Std.`;
  return `${Math.floor(hours / 24)} Tagen`;
}

/**
 * Red when overdue or less than 4 hours (at most a quarter of the window) are left,
 * yellow from half of the window on, green before.
 */
export function deadlineState(waitingSince: string | Date | null | undefined, hours: number | null | undefined, now: Date = new Date()): DeadlineState | null {
  if (!waitingSince || !hours || hours <= 0) return null;
  const since = waitingSince instanceof Date ? waitingSince : new Date(waitingSince);
  if (Number.isNaN(since.getTime())) return null;
  const dueAt = new Date(since.getTime() + hours * HOUR);
  const remainingMs = dueAt.getTime() - now.getTime();
  const redFrom = Math.min(4 * HOUR, (hours * HOUR) / 4);
  const tone: DeadlineTone = remainingMs <= redFrom ? "bad" : remainingMs <= (hours * HOUR) / 2 ? "warn" : "ok";
  const label = remainingMs <= 0 ? `seit ${span(-remainingMs)} überfällig` : `noch ${span(remainingMs).replace(/Tagen$/, "Tage")}`;
  return { dueAt, remainingMs, tone, label };
}

/** Validates the operator's input: whole hours 0..168 for known platforms only. */
export function normalizeDeadlines(input: unknown): Record<string, number> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(DEADLINE_PLATFORMS as readonly string[]).includes(key)) return null;
    const n = typeof value === "string" && value.trim() === "" ? 0 : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DEADLINE_HOURS) return null;
    out[key] = n;
  }
  return out;
}
