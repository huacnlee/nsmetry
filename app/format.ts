/** Number formatting shared by every screen, so a count reads the same everywhere. */

/** 1234 → "1,234"; 12_345 → "12.3k"; 1_234_567 → "1.2M". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a < 10_000) return Math.round(n).toLocaleString("en-US");
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 0.4567 → "45.7%" (fractions), or 45.67 → "45.7%" with `alreadyPercent`. */
export function formatPercent(n: number, alreadyPercent = false): string {
  if (!Number.isFinite(n)) return "–";
  const v = alreadyPercent ? n : n * 100;
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** Seconds → "45s", "3m 20s", "1h 05m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Change from `prev` to `cur` as a fraction, or null when there is no meaningful base. */
export function change(cur: number, prev: number | null | undefined): number | null {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / prev;
}
