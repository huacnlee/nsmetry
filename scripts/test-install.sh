#!/bin/sh
# Test install.sh with local release fixtures. The test mocks curl and uname (and ditto off macOS), and it
# keeps HOME and every install in a scratch folder, so it never changes the real system.
# Usage: scripts/test-install.sh [SHELL]   (the shell that runs install.sh, default sh)
# check evaluates its condition later, so the conditions are in single quotes.
# shellcheck disable=SC2016,SC2034
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/install.sh"
shell="${1:-sh}"
root="$(mktemp -d "${TMPDIR:-/tmp}/nsmetry-install-test.XXXXXXXX")"
trap 'rm -rf "$root"' 0
failures=0
version=0.4.0
for tool in zip unzip; do command -v "$tool" >/dev/null || { echo "The test needs $tool." >&2; exit 1; }; done

mkdir -p "$root/mock" "$root/fixtures"
cat > "$root/mock/uname" <<'EOF'
#!/bin/sh
if [ "$1" = -s ]; then echo "${MOCK_OS:-Linux}"; else echo "${MOCK_ARCH:-x86_64}"; fi
EOF
# The mock curl serves files from $FIXTURES by the last part of the URL, for the release $MOCK_RELEASE only.
cat > "$root/mock/curl" <<'EOF'
#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  https://github.com/huacnlee/nsmetry/releases/latest)
    printf '%s' "https://github.com/huacnlee/nsmetry/releases/tag/v$MOCK_LATEST"; exit 0 ;;
  "https://github.com/huacnlee/nsmetry/releases/download/v$MOCK_RELEASE/"*) ;;
  https://github.com/huacnlee/nsmetry/releases/download/*)
    echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
  *) echo "unexpected URL: $url" >&2; exit 2 ;;
