/**
 * Times for the account screens (Team, Agents): the server sends unix seconds. A list shows how long
 * ago ("3d ago"), which is what a reader scans for; a detail view shows the date as well.
 */

/** Unix seconds → "just now", "5m ago", "3h ago", "4d ago", then a date ("12 Mar 2026"). */
export function ago(seconds: number | null | undefined, now = Date.now()): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "Never";
  const diff = Math.max(0, Math.floor(now / 1000 - seconds));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)}d ago`;
  return day(seconds);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Unix seconds → "12 Mar 2026" (UTC: the instance counts days in UTC too). */
export function day(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "Never";
  const d = new Date(seconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
