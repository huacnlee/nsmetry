/**
 * How each of the five headline metrics reads: its label, how a value is written, and which way is
 * better (a falling bounce rate is good news, so its delta is green when it goes down). The units
 * are the contract's: `bounce` is already a percentage (0..100), `time` is seconds per visit, `vpv`
 * views per visit.
 */
import type { Granularity, Metric } from "../../api";
import { formatCount, formatDuration, formatPercent } from "../../format";

export interface MetricMeta {
  label: string;
  format: (value: number) => string;
  better: "up" | "down";
}

export const metricMeta: Record<Metric, MetricMeta> = {
  visitors: { label: "Visitors", format: formatCount, better: "up" },
  views: { label: "Views", format: formatCount, better: "up" },
  vpv: { label: "Views per visit", format: (v) => (Number.isFinite(v) ? v.toFixed(2) : "–"), better: "up" },
  bounce: { label: "Bounce rate", format: (v) => formatPercent(v, true), better: "down" },
  time: { label: "Visit duration", format: formatDuration, better: "up" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A series label as people read it. The server labels buckets in UTC: `YYYY-MM-DDTHH` for hours,
 * `YYYY-MM-DD` for days and weeks (a week by its first day), `YYYY-MM` for months.
 */
export function bucketLabel(label: string, granularity?: Granularity): string {
  const hour = /^\d{4}-\d{2}-\d{2}T(\d{2})/.exec(label);
  if (hour) return `${hour[1]}:00`;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (day) return `${MONTHS[Number(day[2]) - 1] ?? day[2]} ${Number(day[3])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(label);
  if (month) return granularity === "month" ? `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1].slice(2)}` : label;
  return label;
}

/** Seconds since the Unix epoch → "now", "45s ago", "3m ago", "2h ago" (the live feed's times). */
export function relativeTime(tsSeconds: number, nowMs: number): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - tsSeconds));
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