esac
file="$FIXTURES/${url##*/}"
[ -f "$file" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$file" "$output"
EOF
# ditto exists on macOS only: unzip for -x -k, a copy otherwise.
cat > "$root/mock/ditto" <<'EOF'
#!/bin/sh
if [ "$1" = -x ]; then exec unzip -q "$3" -d "$4"; fi
cp -R "$1" "$2"
EOF
chmod 755 "$root/mock/uname" "$root/mock/curl" "$root/mock/ditto"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

# release linux|macos [unsafe|escaping-link|inner-link|no-program|flat]: write the asset and sha256sums,
# laid out the way release.yml packages it.
release() {
  rm -rf "$root/stage" && mkdir -p "$root/stage/pack"
  pack="$root/stage/pack"
  case "$1" in
    macos)
      contents="$pack/NsMetry.app/Contents"
      mkdir -p "$contents/MacOS" "$contents/Resources/nsh"
      printf '#!/bin/sh\necho "NsMetry %s"\n' "$version" > "$contents/MacOS/NsMetry"
      chmod 755 "$contents/MacOS/NsMetry"
      echo plist > "$contents/Info.plist"
      echo bytecode > "$contents/Resources/nsh/bundle.nshc"
      asset=nsmetry-macos-arm64.zip
      (cd "$pack" && zip -qry "$root/fixtures/$asset" NsMetry.app) ;;
    linux)
      app="$pack/NsMetry"
      mkdir -p "$app/nsh"
      printf '#!/bin/sh\necho "NsMetry %s"\n' "$version" > "$app/NsMetry"
      chmod 755 "$app/NsMetry"
      echo bytecode > "$app/nsh/bundle.nshc"
      printf '[Desktop Entry]\nType=Application\nName=NsMetry\nExec=NsMetry %%U\nTryExec=NsMetry\nIcon=dev.nsmetry.app\nStartupWMClass=dev.nsmetry.app\n' \
        > "$app/dev.nsmetry.app.desktop"
      echo png > "$app/dev.nsmetry.app.png"
      case "${2:-}" in
        no-program) rm -f "$app/NsMetry"; sed -i.bak 's/^Exec=.*/Exec=gone/' "$app/dev.nsmetry.app.desktop"; rm -f "$app"/*.bak ;;
        escaping-link) ln -s /etc/passwd "$app/escape" ;;
        inner-link) ln -s nsh/bundle.nshc "$app/bundle-link" ;;
      esac
      asset=nsmetry-linux-x86_64.tar.gz
      if [ "${2:-}" = unsafe ]; then
        mkdir -p "$pack/sub" && echo bad > "$pack/escaped"
        (cd "$pack/sub" && tar -P -czf "$root/fixtures/$asset" ../escaped ../NsMetry)
      elif [ "${2:-}" = flat ]; then
        (cd "$app" && tar -czf "$root/fixtures/$asset" .)
      else
        (cd "$pack" && tar -czf "$root/fixtures/$asset" NsMetry)
      fi ;;
  esac
  printf '%s  %s\n' "$(sha256 "$root/fixtures/$asset")" "$asset" > "$root/fixtures/sha256sums"
  # The real file lists every asset; another line must not confuse the lookup.
  printf '%s  %s\n' "$(printf '%064d' 0)" nsmetry-web.tar.gz >> "$root/fixtures/sha256sums"
}

# run_install ARGS...: run install.sh with the mocks. Output goes to $root/out.
run_install() {
  status=0
  env PATH="$root/mock:$PATH" HOME="$root/home" FIXTURES="$root/fixtures" MOCK_LATEST="$version" MOCK_RELEASE="$version" \
    TMPDIR="$root/tmp" "$shell" "$script" "$@" > "$root/out" 2>&1 || status=$?
  return 0
}

fresh() {
  rm -rf "${root:?}/home" "$root/tmp" "$root/fixtures" "$root/dest"
  mkdir -p "$root/home" "$root/tmp" "$root/fixtures"
  dest="$root/dest/install with spaces"
  unset MOCK_OS MOCK_ARCH || true
}

check() {
  if eval "$2"; then
    :
  else
    printf 'FAIL %s: %s\n' "$1" "$2"
    sed 's/^/  | /' "$root/out" 2>/dev/null || true
    failures=$((failures + 1))
    return 1
  fi
}
ok() { printf 'PASS %s\n' "$1"; }

entry_file() { printf '%s' "$dest/share/applications/dev.nsmetry.app.desktop"; }

name='linux install and upgrade'
fresh
release linux
run_install --dir "$dest"
check "$name" '[ "$status" -eq 0 ]' &&
  echo stale > "$dest/share/nsmetry/stale" &&
  run_install --dir "$dest" &&
  check "$name" '[ "$status" -eq 0 ] && [ ! -e "$dest/share/nsmetry/stale" ]' &&
  check "$name" '[ -x "$dest/share/nsmetry/NsMetry" ] && [ -f "$dest/share/nsmetry/nsh/bundle.nshc" ]' &&
  check "$name" '[ "$("$root/home/.local/bin/nsmetry")" = "NsMetry $version" ]' &&
  check "$name" 'grep -qxF "Exec=\"$dest/share/nsmetry/NsMetry\"" "$(entry_file)"' &&
  check "$name" 'grep -qxF "Icon=$dest/share/nsmetry/dev.nsmetry.app.png" "$(entry_file)"' &&
  check "$name" 'grep -qx "StartupWMClass=dev.nsmetry.app" "$(entry_file)" && ! grep -q "^TryExec=" "$(entry_file)"' &&
  check "$name" 'grep -q "add $root/home/.local/bin to PATH" "$root/out"' &&
  check "$name" '[ -z "$(ls -A "$dest/share" | grep nsmetry-install || true)" ] && [ -z "$(ls -A "$root/tmp")" ]' &&
  ok "$name"

name='linux uninstall'
run_install --dir "$dest" --uninstall
check "$name" '[ "$status" -eq 0 ] && [ ! -e "$dest/share/nsmetry" ] && [ ! -e "$(entry_file)" ]' &&
  check "$name" '[ ! -e "$root/home/.local/bin/nsmetry" ]' && ok "$name"

name='pipe to sh with NSMETRY_INSTALL_DIR and a pinned version'
fresh
release linux
status=0
env PATH="$root/mock:$PATH" HOME="$root/home" FIXTURES="$root/fixtures" MOCK_LATEST=9.9.9 MOCK_RELEASE="$version" \
  TMPDIR="$root/tmp" NSMETRY_INSTALL_DIR="$dest" NSMETRY_VERSION="v$version" "$shell" < "$script" > "$root/out" 2>&1 || status=$?
check "$name" '[ "$status" -eq 0 ] && [ -x "$dest/share/nsmetry/NsMetry" ] && grep -q "NsMetry $version for linux" "$root/out"' && ok "$name"

name='default prefix is ~/.local'
fresh
release linux
run_install
check "$name" '[ "$status" -eq 0 ] && [ -x "$root/home/.local/share/nsmetry/NsMetry" ]' &&
  check "$name" '[ -f "$root/home/.local/share/applications/dev.nsmetry.app.desktop" ]' && ok "$name"

name='an archive without the top folder installs'
fresh
release linux flat
run_install --dir "$dest"
check "$name" '[ "$status" -eq 0 ] && [ -x "$dest/share/nsmetry/NsMetry" ]' && ok "$name"

name='a link inside the app installs'
fresh
release linux inner-link
run_install --dir "$dest"
check "$name" '[ "$status" -eq 0 ] && [ -L "$dest/share/nsmetry/bundle-link" ]' && ok "$name"

name='bad checksum installs nothing'
fresh
release linux
echo tampered >> "$root/fixtures/nsmetry-linux-x86_64.tar.gz"
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "Checksum verification failed" "$root/out" && [ ! -e "$dest" ]' && ok "$name"

name='missing checksum installs nothing'
fresh
release linux
echo "$(printf '%064d' 0)  other.tar.gz" > "$root/fixtures/sha256sums"
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "Missing or invalid checksum" "$root/out" && [ ! -e "$dest" ]' && ok "$name"

name='unsafe path installs nothing'
fresh
release linux unsafe
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "unsafe path" "$root/out" && [ ! -e "$dest" ] && [ ! -e "$root/dest/escaped" ]' && ok "$name"

name='a link out of the app installs nothing'
fresh
release linux escaping-link
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "unsafe path" "$root/out" && [ ! -e "$dest" ]' && ok "$name"

name='archive without the program installs nothing'
fresh
release linux no-program
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "has no NsMetry program" "$root/out" && [ ! -e "$dest/share/nsmetry" ]' && ok "$name"

name='release without the asset'
fresh
release linux
run_install --dir "$dest" --version 0.3.0
check "$name" '[ "$status" -ne 0 ] && grep -q "Release v0.3.0 has no nsmetry-linux-x86_64.tar.gz" "$root/out"' && ok "$name"

name='a foreign nsmetry command stays'
fresh
release linux
mkdir -p "$root/home/.local/bin"
printf '#!/bin/sh\necho mine\n' > "$root/home/.local/bin/nsmetry"
chmod 755 "$root/home/.local/bin/nsmetry"
run_install --dir "$dest"
check "$name" '[ "$status" -eq 0 ] && [ "$("$root/home/.local/bin/nsmetry")" = mine ]' &&
  check "$name" 'grep -q "is not from this installer" "$root/out"' &&
  run_install --dir "$dest" --uninstall &&
  check "$name" '[ "$("$root/home/.local/bin/nsmetry")" = mine ]' && ok "$name"

name='the command in --bin-dir, on PATH'
fresh
release linux
status=0
env PATH="$root/bin:$root/mock:$PATH" HOME="$root/home" FIXTURES="$root/fixtures" MOCK_LATEST="$version" MOCK_RELEASE="$version" \
  TMPDIR="$root/tmp" "$shell" "$script" --dir "$dest" --bin-dir "$root/bin" > "$root/out" 2>&1 || status=$?
check "$name" '[ "$status" -eq 0 ] && [ "$("$root/bin/nsmetry")" = "NsMetry $version" ]' &&
  check "$name" '[ ! -e "$root/home/.local/bin" ] && grep -qx "Or run: nsmetry" "$root/out"' && ok "$name"
rm -rf "${root:?}/bin"

name='macOS app install, upgrade and uninstall'
fresh
release macos
MOCK_OS=Darwin MOCK_ARCH=arm64; export MOCK_OS MOCK_ARCH
run_install --dir "$dest"
check "$name" '[ "$status" -eq 0 ]' &&
  echo stale > "$dest/NsMetry.app/Contents/stale" &&
  run_install --dir "$dest" &&
  check "$name" '[ "$status" -eq 0 ] && [ -f "$dest/NsMetry.app/Contents/Resources/nsh/bundle.nshc" ]' &&
  check "$name" '[ ! -e "$dest/NsMetry.app/Contents/stale" ] && [ "$(ls -A "$dest")" = NsMetry.app ]' &&
  check "$name" '[ "$("$dest/NsMetry.app/Contents/MacOS/NsMetry")" = "NsMetry $version" ]' &&
  check "$name" '[ ! -e "$root/home/.local/bin/nsmetry" ] && grep -q "Open it from Launchpad" "$root/out"' &&
  run_install --dir "$dest" --uninstall &&
  check "$name" '[ "$status" -eq 0 ] && [ ! -e "$dest/NsMetry.app" ]' && ok "$name"

name='macOS default folder is ~/Applications when /Applications is not writable'
if [ -w /Applications ]; then
  printf 'SKIP %s: /Applications is writable here\n' "$name"
else
  fresh
  release macos
  MOCK_OS=Darwin MOCK_ARCH=arm64; export MOCK_OS MOCK_ARCH
  run_install
  check "$name" '[ "$status" -eq 0 ] && [ -d "$root/home/Applications/NsMetry.app" ]' && ok "$name"
fi

name='macOS archive with an unsafe path installs nothing'
fresh
mkdir -p "$root/stage/a/b" && echo bad > "$root/stage/a/escaped"
(cd "$root/stage/a/b" && zip -q "$root/fixtures/nsmetry-macos-arm64.zip" ../escaped)
printf '%s  %s\n' "$(sha256 "$root/fixtures/nsmetry-macos-arm64.zip")" nsmetry-macos-arm64.zip > "$root/fixtures/sha256sums"
MOCK_OS=Darwin MOCK_ARCH=arm64; export MOCK_OS MOCK_ARCH
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "unsafe path" "$root/out" && [ ! -e "$dest" ]' && ok "$name"

name='Intel Mac and ARM Linux are told to use the web app'
fresh
MOCK_OS=Darwin MOCK_ARCH=x86_64; export MOCK_OS MOCK_ARCH
run_install --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "Apple silicon build only" "$root/out"' &&
  MOCK_OS=Linux MOCK_ARCH=aarch64 && export MOCK_OS MOCK_ARCH && run_install --dir "$dest" &&
  check "$name" '[ "$status" -ne 0 ] && grep -q "Linux x86_64 build only" "$root/out" && [ ! -e "$dest" ]' && ok "$name"

name='invalid version downloads nothing'
fresh
run_install --version ../bad --dir "$dest"
check "$name" '[ "$status" -ne 0 ] && grep -q "Version must be" "$root/out" && [ ! -e "$dest" ]' && ok "$name"

if [ "$failures" -ne 0 ]; then
  printf '%s check(s) failed\n' "$failures"
  exit 1
fi
printf '%s\n' 'All installer tests passed.'
