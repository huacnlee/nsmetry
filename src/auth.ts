/**
 * Passwordless sign-in: a one-time code sent by email, exchanged for a bearer
 * token.
 *
 * There are no passwords anywhere. One administrator is named at deploy time
 * by the ADMIN_EMAIL variable; everyone else is a viewer the administrator
 * invited. Whether an account is the administrator is decided by comparing its
 * email with ADMIN_EMAIL on every request — never by a stored role — so editing
 * the variable and redeploying moves admin rights without touching the data.
 *
 * The flow is modelled on noop's (cloud/src/authcode.ts and the /api/auth/*
 * handlers): an 8-digit code (digits only, so phones bring up the number pad
 * and the app's one-time-code cells take it), stored only as a hash, valid for ten minutes, five tries per code, caps on mails per
 * hour and a cap on wrong guesses per UTC day.
 *
 * The caps are keyed by the caller's IP (and, for mails, also by address),
 * never instance-wide. /api/auth/start is public and the administrator's
 * address is easy to guess, so a global cap would let any stranger lock the
 * one real user out for the day; keyed per IP, a stranger only locks out
 * themselves. Guessing stays hopeless regardless: every code allows five
 * tries, spent atomically before the comparison, against 10^8 possibilities.
 *
 * Everything here is shaped by the free plan's 100k rows written per day: a
 * sign-in costs a handful of writes (the code row, the send counter, the
 * session row), and the hot path — resolving a bearer token — writes at most
 * once an hour per token (see sessions.ts).
 */

import { signInCodeMail } from './codemail';
import { type Delivery, deliverMail } from './mail';
import { createSession } from './sessions';
import {
  type PublicUser,
  type UserRow,
  ensureAdminAccount,
  getUserByEmail,
  isValidEmail,
  normalizeEmail,
  siteIdsFor,
  toPublicUser,
  withRole,
} from './users';

const encoder = new TextEncoder();

/* ------------------------------------------------------------ primitives -- */

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

/**
 * Constant-time comparison of two strings of the same length (hex digests
 * here). The length is not secret — every digest is 64 characters — so an
 * early return on a mismatch leaks nothing.
 */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/* ----------------------------------------------------------------- codes -- */

// Eight digits: 10^8 codes. Each allows five tries, a new one takes a minute and
// an address gets at most 30 an hour, so even an attacker with many IPs makes
// at most ~3,600 guesses a day at one address: odds of about 1 in 28,000.
export const CODE_ALPHABET = '0123456789';
export const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Unbiased: bytes ≥ 250 (= 25 × 10) are redrawn rather than folded. */
export function newCode(): string {
  let code = '';
  const byte = new Uint8Array(1);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(byte);
    if (byte[0]! < 250) code += CODE_ALPHABET[byte[0]! % 10];
  }
  return code;
}

/** What someone typed → the canonical code: case-insensitive, spaces and dashes ignored. */
export function normalizeCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
}

/**
 * The code is bound to the email it was sent to, so a code read out of one
 * mailbox cannot sign in as anyone else.
 */
export function codeHash(email: string, code: string): Promise<string> {
  return sha256Hex(`${email}:${code}`);
}

export const CODE_TTL_SECONDS = 10 * 60;
export const CODE_TRIES = 5;
export const RESEND_SECONDS = 60;
/**
 * Mails per hour asked for from one IP. One person and a few invitees sign in
 * rarely; the cap exists so the public /api/auth/start cannot be turned into a
 * way to spam a mailbox or burn the SMTP account from one machine.
 */
export const SENDS_PER_HOUR = 10;
/**
 * Mails per hour to one address, whoever asks: bounds how hard a mailbox can be
 * flooded from many IPs. Reaching it takes several IPs and only delays that
 * address's next code to the next hour; it is never a way in.
 */
export const SENDS_PER_EMAIL_HOUR = 30;
/** Wrong guesses per UTC day from one IP, across every code and email. */
export const FAILS_PER_DAY = 20;

/* ------------------------------------------------------------ deployment -- */

/**
 * The variables this module reads.
 *
 * Read through a cast rather than from the generated `Env` because they are all
 * optional to a deployment (EMAIL and SMTP do not exist until someone sets them
 * up), and the generated types only know what wrangler.jsonc happens to list.
 */
export interface AuthEnv {
  ADMIN_EMAIL?: string;
  /** Secret, JSON: { host, port, secure, user, pass, from }. */
  SMTP?: string;
  /** Cloudflare Email Sending binding (`send_email`). */
  EMAIL?: SendEmail;
  /** The sender for EMAIL, on a domain onboarded to Email Sending. */
  MAIL_FROM?: string;
}

export function authEnv(env: Env): AuthEnv {
  return env as unknown as AuthEnv;
}

/** The administrator's email, normalised, or '' before ADMIN_EMAIL is set. */
export function adminEmail(env: Env): string {
  return normalizeEmail(authEnv(env).ADMIN_EMAIL ?? '');
}

