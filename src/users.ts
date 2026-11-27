/**
 * Accounts and authorisation.
 *
 * Two roles, deliberately:
 *   owner  — the one administrator, named by ADMIN_EMAIL; sees every site
 *   viewer — invited by the administrator, read-only, and only for the sites
 *            granted in site_access
 *
 * The role is *derived*, not stored: `withRole` compares the account's email
 * with ADMIN_EMAIL each time an account is loaded. That is what lets the
 * deployment variable move admin rights, and it is how instances from the
 * password era carry over: every old "owner" whose email is not ADMIN_EMAIL
 * becomes a viewer with whatever explicit grants it had (often none, so it
 * sees nothing until the administrator grants sites). The `role` column stays
 * in the table but is only a record of what the account was last seen as.
 *
 * The password columns stay too — SQLite cannot drop a NOT NULL column without
 * rebuilding the table — and are written as '' for new accounts. Nothing reads
 * them any more.
 */

import { revokeUserSessionsStatement } from './sessions';
import type { SiteRow } from './stats';

export type Role = 'owner' | 'viewer';

export interface UserRow {
  id: number;
  email: string;
  /** Derived from ADMIN_EMAIL once the row has been through `withRole`. */
  role: Role;
  token_version: number;
  created_at: number;
}

/** What the apps are allowed to see about an account. */
export interface PublicUser {
  id: number;
  email: string;
  role: Role;
  created_at: number;
  siteIds: number[];
}

// Permissive on purpose: this is an identifier for a self-hosted tool, not a
// deliverability check. Whether the address works is proved by the code.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 254);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

const USER_COLUMNS = 'id, email, role, token_version, created_at';

/**
 * The account with its effective role. Every row that reaches an
 * authorisation decision must come through here — a raw row's `role` column
 * is history, not permission.
 */
export function withRole(user: UserRow, adminEmail: string): UserRow {
  return { ...user, role: adminEmail !== '' && user.email === adminEmail ? 'owner' : 'viewer' };
}

export function isOwner(user: UserRow): boolean {
  return user.role === 'owner';
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return row?.n ?? 0;
}

/** The raw row (role not yet derived). Pass it through `withRole`. */
export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

/** The raw row (role not yet derived). Pass it through `withRole`. */
export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).bind(email).first<UserRow>();
}

async function siteIdsByUser(db: D1Database): Promise<Map<number, number[]>> {
  const { results } = await db
    .prepare('SELECT user_id, site_id FROM site_access ORDER BY site_id')
    .all<{ user_id: number; site_id: number }>();

  const map = new Map<number, number[]>();
  for (const row of results) {
    const existing = map.get(row.user_id);
    if (existing) existing.push(row.site_id);
    else map.set(row.user_id, [row.site_id]);
  }
  return map;
}

/** Every account, the administrator first, then in the order they were invited. */
export async function listUsers(db: D1Database, adminEmail: string): Promise<PublicUser[]> {
  const [{ results }, grants] = await Promise.all([
    db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`).all<UserRow>(),
    siteIdsByUser(db),
  ]);

  return results
    .map((row) => withRole(row, adminEmail))
    .sort((a, b) => Number(isOwner(b)) - Number(isOwner(a)) || a.id - b.id)
    .map((user) => toPublicUser(user, grants.get(user.id) ?? []));
}

export function toPublicUser(user: UserRow, siteIds: number[]): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    siteIds,
  };
}

export async function siteIdsFor(db: D1Database, userId: number): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT site_id FROM site_access WHERE user_id = ? ORDER BY site_id')
    .bind(userId)
    .all<{ site_id: number }>();
  return results.map((row) => row.site_id);
}

/**
 * Invite a viewer. Returns null if the email already has an account — email
 * is UNIQUE, so the insert simply changes nothing.
 */
export async function createUser(
  db: D1Database,
  input: { email: string; siteIds: number[] },
): Promise<UserRow | null> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO users (email, password_hash, password_salt, role, created_at)
       VALUES (?, '', '', 'viewer', ?)`,
    )
    .bind(input.email, Math.floor(Date.now() / 1000))
    .run();
  if (inserted.meta.changes === 0) return null;

  const user = await getUserByEmail(db, input.email);
  if (user) await setSiteAccess(db, user.id, input.siteIds);
  return user;
}

/**
 * The administrator's account row, created on their first sign-in. The stored
 * role is set to match, and any other row still claiming 'owner' is set to
 * 'viewer' — cosmetic (the role is derived), but it keeps the table honest for
 * anyone reading it with `wrangler d1 execute`. Both UPDATEs touch zero rows,
 * and so cost zero writes, once things agree.
 */
export async function ensureAdminAccount(db: D1Database, email: string): Promise<UserRow | null> {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO users (email, password_hash, password_salt, role, created_at)
         VALUES (?, '', '', 'owner', ?)`,
      )
      .bind(email, Math.floor(Date.now() / 1000)),
    db.prepare("UPDATE users SET role = 'owner' WHERE email = ? AND role <> 'owner'").bind(email),
    db.prepare("UPDATE users SET role = 'viewer' WHERE email <> ? AND role = 'owner'").bind(email),
  ]);
  return getUserByEmail(db, email);
}

/**
 * Replace a user's grants. Ids that are not sites are dropped by the
 * INSERT … SELECT rather than stored as dangling grants.
 */
export async function setSiteAccess(db: D1Database, userId: number, siteIds: number[]): Promise<void> {
  const statements = [db.prepare('DELETE FROM site_access WHERE user_id = ?').bind(userId)];
  for (const siteId of siteIds) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO site_access (user_id, site_id) SELECT ?, id FROM sites WHERE id = ?')
        .bind(userId, siteId),
    );
  }
  await db.batch(statements);
}

/**
 * Remove an account and everything that lets it in: bearer sessions, OAuth
 * grants and pending OAuth codes, pending sign-in codes and site grants.
 *
 * The OAuth rows go for more than tidiness. `users.id` is a plain INTEGER
 * PRIMARY KEY, so SQLite may hand a deleted account's id to the next account
 * created — anything keyed only by user id would otherwise carry over.
 */
export async function deleteUser(db: D1Database, user: UserRow): Promise<void> {
  await db.batch([
    revokeUserSessionsStatement(db, user.id),
    db.prepare('DELETE FROM oauth_grants WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM auth_codes WHERE email = ?').bind(user.email),
    db.prepare('DELETE FROM site_access WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
}

/* ------------------------------------------------------------ authorisation */

/** Sites this user may look at. The administrator sees everything without grants. */
export async function accessibleSites(db: D1Database, user: UserRow): Promise<SiteRow[]> {
  if (isOwner(user)) {
    const { results } = await db
      .prepare('SELECT id, domain, created_at, keep_user_ids FROM sites ORDER BY domain')
      .all<SiteRow>();
    return results;
  }

  const { results } = await db
    .prepare(
      `SELECT s.id, s.domain, s.created_at, s.keep_user_ids
       FROM sites s
       JOIN site_access a ON a.site_id = s.id
       WHERE a.user_id = ?
       ORDER BY s.domain`,
    )
    .bind(user.id)
    .all<SiteRow>();
  return results;
}

export async function canAccessSite(db: D1Database, user: UserRow, siteId: number): Promise<boolean> {
  if (isOwner(user)) return true;
  const row = await db
    .prepare('SELECT 1 AS ok FROM site_access WHERE user_id = ? AND site_id = ?')
    .bind(user.id, siteId)
    .first<{ ok: number }>();
  return row !== null;
}
