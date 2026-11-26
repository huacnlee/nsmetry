#!/bin/sh
# Install the NsMetry desktop app from a GitHub release, for the current user. No sudo is necessary.
#
#   curl -fsSL https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.sh | sh -s -- --version 0.4.0
#
# macOS (Apple silicon) gets NsMetry.app; Linux (x86_64) gets the app under <prefix>/share/nsmetry, an entry
# for the app launcher and the command `nsmetry`. Every download is checked against the release's sha256sums
# before anything is installed. Windows: scripts/install.ps1.
set -eu

version="${NSMETRY_VERSION:-latest}"
destination="${NSMETRY_INSTALL_DIR:-}"
bin_dir="${NSMETRY_BIN_DIR:-}"
action=install
usage() {
  printf '%s\n' 'Usage: install.sh [--version VERSION] [--dir DIRECTORY] [--bin-dir DIRECTORY] [--uninstall]' \
    'Defaults: the latest release; /Applications (or ~/Applications when it is not writable) on macOS,' \
    'the prefix ~/.local on Linux; the command in ~/.local/bin (Linux only).'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--dir|--bin-dir)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --version) version="$2" ;;
        --dir) destination="$2" ;;
        *) bin_dir="$2" ;;
      esac
      shift 2 ;;
    --uninstall) action=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
die() { printf 'nsmetry: %s\n' "$*" >&2; exit 1; }
[ -n "${HOME:-}" ] || die 'HOME is not set.'
bin_dir="${bin_dir:-$HOME/.local/bin}"
case "$(uname -s)" in
  Darwin)
    platform=macos
    if [ -z "$destination" ]; then
      if [ -w /Applications ]; then destination=/Applications; else destination="$HOME/Applications"; fi
    fi ;;
  Linux) platform=linux; destination="${destination:-$HOME/.local}" ;;
  *) die 'Use install.ps1 on Windows. This script supports macOS and Linux.' ;;
esac

# The command `nsmetry` (Linux): a file this installer wrote carries this line; any other file there stays.
marker='# Written by the NsMetry installer.'
command_path="$bin_dir/nsmetry"
ours() { [ -f "$1" ] && grep -qxF "$marker" "$1" 2>/dev/null; }

if [ "$action" = uninstall ]; then
  if [ "$platform" = macos ]; then
    rm -rf "$destination/NsMetry.app"
    printf 'Removed %s/NsMetry.app\n' "$destination"
  else
    for entry in "$destination"/share/applications/nsmetry*.desktop "$destination"/share/applications/dev.nsmetry.app.desktop; do
      if [ -f "$entry" ] && grep -q "$destination/share/nsmetry/" "$entry"; then rm -f "$entry"; fi
    done
    rm -rf "$destination/share/nsmetry"
    if ours "$command_path"; then rm -f "$command_path"; fi
    if command -v update-desktop-database >/dev/null; then update-desktop-database "$destination/share/applications" >/dev/null 2>&1 || true; fi
    printf 'Removed %s/share/nsmetry\n' "$destination"
  fi
  printf '%s\n' 'Your instance and its data are not affected.'
  exit 0
fi

for tool in curl tar awk; do command -v "$tool" >/dev/null || die "Required command missing: $tool"; done
case "$platform-$(uname -m)" in
  macos-arm64|macos-aarch64) asset=nsmetry-macos-arm64.zip ;;
  linux-x86_64|linux-amd64) asset=nsmetry-linux-x86_64.tar.gz ;;
  macos-*) die 'Releases have an Apple silicon build only. Open the web app at your instance address instead.' ;;
  *) die 'Releases have a Linux x86_64 build only. Open the web app at your instance address instead.' ;;
esac
[ "$platform" = linux ] || command -v unzip >/dev/null || die 'Required command missing: unzip'

download() { curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$@"; }
repo=https://github.com/huacnlee/nsmetry
# Resolve "latest" to a tag first, so the archive and sha256sums come from the same release.
if [ "$version" = latest ]; then
  release_url="$(download --output /dev/null --write-out '%{url_effective}' "$repo/releases/latest")" ||
    die 'Could not reach GitHub to find the latest release.'
  version="${release_url##*/}"
fi
version="${version#v}"
awk -v version="$version" 'BEGIN {exit !(version ~ /^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$/)}' ||
  die 'Version must be a release version such as 0.4.0 or v0.4.0.'
base="$repo/releases/download/v$version"
work="$(mktemp -d "${TMPDIR:-/tmp}/nsmetry-install.XXXXXXXX")"
trap 'rm -rf "$work"' 0
printf 'Downloading NsMetry %s for %s...\n' "$version" "$platform"
download "$base/$asset" --output "$work/$asset" || die "Release v$version has no $asset."
download "$base/sha256sums" --output "$work/sha256sums" || die "Release v$version has no sha256sums."
expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/sha256sums")"
[ "${#expected}" -eq 64 ] || die "Missing or invalid checksum for $asset"
case "$expected" in *[!a-fA-F0-9]*) die "Missing or invalid checksum for $asset" ;; esac
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$work/$asset")"
elif command -v shasum >/dev/null; then
  actual="$(shasum -a 256 "$work/$asset")"
else die 'Required command missing: sha256sum or shasum'; fi
[ "${actual%% *}" = "$expected" ] || die 'Checksum verification failed. The installer installed nothing.'

# Entry names must be relative and stay in the extraction folder.
unsafe_name='/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}'
mkdir "$work/unpacked"
if [ "$platform" = macos ]; then
  unzip -Z1 "$work/$asset" > "$work/entries" 2>/dev/null || die 'Release archive is not a valid zip.'
  if awk "$unsafe_name" "$work/entries"; then die 'Release archive contains an unsafe path.'; fi
  # ditto keeps the app's signature, links and attributes intact; unzip may not.
  ditto -x -k "$work/$asset" "$work/unpacked"
else
  tar -tzf "$work/$asset" > "$work/entries"
  tar -tvzf "$work/$asset" > "$work/listing"
  # Plain files and folders, and links that point inside the app: a relative target without "..".
  if awk "$unsafe_name" "$work/entries" ||
    awk '/^l/ { t = $0; sub(/.* -> /, "", t); if (t ~ /^\// || t ~ /(^|\/)\.\.(\/|$)/) bad=1; next }
         !/^[-d]/ {bad=1} END {exit !bad}' "$work/listing"; then
    die 'Release archive contains an unsafe path.'
  fi
  tar -xzf "$work/$asset" -C "$work/unpacked"
fi

# replace PARENT NAME SOURCE: put the folder SOURCE at PARENT/NAME as one unit. When the move fails, the
# previous version comes back.
replace() {
  staging="$(mktemp -d "$1/.nsmetry-install.XXXXXXXX")"
  trap 'rm -rf "$work" "${staging:-}"' 0
  if [ "$platform" = macos ]; then ditto "$3" "$staging/$2"; else cp -R "$3" "$staging/$2"; fi
  previous="$staging/previous"
  if [ -e "$1/$2" ]; then mv "$1/$2" "$previous"; fi
  if ! mv "$staging/$2" "$1/$2"; then
    if [ -e "$previous" ]; then mv "$previous" "$1/$2"; fi
    die "Could not replace $1/$2."
  fi
  rm -rf "$staging"
}

if [ "$platform" = macos ]; then
  app="$work/unpacked/NsMetry.app"
  [ -f "$app/Contents/Info.plist" ] || die 'Release archive is missing NsMetry.app/Contents/Info.plist.'
  [ -d "$app/Contents/MacOS" ] || die 'Release archive is missing NsMetry.app/Contents/MacOS.'
  mkdir -p "$destination"
  replace "$destination" NsMetry.app "$app"
  printf 'Installed %s/NsMetry.app. Open it from Launchpad or Finder.\n' "$destination"
  printf '%s\n' 'Then type your instance address (for example stats.example.com) and sign in with the code it emails you.'
  exit 0
fi

