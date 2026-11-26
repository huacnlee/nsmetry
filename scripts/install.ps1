# Install the NsMetry desktop app from a GitHub release, for the current Windows user. No administrator
# access is necessary.
#
#   irm https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.ps1 | iex
#
# The download is checked against the release's sha256sums before anything is installed. The app goes to
# %LOCALAPPDATA%\Programs\NsMetry with a Start menu shortcut. macOS and Linux: scripts/install.sh.
[CmdletBinding()]
param(
    [string]$Version = $(if ($env:NSMETRY_VERSION) { $env:NSMETRY_VERSION } else { 'latest' }),
    [string]$InstallDir = $(if ($env:NSMETRY_INSTALL_DIR) { $env:NSMETRY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\NsMetry' }),
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows. Use install.sh on macOS or Linux.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'NsMetry.lnk'

if ($Uninstall) {
    if (Test-Path -LiteralPath $InstallDir) {
        try { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
        catch { throw "Could not remove $InstallDir. Close NsMetry, then run the uninstall again." }
    }
    Remove-Item -LiteralPath $startMenu -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $InstallDir and the Start menu shortcut. Your instance and its data are not affected."
    return
}

$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') {
    throw "Releases have a Windows x86_64 build only (this is $architecture). Open the web app at your instance address instead."
}
$asset = 'nsmetry-windows-x86_64.zip'
$repository = 'https://github.com/huacnlee/nsmetry'
# Resolve "latest" to a tag first, so the archive and sha256sums come from the same release.
if ($Version -eq 'latest') {
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/huacnlee/nsmetry/releases/latest'
    $Version = $release.tag_name
}
$Version = $Version -replace '^v', ''
if ($Version -notmatch '^\d+\.\d+\.\d+([.-][A-Za-z0-9.-]+)?$') { throw 'Version must be a release version such as 0.4.0 or v0.4.0.' }
$base = "$repository/releases/download/v$Version"
$parent = Split-Path -Parent $InstallDir
$work = Join-Path ([IO.Path]::GetTempPath()) ('nsmetry-install-' + [Guid]::NewGuid().ToString('N'))
$staged = Join-Path $parent ('.nsmetry-install-' + [Guid]::NewGuid().ToString('N'))
$previous = "$staged-previous"
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Write-Host "Downloading NsMetry $Version for Windows..."
    $archive = Join-Path $work $asset
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive
    } catch {
        throw "Release v$Version has no $asset."
    }
    $checksums = Join-Path $work 'sha256sums'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/sha256sums" -OutFile $checksums
    } catch {
        throw "Release v$Version has no sha256sums."
    }
    $expected = @(Get-Content $checksums | ForEach-Object {
        if ($_ -match '^([a-fA-F0-9]{64})\s+\*?(.+)$' -and $Matches[2] -ceq $asset) { $Matches[1] }
    })
    if ($expected.Count -ne 1) { throw "Missing or ambiguous checksum for $asset" }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ine $expected[0]) { throw 'Checksum verification failed. The installer installed nothing.' }
    $unpacked = Join-Path $work 'unpacked'
    # Expand-Archive refuses entries that go outside the destination folder.
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    # The archive holds one folder, the app (NsMetry.exe and its files); take its contents.
    $top = @(Get-ChildItem -LiteralPath $unpacked -Force)
    if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $unpacked = $top[0].FullName }
    if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'NsMetry.exe') -PathType Leaf)) { throw 'Release archive is missing NsMetry.exe.' }
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    # Replace the folder as one unit, so no file of the old version stays. Windows refuses to move the folder
    # while NsMetry runs.
    Copy-Item -LiteralPath $unpacked -Destination $staged -Recurse
    if (Test-Path -LiteralPath $InstallDir) {
        try { Move-Item -LiteralPath $InstallDir -Destination $previous }
        catch { throw "Could not replace $InstallDir. Close NsMetry, then run the installer again." }
    }
    try {
        Move-Item -LiteralPath $staged -Destination $InstallDir
    } catch {
        if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $InstallDir }
        throw "Could not replace $InstallDir."
    }
    $exe = Join-Path $InstallDir 'NsMetry.exe'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startMenu)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.IconLocation = "$exe,0"
    $shortcut.Save()
    Write-Host "Installed $InstallDir. Open NsMetry from the Start menu."
    Write-Host 'Then type your instance address (for example stats.example.com) and sign in with the code it emails you.'
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
    # Keep the previous version when the new one is not in place.
    if (Test-Path -LiteralPath (Join-Path $InstallDir 'NsMetry.exe')) {
        Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
    }
}
