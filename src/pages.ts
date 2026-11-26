/**
 * The few server-rendered pages left: signing in and approving an AI agent on
 * the OAuth authorize screen, and the error shown when an authorization
 * request cannot be bounced back to its client.
 *
 * Everything else is the NSH app. These pages exist because an OAuth client
 * opens a plain browser window at /oauth/authorize, and that window has to
 * work without the app — so they run no script at all: forms post back, and
 * every value is escaped where it is written.
 *
 * The look follows the Allsum design rules: quiet, compact, system fonts only,
 * one set of colour tokens written with light-dark() so the page follows the
 * system theme without a second block of rules, 6px controls, and a primary
 * button that is ink on paper rather than a brand colour.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: light-dark(#ffffff, #131312);
  --bg-soft: light-dark(#f7f6f3, #191918);
  --border: light-dark(rgba(0,0,0,.08), rgba(255,255,255,.09));
  --border-strong: light-dark(rgba(0,0,0,.15), rgba(255,255,255,.16));
  --text: light-dark(#1f1e1c, #e8e6e1);
  --text-soft: light-dark(#3d3b37, #c3c0b9);
  --text-muted: light-dark(#6f6c65, #8e8b84);
  --accent: light-dark(#2563eb, #60a5fa);
  --bad: light-dark(#c4362b, #f0877c);
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
  background: var(--bg-soft); color: var(--text-soft); font: 400 13px/1.45 var(--sans);
  -webkit-font-smoothing: antialiased; }
.card { width: 100%; max-width: 380px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.brand { font: 600 13px/1 var(--sans); color: var(--text); letter-spacing: -.01em; }
h1 { margin: 0; font: 600 20px/1.35 var(--sans); color: var(--text); }
p { margin: 0; color: var(--text-muted); }
form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
label { display: flex; flex-direction: column; gap: 4px; font: 500 12px/1.45 var(--sans); color: var(--text-soft); }
input { font: 400 14px/1 var(--sans); color: var(--text); background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: 6px; height: 32px; padding: 0 10px; }
input:focus { outline: none; border-color: var(--accent); }
input.code { font-family: var(--mono); letter-spacing: .18em; text-transform: uppercase; }
.row { display: flex; gap: 8px; }
button { display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px;
  border-radius: 6px; font: 500 13px/1 var(--sans); cursor: pointer; flex: 1;
  border: 1px solid var(--text); background: var(--text); color: var(--bg); }
button:hover { opacity: .9; }
button.secondary { background: var(--bg); color: var(--text); border-color: var(--border-strong); }
.error { margin: 0; padding: 8px 10px; border-radius: 6px; color: var(--bad);
  background: color-mix(in srgb, var(--bad) 10%, transparent); }
.facts { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 6px;
  background: var(--bg-soft); border: 1px solid var(--border); }
.facts div { display: flex; justify-content: space-between; gap: 12px; }
.facts span { font-family: var(--mono); font-size: 12px; color: var(--text); overflow-wrap: anywhere; text-align: right; }
.note { font-size: 12px; color: var(--text-muted); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main class="card">
  <span class="brand">NsMetry</span>
  ${body}
</main>
</body>
</html>`;
}

function errorBlock(message: string | undefined): string {
  return message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : '';
}

function hiddenFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n    ');
}

/* -------------------------------------------------------------- sign-in -- */

export interface SignInView {
  /** Where the form posts. The OAuth authorize endpoint, in practice. */
  action: string;
  /** 'email' asks for an address; 'code' asks for the code just sent to it. */
  step: 'email' | 'code';
  email?: string;
  error?: string;
  /** A line under the heading, e.g. where the code was sent or logged. */
  notice?: string;
  /** Hidden fields to echo back (the OAuth request, an anti-forgery token). */
  fields?: Record<string, string>;
  /**
   * Who is asking, shown on both steps — e.g. which app the OAuth flow is
   * connecting — so nobody types a code into a page without knowing why.
   */
  intro?: string;
}

/**
 * The email-code sign-in, as a two-step form that needs no script. The step
 * travels in a hidden `step` field so the handler knows which half it got.
 */
