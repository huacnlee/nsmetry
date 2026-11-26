/**
 * Bearer sessions for the apps (web, desktop, mobile) and scripts.
 *
 * A token is 32 random bytes, handed out once at sign-in and stored only as
 * its SHA-256: a copy of the database is not a copy of anyone's sign-in. It
 * lives until it goes 90 days unused, until its holder signs out, or until the
 * administrator removes the account.
 *
 * Budget: one row written per sign-in, and `last_seen` rewritten at most once
 * an hour per token — not per request. An app polling the realtime panel every
 * few seconds would otherwise spend the whole daily write budget on
 * bookkeeping. An hour of slack on a 90-day idle limit changes nothing.
 *
 * Tokens are not cached in the isolate: revocation has to take effect on the
 * very next request, and the lookup is one primary-key read.
 */

import { randomHex, sha256Hex } from './auth';

export const SESSION_IDLE_SECONDS = 90 * 24 * 60 * 60;
export const SEEN_EVERY_SECONDS = 60 * 60;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** The token from an `Authorization: Bearer …` header, or ''. */
export function bearerToken(header: string | null | undefined): string {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1] ?? '';
}

/** Start a session and return the raw token — the only time it exists in the clear. */
export async function createSession(
  db: D1Database,
  userId: number,
  userAgent = '',
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen, ua)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(token), userId, now, now, userAgent.slice(0, 200))
    .run();
  return token;
}

/**
 * The user id a token belongs to, or null. An expired session is deleted on
 * sight, so the table does not need a sweeper.
 */
export async function resolveSession(
  db: D1Database,
  token: string,
  now = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = await sha256Hex(token);

  const row = await db
    .prepare('SELECT user_id, last_seen FROM sessions WHERE token_hash = ?')
    .bind(hash)
    .first<{ user_id: number; last_seen: number }>();
  if (!row) return null;

  if (now - row.last_seen > SESSION_IDLE_SECONDS) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  if (now - row.last_seen >= SEEN_EVERY_SECONDS) {
    await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(now, hash).run();
  }
  return row.user_id;
}

/** Sign one token out. Unknown tokens are not an error: the outcome is the same. */
export async function revokeSession(db: D1Database, token: string): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/** The statement that signs a user out everywhere, for batching with other deletes. */
export function revokeUserSessionsStatement(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId);
}
