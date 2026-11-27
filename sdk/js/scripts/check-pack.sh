#!/usr/bin/env bash
# Packs the SDK the way `npm publish` would and installs the tarball into an empty project, then imports it
# from Node and type-checks a consumer against its declarations. Run after `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/.."

# The User-Agent the client sends names SDK_VERSION, so it must be the version being published.
version=$(node -p "require('./package.json').version")
grep -q "export const SDK_VERSION = '$version';" src/core.ts \
  || { echo "::error::src/core.ts SDK_VERSION does not match package.json ($version)"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tarball=$(npm pack --silent --pack-destination "$tmp")
tar -tzf "$tmp/$tarball" | sort

cd "$tmp"
npm init -y > /dev/null && npm pkg set type=module
npm install --no-audit --no-fund --silent "./$tarball"
node --input-type=module -e "
  import { createNsMetry, SDK_VERSION } from 'nsmetry';
  if (SDK_VERSION !== '$version') throw new Error('SDK_VERSION ' + SDK_VERSION);
  const client = createNsMetry({ endpoint: 'https://stats.example.com', site: 'check', disabled: true });
  client.screen('/');
  client.track('packed', { ok: true });
  await client.flush();
  console.log('import ok: nsmetry ' + SDK_VERSION);
"
cat > consumer.ts <<'TS'
import { createNsMetry, type NsMetry } from 'nsmetry';
const client: NsMetry = createNsMetry({ endpoint: 'https://stats.example.com', site: 'check' });
client.track('typed', { n: 1 });
TS
"$OLDPWD/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom consumer.ts
echo 'types ok'
