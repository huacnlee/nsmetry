/**
 * The sign-in code mail.
 *
 * Mail apps that offer to copy a code (Gmail's "Copy code", Apple Mail's
 * AutoFill) don't publish how they spot one, so this follows what the mails
 * they do pick up share: the code is in the subject, the preview and the first
 * line of the text, next to the words "verification code", once and unsplit.
 * The HTML part shows it large; the text part stays for clients without HTML.
 */

export interface Mail {
  subject: string;
  text: string;
  html?: string;
}

const encoder = new TextEncoder();

function b64(value: string): string {
  let binary = '';
  for (const b of encoder.encode(value)) binary += String.fromCharCode(b);
  return btoa(binary);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value: string) => value.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

/** The MIME part after the address headers: text alone, or text and HTML as multipart/alternative. */
export function mimeBody(text: string, html?: string): string[] {
  const part = (type: string, body: string) => [
    `Content-Type: ${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/.{1,76}/g, '$&\r\n').trimEnd(),
  ];
  if (!html) return ['MIME-Version: 1.0', ...part('text/plain', text)];
  const boundary = `=_${crypto.randomUUID()}`;
  return [
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...part('text/plain', text),
    `--${boundary}`,
    ...part('text/html', html),
    `--${boundary}--`,
  ];
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

export function signInCodeMail(code: string): Required<Mail> {
  const line = `Your NsMetry verification code is ${code}.`;
  const valid = 'It expires in 10 minutes.';
  const ignore = "If you didn't try to sign in to NsMetry, ignore this email. Nobody can sign in without the code.";
  const subject = `${code} is your NsMetry verification code`;
  const text = `${line}\n\n${valid}\n\n${ignore}\n`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(line)} ${esc(valid)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;">
<tr><td style="padding:32px 32px 8px;font:600 18px/1.4 ${SANS};color:#18181b;">Your NsMetry verification code</td></tr>
<tr><td style="padding:16px 32px;"><div style="padding:16px 0;background:#f4f4f5;border-radius:8px;text-align:center;font:700 32px/1.2 ${MONO};letter-spacing:6px;color:#18181b;">${esc(code)}</div></td></tr>
<tr><td style="padding:8px 32px 32px;font:14px/1.6 ${SANS};color:#52525b;">${esc(valid)}<br>${esc(ignore)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