export function signInPage(view: SignInView): string {
  const fields = hiddenFields({ ...(view.fields ?? {}), step: view.step });
  const intro = view.intro ? `<p class="note">${escapeHtml(view.intro)}</p>` : '';

  if (view.step === 'email') {
    return layout(
      'Sign in to NsMetry',
      `<h1>Sign in</h1>
  <p>Enter your email and we will send you a one-time code. There is no password.</p>
  ${intro}
  ${errorBlock(view.error)}
  <form method="post" action="${escapeHtml(view.action)}">
    ${fields}
    <label>Email
      <input name="email" type="email" autocomplete="email" required autofocus value="${escapeHtml(view.email ?? '')}"></label>
    <button type="submit">Send code</button>
  </form>`,
    );
  }

  return layout(
    'Enter your code',
    `<h1>Check your email</h1>
  <p>${escapeHtml(view.notice ?? `We sent an 8-character code to ${view.email ?? 'your address'}. It is valid for 10 minutes.`)}</p>
  ${intro}
  ${errorBlock(view.error)}
  <form method="post" action="${escapeHtml(view.action)}">
    ${fields}
    <input type="hidden" name="email" value="${escapeHtml(view.email ?? '')}">
    <label>Code
      <input class="code" name="code" inputmode="text" autocomplete="one-time-code" required autofocus
        minlength="8" maxlength="12" spellcheck="false"></label>
    <button type="submit">Sign in</button>
  </form>`,
  );
}

/* ------------------------------------------------------------------ OAuth -- */

/** Everything the consent screen shows and posts back. All of it is escaped. */
export interface ConsentView {
  /** Self-asserted by the client at registration — shown, never trusted. */
  clientName: string;
  /** The host the browser will be sent to. This is the part that is verified. */
  redirectHost: string;
  email: string;
  /** The administrator sees everything; a viewer sees what site_access grants. */
  sites: string[];
  allSites: boolean;
  /** Hidden fields to echo back, including the anti-forgery token. */
  fields: Record<string, string>;
  /** Where the form posts. Defaults to /oauth/authorize. */
  action?: string;
}

/**
 * Approve or deny an agent's request for read access.
 *
 * Two submit buttons on one form, told apart by their `decision` value. The
 * redirect host is given the same weight as the client's name on purpose —
 * the name is whatever the client typed into its own registration, while the
 * host is where the code will actually go.
 */
export function consentPage(view: ConsentView): string {
  const shown = view.sites.slice(0, 8).map((s) => escapeHtml(s)).join(', ');
  const more = view.sites.length > 8 ? ` and ${view.sites.length - 8} more` : '';
  const scope = view.allSites
    ? 'every site on this instance'
    : view.sites.length
      ? `${shown}${more}`
      : 'no sites yet';

  return layout(
    'Authorize access',
    `<h1>${escapeHtml(view.clientName)} wants read-only access</h1>
  <p>Signed in as ${escapeHtml(view.email)}. It will be able to read the analytics you can see — ${scope} —
    and nothing else: it cannot add sites, change settings or manage people.</p>
  <div class="facts">
    <div>App<span>${escapeHtml(view.clientName)}</span></div>
    <div>Returns to<span>${escapeHtml(view.redirectHost)}</span></div>
    <div>Access<span>analytics, read-only</span></div>
  </div>
  <form method="post" action="${escapeHtml(view.action ?? '/oauth/authorize')}">
    ${hiddenFields(view.fields)}
    <div class="row">
      <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
      <button type="submit" name="decision" value="approve">Allow</button>
    </div>
  </form>
  <p class="note">Only approve apps you started yourself. You can disconnect it later under Connected agents.</p>`,
  );
}

/**
 * An authorization request that cannot be bounced back to the client.
 *
 * When the client id or redirect URI is the thing that is wrong, sending the
 * browser to that URI would make this server an open redirector — so the
 * error is shown here instead, as RFC 6749 §4.1.2.1 requires.
 */
export function oauthErrorPage(message: string): string {
  return layout(
    'Authorization failed',
    `<h1>Authorization failed</h1>
  <p>The app that sent you here made a request this instance could not accept. Nothing was authorized
    and no data was shared.</p>
  ${errorBlock(message)}
  <p class="note">Try connecting again from the app. If it keeps happening, the app may need updating.</p>`,
  );
}
