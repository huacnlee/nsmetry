#!/bin/sh
# Builds the NSH web package the Worker serves (app/dist/web/nsmetry; see the
# "assets" block in wrangler.jsonc and src/assets.ts), then adds what
# `nsh package` has no place for: the security headers the asset store sends
# with the app's pages (_headers), and the manifest's colours.
#
#   app/build-web.sh                      # build from this checkout
#   app/build-web.sh --build 42           # extra args go to `nsh package`
#
# Needs the nsh CLI (https://nsh.dev). The wasm build of the icon packages
# also needs an `ar` that understands WebAssembly objects: on macOS that is
# Homebrew's LLVM (`brew install llvm`), picked up below when it is installed.
set -e
# nsh.json is at the repository root, so nsh runs from there.
cd "$(dirname "$0")/.."
NSH="${NSH:-nsh}"
for llvm in /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin; do
  if [ -x "$llvm/llvm-ar" ]; then PATH="$llvm:$PATH"; export PATH; break; fi
done
# `nsh package` names the directory after the display name (NsMetry); the
# Worker serves the lowercase identifier.
OUT="app/dist/web/nsmetry"
TMP="app/dist/.web-build"
rm -rf "$TMP"
"$NSH" package --target web -o "$TMP" "$@"
rm -rf "$OUT"
mkdir -p app/dist/web
mv "$TMP"/* "$OUT"
rmdir "$TMP"

# Headers for what the asset store serves directly (index.html above all).
# frame-ancestors / X-Frame-Options: the app has "Remove site" and "Remove
# person" buttons, so no other page may load it in a frame. no-referrer: the
# app talks to its own origin only, and the instance's address is nobody's
# business. The hashed files the Worker serves (src/assets.ts) set their own.
cat > "$OUT/_headers" <<'EOF'
/*
  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
EOF

# The manifest's colours follow the app's light surface (app/theme.json).
# -i.bak works with both GNU and BSD (macOS) sed.
sed -i.bak 's/"background_color": "[^"]*"/"background_color": "#f7f6f3"/; s/"theme_color": "[^"]*"/"theme_color": "#f7f6f3"/' "$OUT/manifest.webmanifest"
rm -f "$OUT/manifest.webmanifest.bak"
echo "built $OUT"
