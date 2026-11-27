import { describe, expect, it } from 'vitest';

import { mimeBody, signInCodeMail } from '../src/codemail';

const unb64 = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));

describe('sign-in code mail', () => {
  it('puts the code, unsplit, in the subject, the preview and the first text line', () => {
    const mail = signInCodeMail('K7MPQ3XR');
    expect(mail.subject).toBe('K7MPQ3XR is your NsMetry verification code');
    expect(mail.text.split('\n')[0]).toBe('Your NsMetry verification code is K7MPQ3XR.');
    expect(mail.html).toContain('<div style="display:none;max-height:0;overflow:hidden;">Your NsMetry verification code is K7MPQ3XR.');
    expect(mail.html).toContain('>K7MPQ3XR</div>');
  });

  it('sends text alone, or text and HTML as multipart/alternative', () => {
    expect(mimeBody('hi')).toEqual(['MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', 'aGk=']);
    const lines = mimeBody('plain ✓', '<b>html ✓</b>');
    const boundary = /boundary="([^"]+)"/.exec(lines[1]!)![1]!;
    expect(lines.filter((l) => l === `--${boundary}`)).toHaveLength(2);
    expect(lines.at(-1)).toBe(`--${boundary}--`);
    const parts = lines.join('\r\n').split(`--${boundary}`).slice(1, 3).map((p) => p.split('\r\n\r\n'));
    expect(parts[0]![0]).toContain('text/plain');
    expect(unb64(parts[0]![1]!)).toBe('plain ✓');
    expect(parts[1]![0]).toContain('text/html');
    expect(unb64(parts[1]![1]!)).toBe('<b>html ✓</b>');
  });
});