export const ADMIN_EMAIL_MISSING =
  'This instance has no administrator yet. Set the ADMIN_EMAIL variable to your email ' +
  'address (wrangler.jsonc "vars", or Settings → Variables in the Cloudflare dashboard) and deploy again.';

/* ------------------------------------------------------------------ flow -- */

/** A JSON answer for an HTTP handler: status plus body. */
export interface AuthResult<T> {
  status: 200 | 400 | 401 | 403 | 429 | 502 | 503;
  body: T | { error: string };
}

/**
 * Add one to a counter and return its new value, atomically: an UPSERT with
 * RETURNING is one statement, so parallel requests each see their own
 * increment. The sweep beside it deletes only expired rows, which costs
 * nothing on the days nobody signs in.
 */
async function bump(db: D1Database, key: string, expiresAt: number, now: number): Promise<number> {
  const [, bumped] = await db.batch<{ n: number }>([
    db.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').bind(now),
    db
      .prepare(
        `INSERT INTO auth_limits (key, n, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n`,
      )
      .bind(key, expiresAt),
  ]);
  return bumped?.results[0]?.n ?? 1;
}

async function counter(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare('SELECT n FROM auth_limits WHERE key = ? AND expires_at > ?')
    .bind(key, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Who is asking, for the per-IP caps. Cloudflare sets cf-connecting-ip on
 * every request that reaches a Worker; '' (tests, local dev) is one shared
 * bucket, which is the old instance-wide behaviour.
 */
export function clientKey(request: Request | { header(name: string): string | undefined }): string {
  const value = request instanceof Request ? request.headers.get('cf-connecting-ip') : request.header('cf-connecting-ip');
  return (value ?? '').slice(0, 64);
}

const hourKey = (now: number) => new Date(now * 1000).toISOString().slice(0, 13);
const dayKey = (now: number) => new Date(now * 1000).toISOString().slice(0, 10);
/** Start of the next UTC hour / day: when an hourly / daily counter expires. */
const nextHour = (now: number) => Math.floor(now / 3600) * 3600 + 3600;
const nextDay = (now: number) => Math.floor(now / 86400) * 86400 + 86400;

const LOCKED = 'Too many wrong codes from this network today. Try again after 00:00 UTC.';

/**
 * Who may ask for a code: the administrator, and anyone with an account row
 * (an invited viewer, or an account carried over from the password era).
 */
async function maySignIn(env: Env, email: string): Promise<boolean> {
  return email === adminEmail(env) || (await getUserByEmail(env.DB, email)) !== null;
}

export interface StartOk {
  ok: true;
  delivery: Delivery;
  /** How many digits the code has, so the app shows that many cells. */
  codeDigits: number;
  /** Set when the code went to the logs, saying where to read it. */
  message?: string;
}

/**
 * POST /api/auth/start. Also used by the OAuth authorize page, which signs in
 * with the same code.
 *
 * Rejections come before any write, so an uninvited address costs a row read
 * and nothing else. The contract's 403 for an unknown address does tell a
 * caller whether an email is invited; that is the trade the contract makes so
 * the app can say "ask the administrator for an invite" instead of leaving
 * someone waiting for a mail that will never come.
 */
export async function startSignIn(
  env: Env,
  rawEmail: unknown,
  client = '',
  now = Math.floor(Date.now() / 1000),
): Promise<AuthResult<StartOk>> {
  const admin = adminEmail(env);
  if (!admin) return { status: 503, body: { error: ADMIN_EMAIL_MISSING } };

  const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : '');
  if (!isValidEmail(email)) return { status: 400, body: { error: 'enter a valid email address' } };
  if (!(await maySignIn(env, email))) {
    return { status: 403, body: { error: 'this email has not been invited to this instance' } };
  }

  const db = env.DB;
  // A code this caller cannot redeem today is a mail with nothing to do.
  if ((await counter(db, `fail-ip:${client}:${dayKey(now)}`, now)) >= FAILS_PER_DAY) {
    return { status: 429, body: { error: LOCKED } };
  }

  const existing = await db
    .prepare('SELECT created_at FROM auth_codes WHERE email = ?')
    .bind(email)
    .first<{ created_at: number }>();
  if (existing && now - existing.created_at < RESEND_SECONDS) {
    return { status: 429, body: { error: 'Wait a minute before asking for another code.' } };
  }

  // Counted before the check, atomically, so parallel requests cannot all slip
  // under the cap; a refused request still counts, which only makes the cap
  // stricter for whoever is hammering it.
  const hour = hourKey(now);
  const fromClient = await bump(db, `send-ip:${client}:${hour}`, nextHour(now), now);
  const toEmail = await bump(db, `send-email:${email}:${hour}`, nextHour(now), now);
  if (fromClient > SENDS_PER_HOUR || toEmail > SENDS_PER_EMAIL_HOUR) {
    return { status: 429, body: { error: 'Too many codes sent. Try again in an hour.' } };
  }

  const code = newCode();
  // INSERT OR REPLACE: a new code retires the previous one for this email, and
  // its attempt counter with it — the tries are per code, the daily cap is not.
  await db
    .prepare(
      `INSERT OR REPLACE INTO auth_codes (email, hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .bind(email, await codeHash(email, code), now + CODE_TTL_SECONDS, now)
    .run();

  try {
    const delivery = await deliverMail(env, email, signInCodeMail(code), { code });
    if (delivery === 'log') {
      return {
        status: 200,
        body: {
          ok: true,
          delivery,
          codeDigits: CODE_LENGTH,
          message:
            'Email is not set up on this instance, so the code was written to the Worker logs. ' +
            'Read it with `wrangler tail`, or under Workers → nsmetry → Logs in the Cloudflare dashboard.',
        },
      };
    }
    return { status: 200, body: { ok: true, delivery, codeDigits: CODE_LENGTH } };
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'sign-in-mail', message: String(error) }));
    // The code never arrived, so it must not stay redeemable.
    await db.prepare('DELETE FROM auth_codes WHERE email = ?').bind(email).run();
    return { status: 502, body: { error: 'sending the code email failed; try again later' } };
  }
}

export interface VerifyOk {
  token: string;
  user: PublicUser;
}

/**
 * Check an emailed code. On success the code is spent and the account (for the
 * administrator, created on first sign-in) is returned — the caller decides
 * what credential to hand out: a bearer session here, an OAuth code on the
 * authorize page.
 */
export async function checkCode(
  env: Env,
  rawEmail: unknown,
  rawCode: unknown,
  client = '',
  now = Math.floor(Date.now() / 1000),
): Promise<{ user: UserRow } | { status: 400 | 401 | 403 | 429 | 503; error: string }> {
  const admin = adminEmail(env);
  if (!admin) return { status: 503, error: ADMIN_EMAIL_MISSING };

  const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : '');
  const code = normalizeCode(rawCode);
  if (!isValidEmail(email) || !CODE_PATTERN.test(code)) {
    return { status: 400, error: 'enter your email and the 8-digit code' };
  }

  const db = env.DB;
  const failKey = `fail-ip:${client}:${dayKey(now)}`;
  if ((await counter(db, failKey, now)) >= FAILS_PER_DAY) return { status: 429, error: LOCKED };

  // Spend the try before comparing, in one statement: concurrent guesses each
  // take one of the code's five tries or get nothing, so "five tries per code"
  // holds however many requests arrive at once.
  const spent = await db
    .prepare(
      `UPDATE auth_codes SET attempts = attempts + 1
       WHERE email = ? AND expires_at > ? AND attempts < ? RETURNING hash`,
    )
    .bind(email, now, CODE_TRIES)
    .first<{ hash: string }>();
  if (!spent) {
    const row = await db
      .prepare('SELECT expires_at, attempts FROM auth_codes WHERE email = ?')
      .bind(email)
      .first<{ expires_at: number; attempts: number }>();
    if (row && row.expires_at > now) {
      return { status: 401, error: 'too many attempts for this code; ask for a new one' };
    }
    return { status: 401, error: 'the code is invalid or has expired; ask for a new one' };
  }

  if (!digestsMatch(await codeHash(email, code), spent.hash)) {
    // Only this caller's counter moves, and nobody else's code is touched:
    // wrong guesses lock out the one guessing, not the people they target.
    const failed = await bump(db, failKey, nextDay(now), now);
    if (failed === FAILS_PER_DAY) {
      console.warn(JSON.stringify({ level: 'warn', event: 'sign-in-locked', day: dayKey(now) }));
    }
    return { status: 401, error: 'that code is not right' };
  }

  // DELETE … RETURNING makes the code single-use even against a racing
  // request holding the same correct code: only one of them gets the row.
  const redeemed = await db
    .prepare('DELETE FROM auth_codes WHERE email = ? AND hash = ? RETURNING email')
    .bind(email, spent.hash)
    .first();
  if (!redeemed) return { status: 401, error: 'the code is invalid or has expired; ask for a new one' };

  // Access is re-checked after the code: an invitation withdrawn in the ten
  // minutes since the mail went out must not still let its holder in.
  let user = await getUserByEmail(db, email);
  if (!user && email === admin) user = await ensureAdminAccount(db, email);
  if (!user) return { status: 403, error: 'this email has not been invited to this instance' };

  return { user: withRole(user, admin) };
}

/** POST /api/auth/verify: the code, exchanged for a bearer token. */
export async function verifySignIn(
  env: Env,
  rawEmail: unknown,
  rawCode: unknown,
  userAgent: string,
  client = '',
): Promise<AuthResult<VerifyOk>> {
  const checked = await checkCode(env, rawEmail, rawCode, client);
  if (!('user' in checked)) return { status: checked.status, body: { error: checked.error } };

  const token = await createSession(env.DB, checked.user.id, userAgent);
  return {
    status: 200,
    body: { token, user: toPublicUser(checked.user, await siteIdsFor(env.DB, checked.user.id)) },
  };
}
