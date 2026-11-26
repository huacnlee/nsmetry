// `npm run deploy`: `wrangler deploy` with this instance's settings taken from `.env` (gitignored), so the
// committed wrangler.jsonc stays the template every deployment starts from.
//
//   CLOUDFLARE_ACCOUNT_ID=...      which account, when the login has several (Wrangler reads it itself)
//   ADMIN_EMAIL=me@example.com     the administrator
//   MAIL_FROM=noreply@example.com  send sign-in codes with Cloudflare Email Sending from this address; adds the
//                                  `EMAIL` send_email binding for this deploy (the domain must be onboarded:
//                                  `npx wrangler email sending enable example.com`)
//
// Anything unset is left as wrangler.jsonc has it. Extra arguments go to `wrangler deploy`.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const args = ['wrangler', 'deploy'];
for (const name of ['ADMIN_EMAIL', 'MAIL_FROM']) {
  const value = process.env[name]?.trim();
  if (value) args.push('--var', `${name}:${value}`);
}

// The binding cannot be given on the command line, so a deploy that sends mail uses a copy of the config with
// it switched on, written beside wrangler.jsonc (its paths are relative) and removed afterwards.
let temp = null;
if (process.env.MAIL_FROM?.trim()) {
  const config = readFileSync('wrangler.jsonc', 'utf8');
  const enabled = config.replace('// "send_email": [{ "name": "EMAIL" }],', '"send_email": [{ "name": "EMAIL" }],');
  if (enabled === config) throw new Error('wrangler.jsonc: the commented send_email binding was not found');
  temp = '.wrangler.deploy.jsonc';
  writeFileSync(temp, enabled);
  args.push('--config', temp);
}

args.push(...process.argv.slice(2));
try {
  const run = spawnSync('npx', args, { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally {
  if (temp) rmSync(temp, { force: true });
}