# Linux: the archive holds one folder, the app: its program, the interface bundle and a desktop entry.
source_dir="$work/unpacked"
set -- "$source_dir"/*
if [ "$#" -eq 1 ] && [ -d "$1" ]; then source_dir="$1"; fi
entry="$(find "$source_dir" -maxdepth 1 -name '*.desktop' -type f | head -n 1)"
program_name=
if [ -n "$entry" ]; then
  program_name="$(awk -F= '/^Exec=/ { split($2, words, " "); print words[1]; exit }' "$entry" | tr -d '"')"
  program_name="${program_name##*/}"
fi
if [ -z "$program_name" ] || [ ! -f "$source_dir/$program_name" ]; then
  for name in NsMetry nsmetry; do
    if [ -f "$source_dir/$name" ]; then program_name="$name"; break; fi
  done
fi
[ -n "$program_name" ] && [ -f "$source_dir/$program_name" ] || die 'Release archive has no NsMetry program.'
chmod 755 "$source_dir/$program_name"
mkdir -p "$destination/share/applications"
replace "$destination/share" nsmetry "$source_dir"
app_dir="$destination/share/nsmetry"
program="$app_dir/$program_name"

# The launcher entry names the program and its icon in full: launchers do not always have the bin folder on
# PATH, and the icon stays inside the app's folder.
entry_name=nsmetry.desktop
icon=
if [ -n "$entry" ]; then
  entry_name="${entry##*/}"
  icon_name="$(awk -F= '/^Icon=/ { print $2; exit }' "$entry")"
  for candidate in "$app_dir/$icon_name" "$app_dir/$icon_name.png" "$app_dir/$icon_name.svg"; do
    if [ -n "$icon_name" ] && [ -f "$candidate" ]; then icon="$candidate"; break; fi
  done
fi
if [ -z "$icon" ]; then icon="$(find "$app_dir" -maxdepth 1 \( -name '*.png' -o -name '*.svg' \) -type f | head -n 1)"; fi
escaped="$(printf '%s' "$program" | sed -e 's/[\\"`$]/\\\\&/g' -e 's/%/%%/g')"
if [ -n "$entry" ]; then
  NSMETRY_EXEC="Exec=\"$escaped\"" NSMETRY_ICON="$icon" awk '
    /^Exec=/ { print ENVIRON["NSMETRY_EXEC"]; next }
    /^TryExec=/ { next }
    /^Icon=/ { if (ENVIRON["NSMETRY_ICON"] != "") { print "Icon=" ENVIRON["NSMETRY_ICON"]; next } }
    { print }' "$entry" > "$work/entry.desktop"
else
  {
    printf '[Desktop Entry]\nType=Application\nName=NsMetry\nComment=Analytics for your apps and websites\n'
    printf 'Exec="%s"\n' "$escaped"
    if [ -n "$icon" ]; then printf 'Icon=%s\n' "$icon"; fi
    printf 'Categories=Development;Network;\nTerminal=false\n'
  } > "$work/entry.desktop"
fi
install -m644 "$work/entry.desktop" "$destination/share/applications/$entry_name"
if command -v update-desktop-database >/dev/null; then update-desktop-database "$destination/share/applications" >/dev/null 2>&1 || true; fi

# The command `nsmetry`: a small script that runs the program by its full path. A file the installer did
# not write stays.
command_state=skipped
if [ ! -e "$command_path" ] && [ ! -L "$command_path" ] || ours "$command_path"; then
  mkdir -p "$bin_dir"
  quoted="$(printf '%s' "$program" | sed "s/'/'\\\\''/g")"
  printf '#!/bin/sh\n%s\nexec '"'"'%s'"'"' "$@"\n' "$marker" "$quoted" > "$work/command"
  rm -f "$command_path"
  install -m755 "$work/command" "$command_path"
  command_state=installed
fi
printf 'Installed %s. Open NsMetry from your app launcher.\n' "$app_dir"
if [ "$command_state" = installed ]; then
  case ":${PATH:-}:" in
    *":$bin_dir:"*) printf 'Or run: nsmetry\n' ;;
    *) printf 'Or run: %s (add %s to PATH to run nsmetry)\n' "$program" "$bin_dir" ;;
  esac
else
  printf '%s is not from this installer, so it stays. Run: %s\n' "$command_path" "$program"
fi
printf '%s\n' 'Then type your instance address (for example stats.example.com) and sign in with the code it emails you.'
