/**
 * People: the raw user ids behind an app's uids, for sites that opted in.
 *
 * Off by default. A site's owner turns on keep_user_ids when the ids are
 * theirs to keep (their own accounts' emails, say) and they want to see who
 * actually uses the app. Ingest then upserts app_identities (src/ingest.ts
 * rememberPeople); nothing else changes — active users, retention and every
 * other report still count the uid pseudonym.
 */

/** The most rows one /api/people answer lists; `total` still counts them all. */
export const MAX_PEOPLE = 500;

export interface Person {
  user_id: string;
  first_seen: number;
  last_seen: number;
}

export interface PeopleReport {
  /** Whether the site keeps user ids at all. When false, `people` is empty. */
  enabled: boolean;
  days: number;
  /** People seen in the window, newest last_seen first, at most `limit`. */
  people: Person[];
  /** Everyone seen in the window. */
  total: number;
}

export async function siteKeepsUserIds(db: D1Database, siteId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT keep_user_ids FROM sites WHERE id = ?')
    .bind(siteId)
    .first<{ keep_user_ids: number }>();
  return row?.keep_user_ids === 1;
}

/**
 * Turn keeping user ids on or off. Off deletes every id the site kept, in the
 * same batch, so "off" means none are left.
 */
export async function setKeepUserIds(db: D1Database, siteId: number, enabled: boolean): Promise<void> {
  const statements = [
    db
      .prepare('UPDATE sites SET keep_user_ids = ? WHERE id = ? AND keep_user_ids <> ?')
      .bind(enabled ? 1 : 0, siteId, enabled ? 1 : 0),
  ];
  if (!enabled) statements.push(db.prepare('DELETE FROM app_identities WHERE site_id = ?').bind(siteId));
  await db.batch(statements);
}

/** People seen in the last `days` days. */
export async function loadPeople(
  db: D1Database,
  siteId: number,
  days: number,
  limit: number,
  now: number,
): Promise<PeopleReport> {
  const enabled = await siteKeepsUserIds(db, siteId);
  if (!enabled) return { enabled, days, people: [], total: 0 };
  const since = now - days * 86_400;
  const [list, count] = await db.batch([
    db
      .prepare(
        `SELECT user_id, first_seen, last_seen FROM app_identities
         WHERE site_id = ? AND last_seen >= ?
         ORDER BY last_seen DESC, user_id LIMIT ?`,
      )
      .bind(siteId, since, Math.min(Math.max(limit, 1), MAX_PEOPLE)),
    db.prepare('SELECT COUNT(*) AS n FROM app_identities WHERE site_id = ? AND last_seen >= ?').bind(siteId, since),
  ]);
  return {
    enabled,
    days,
    people: (list!.results as unknown as Person[]) ?? [],
    total: (count!.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/** `days` from a query string: 1 to 365, 30 when absent; null when invalid. */
export function parseDays(value: string | undefined): number | null {
  if (value === undefined || value === '') return 30;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}
