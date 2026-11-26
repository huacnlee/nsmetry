/**
 * Turning the API's bucket labels into short axis text, shared by the Users and Events screens.
 *
 * The server labels a series by its bucket: `2026-11-20` (a day, or the Monday of a week),
 * `2026-11-20T14` (an hour of `today`) and `2026-11` (a month of `12mo`). Charts have room for about
 * six ticks, so each becomes the shortest text that still says which bucket it is.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-20" → "Nov 20"; "2026-11-20T14" → "14:00"; "2026-11" → "Nov 2026". Anything else unchanged. */
export function bucketLabel(label: string): string {
  const hour = /^\d{4}-\d{2}-\d{2}T(\d{2})$/.exec(label);
  if (hour) return `${hour[1]}:00`;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (day) return `${MONTHS[Number(day[2]) - 1] ?? day[2]} ${Number(day[3])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(label);
  if (month) return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]}`;
  return label;
}

/** The mean of a series, 0 for an empty one. */
export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
