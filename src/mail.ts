/**
 * Sending the sign-in code.
 *
 * Three ways, tried in this order, so a deployment works on day one and gets
 * better as it is configured:
 *
 *  1. SMTP — the `SMTP` secret, JSON `{ host, port, secure, user, pass, from }`.
 *     Any mailbox provider works (Fastmail, Gmail app passwords, SES, …), and
 *     it can send to any invited address with no Cloudflare-side setup.
 *  2. Cloudflare Email Sending — a `send_email` binding named `EMAIL` plus a
 *     `MAIL_FROM` var on a domain onboarded with `wrangler email sending enable
 *     <domain>`. An unrestricted binding can send to arbitrary recipients,
 *     which is what invitations need (Email Routing's old binding could only
 *     reach verified addresses).
 *  3. Neither — the code is written to the Worker's logs, where the
 *     administrator can read it with `wrangler tail` or in Workers Logs. The
 *     API says so, so the app can tell whoever is signing in where to look.
 *     Only someone with access to the Cloudflare account can read those logs,
 *     which is exactly the person who could change ADMIN_EMAIL anyway.
 *
 * The SMTP client is a port of noop's cloud/src/smtp.ts (same author, MIT):
 * just enough of the protocol over `cloudflare:sockets` to send one UTF-8
 * message (plain text, or text and HTML), without pulling a mail library into the Worker.
 */

import { connect } from 'cloudflare:sockets';

import { authEnv } from './auth';
import { type Mail, mimeBody } from './codemail';

export type Delivery = 'smtp' | 'email' | 'log';

export interface SmtpConfig {
  host: string;
  /** 465 (default) is implicit TLS; 587 upgrades with STARTTLS. */
  port?: number;
  secure?: boolean;
  /** Only honoured for localhost, so credentials never cross the internet in clear. */
  starttls?: boolean;
  user?: string;
  pass?: string;
  /** `Name <addr@example.com>` or a bare address. Defaults to `user`. */
  from?: string;
}

const encoder = new TextEncoder();

function b64(value: string): string {
  let binary = '';
  for (const b of encoder.encode(value)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The address inside `Name <addr>`, or the whole thing. */
function bareAddress(value: string): string {
  return /<([^>]+)>/.exec(value)?.[1] ?? value.trim();
}

/** A malformed secret is treated as absent rather than crashing every sign-in. */
export function parseSmtpConfig(raw: string | undefined): SmtpConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SmtpConfig>;
    return typeof parsed.host === 'string' && parsed.host ? (parsed as SmtpConfig) : null;
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'smtp-config', message: 'SMTP is not valid JSON' }));
    return null;
  }
}

/** Which way a mail would go right now, without sending anything. */
export function deliveryMethod(env: Env): Delivery {
  const e = authEnv(env);
  if (parseSmtpConfig(e.SMTP)) return 'smtp';
  if (e.EMAIL && e.MAIL_FROM) return 'email';
  return 'log';
}

/**
 * Send one mail. `logOnly` is what to print when no transport is configured —
 * the code itself, not the whole mail, so the log line is short.
 */
export async function deliverMail(env: Env, to: string, mail: Mail, logOnly: Record<string, string>): Promise<Delivery> {
  const e = authEnv(env);
  const smtp = parseSmtpConfig(e.SMTP);
  if (smtp) {
    await sendSmtp(smtp, to, mail);
    return 'smtp';
  }
  if (e.EMAIL && e.MAIL_FROM) {
    const { subject, text, html } = mail;
    await e.EMAIL.send({ from: { name: 'NsMetry', email: e.MAIL_FROM }, to, subject, text, ...(html ? { html } : {}) });
    return 'email';
  }
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'sign-in-code',
      to,
      ...logOnly,
      note: 'No SMTP secret or EMAIL binding is configured, so this is the only copy of the code.',
    }),
  );
  return 'log';
}

/* ------------------------------------------------------------------ SMTP -- */

class Connection {
  private buffer = '';
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(public socket: Socket) {
    this.attach();
  }

  attach(): void {
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = '';
  }

  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  private async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('smtp: connection closed');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** Read a (possibly multi-line "250-…") reply; throw unless the code matches. */
  async reply(expect: number): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.line();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) break;
    }
    const code = Number(lines.at(-1)!.slice(0, 3));
    if (code !== expect) throw new Error(`smtp: expected ${expect}, got ${lines.join(' | ').slice(0, 300)}`);
    return lines;
  }

  send(line: string): Promise<void> {
    return this.writer.write(encoder.encode(`${line}\r\n`));
  }

  async command(line: string, expect: number): Promise<string[]> {
    await this.send(line);
    return this.reply(expect);
  }
}

export async function sendSmtp(config: SmtpConfig, to: string, { subject, text, html }: Mail): Promise<void> {
  const port = config.port ?? 465;
  const implicit = config.secure ?? port === 465;
  const local = config.host === 'localhost' || config.host === '127.0.0.1';
  const plain = !implicit && config.starttls === false && local;

  const socket = connect(
    { hostname: config.host, port },
    { secureTransport: implicit ? 'on' : plain ? 'off' : 'starttls', allowHalfOpen: false },
  );
  const conn = new Connection(socket);
  // A provider that stops answering must not hold the sign-in request forever.
  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }, 20_000);

  try {
    await conn.reply(220);
    let ehlo = await conn.command('EHLO nsmetry', 250);
    if (!implicit && !plain) {
      await conn.command('STARTTLS', 220);
      conn.release();
      conn.socket = socket.startTls();
      conn.attach();
      ehlo = await conn.command('EHLO nsmetry', 250);
    }

    if (config.user) {
      const caps = ehlo.join(' ').toUpperCase();
      if (/AUTH[ =][^\r\n]*PLAIN/.test(caps) && !/AUTH[ =][^\r\n]*LOGIN/.test(caps)) {
        await conn.command(`AUTH PLAIN ${b64(`\0${config.user}\0${config.pass ?? ''}`)}`, 235);
      } else {
        await conn.command('AUTH LOGIN', 334);
        await conn.command(b64(config.user), 334);
        await conn.command(b64(config.pass ?? ''), 235);
      }
    }

    const from = config.from || config.user || `nsmetry@${config.host}`;
    await conn.command(`MAIL FROM:<${bareAddress(from)}>`, 250);
    await conn.command(`RCPT TO:<${bareAddress(to)}>`, 250);
    await conn.command('DATA', 354);

    const domain = bareAddress(from).split('@')[1] ?? 'nsmetry';
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      ...mimeBody(text, html),
    ]
      .join('\r\n')
      // Base64 lines and boundaries never start with ".", but the dot-stuffing
      // stays so a future change to the body cannot end the DATA block early.
      .replace(/\r\n\./g, '\r\n..');

    await conn.send(`${message}\r\n.`);
    await conn.reply(250);
    await conn.send('QUIT').catch(() => undefined);
  } finally {
    clearTimeout(timer);
    try {
      await socket.close();
    } catch {
      /* already closed */
    }
  }
}
