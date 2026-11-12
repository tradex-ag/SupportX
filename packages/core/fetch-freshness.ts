/**
 * How fresh a channel's last read is. Pure so the inbox, the settings card and
 * the server agree on when a connection counts as "not read for too long".
 */

/** Mirakl inbox reads triggered by an open inbox: at most this often per connection. */
export const DISPLAY_SYNC_MIN_SEC = 600;
/** A connection not read for this long is flagged in the inbox and on its card. */
export const STALE_AFTER_HOURS = 4;

export function isStale(lastSyncAt: string | Date | null | undefined, now: Date = new Date(), hours: number = STALE_AFTER_HOURS): boolean {
  if (!lastSyncAt) return true;
  const t = new Date(lastSyncAt).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > hours * 3_600_000;
}

/** "gerade eben", "vor 12 Min.", "vor 3 Std.", "vor 16 Tagen" — German, for one short line. */
export function sinceLabel(lastSyncAt: string | Date | null | undefined, now: Date = new Date()): string {
  if (!lastSyncAt) return "noch nie";
  const minutes = Math.floor((now.getTime() - new Date(lastSyncAt).getTime()) / 60_000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `vor ${hours} Std.`;
  return `vor ${Math.floor(hours / 24)} Tagen`;
}
