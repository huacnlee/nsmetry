# Install the NsMetry app

NsMetry is one app on every screen. On the web there is nothing to install: open your instance's
address (for example `https://stats.example.com`) in a browser. The desktop and mobile apps are on
the [releases page](https://github.com/huacnlee/nsmetry/releases).

In every app you type your instance's address once, then sign in with the code it emails you, as on
the web. Typing `demo` as the address, or pressing **Try the demo**, opens a demo that runs on your
device with made-up traffic.

Release builds are for:

- macOS on Apple silicon.
- Windows x86_64.
- Linux x86_64 (GTK 4).
- Android, and iOS by sideloading.

On anything else, use the web app.

## macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.sh | sh
```

The installer downloads the release, checks it against the release's `sha256sums`, and installs
nothing if the check fails. It runs as the current user and needs no `sudo`. Give options after
`sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.sh | sh -s -- --version 0.4.0 --dir ~/opt
```

| Option | Variable | Default |
| --- | --- | --- |
| `--version VERSION` | `NSMETRY_VERSION` | the latest release |
| `--dir DIRECTORY` | `NSMETRY_INSTALL_DIR` | macOS: `/Applications`, or `~/Applications` when that is not writable. Linux: the prefix `~/.local` |
| `--bin-dir DIRECTORY` | `NSMETRY_BIN_DIR` | `~/.local/bin` (Linux only) |
| `--uninstall` | | |

Pin a version when your instance runs an older release than the latest; the app and the instance
are released together. Your instance's version is under **Settings › This instance**.

### What the installer puts on macOS

- `NsMetry.app` in the folder. Open it from Launchpad or Finder.

The app has an ad hoc signature: it is not signed with a Developer ID or notarized by Apple. `curl`
does not mark the download as quarantined, so the installed app opens normally. If you download
`nsmetry-macos-arm64.zip` with a browser instead, macOS refuses it the first time: right-click the
app, choose **Open**, then **Open** again (on recent macOS: **System Settings › Privacy & Security ›
Open Anyway**). Or clear the quarantine flag yourself:

```sh
xattr -dr com.apple.quarantine /Applications/NsMetry.app
```

### What the installer puts on Linux

`--dir` is a prefix. With the default `~/.local`:

- `~/.local/share/nsmetry/`: the app. Keep the folder whole.
- `~/.local/share/applications/`: its entry for the app launcher, naming the program and its icon
  by their full paths.
- `~/.local/bin/nsmetry`: a two-line script that starts the app. A `nsmetry` there that the
  installer did not write stays as it is.

With another prefix, put its `share` folder on `XDG_DATA_DIRS` so that launchers find the entry.
The app needs GTK 4 from your distribution. The installer does not change your package manager or
your shell configuration.

## Windows

```powershell
irm https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.ps1 | iex
```

To give options, download the script and run it:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.ps1 -OutFile "$env:TEMP\nsmetry-install.ps1"
& "$env:TEMP\nsmetry-install.ps1" -Version 0.4.0 -InstallDir "$env:LOCALAPPDATA\Programs\NsMetry"
```

`NSMETRY_VERSION` and `NSMETRY_INSTALL_DIR` set the same defaults. The default folder is
`%LOCALAPPDATA%\Programs\NsMetry`. The installer checks the download against `sha256sums`, replaces
the folder as one unit and adds a Start menu shortcut. It needs no administrator access and does
not change `PATH`.

If the PowerShell execution policy stops scripts, download `nsmetry-windows-x86_64.zip` from the
release page and extract it anywhere; run `NsMetry.exe`. Windows SmartScreen may warn the first
time, because the app is not code-signed: **More info › Run anyway**.

## Android and iOS

From the [latest release](https://github.com/huacnlee/nsmetry/releases/latest):

- **Android**: download `nsmetry-android.apk` on the phone and open it. Android asks once to allow
  installs from your browser.
- **iOS**: `nsmetry-ios-unsigned.ipa` is unsigned. Sign and install it with your own Apple ID using
  a sideloading tool such as [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io).
  A free Apple ID's signature lasts seven days, then the tool re-signs it.
- **iOS Simulator** (for a Mac with Xcode): unzip `nsmetry-ios-simulator.zip`, then
  `xcrun simctl install booted NsMetry.app`.

Or skip the install: the web app at your instance's address works in the phone's browser.

## Upgrade

Close NsMetry and run the installer again. It replaces the app as one unit; when the new copy
cannot be put in place, the old one stays. The web app updates itself whenever your instance is
updated.

## Checking a download by hand

Every release has a `sha256sums` file covering every asset:

```sh
shasum -a 256 -c sha256sums --ignore-missing          # macOS
sha256sum -c sha256sums --ignore-missing              # Linux
```

```powershell
(Get-FileHash nsmetry-windows-x86_64.zip -Algorithm SHA256).Hash   # compare with sha256sums
```

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.sh | sh -s -- --uninstall
```

Give the same `--dir` and `--bin-dir` you installed with. On Windows, run the downloaded script with
`-Uninstall` (and the same `-InstallDir`), or delete `%LOCALAPPDATA%\Programs\NsMetry` and the
NsMetry Start menu shortcut. On a phone, remove the app as any other.

Removing an app signs nothing out on the server and deletes no data: your instance keeps every
number. To end that device's session, remove it from the instance (see
[POST-DEPLOY.md](../POST-DEPLOY.md#2-know-how-to-cut-access-off)) or sign out in the app first.
