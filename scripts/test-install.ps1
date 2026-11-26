# Test install.ps1 with local release fixtures. The test mocks the downloads and the Start menu shortcut, so it
# never changes the real system. Run it on Windows: pwsh -File scripts/test-install.ps1
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run these installer tests on Windows.' }
$installer = Join-Path $PSScriptRoot 'install.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nsmetry-installer-test-' + [Guid]::NewGuid().ToString('N'))
$oldArchitecture = $env:PROCESSOR_ARCHITECTURE
$oldWowArchitecture = $env:PROCESSOR_ARCHITEW6432
# The mocks run in the child scope of the installer. They change one shared object, because a new $script:
# variable in that scope is not visible here.
$installerTestState = [PSCustomObject]@{
    ShortcutSaved = $null
    LatestCalls = 0
    DownloadCalls = 0
    Release = 'v0.4.0'
}

function Invoke-RestMethod {
    param([string]$Uri)
    if ($Uri -ne 'https://api.github.com/repos/huacnlee/nsmetry/releases/latest') { throw "Unexpected API request: $Uri" }
    $installerTestState.LatestCalls++
    return @{ tag_name = 'v0.4.0' }
}

function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    $prefix = 'https://github.com/huacnlee/nsmetry/releases/download/'
    if (-not $Uri.StartsWith($prefix)) { throw "Unexpected download: $Uri" }
    $installerTestState.DownloadCalls++
    if (-not $Uri.StartsWith($prefix + $installerTestState.Release + '/')) { throw "404: $Uri" }
    $file = Join-Path $testRoot ($Uri.Split('/')[-1])
    if (-not (Test-Path -LiteralPath $file)) { throw "404: $Uri" }
    Copy-Item -LiteralPath $file -Destination $OutFile
}

function New-Object {
    [CmdletBinding(DefaultParameterSetName = 'Net')]
    param(
        [Parameter(Mandatory, Position = 0, ParameterSetName = 'Net')][string]$TypeName,
        [Parameter(Position = 1, ParameterSetName = 'Net')][object[]]$ArgumentList,
        [Parameter(Mandatory, ParameterSetName = 'Com')][string]$ComObject,
        [System.Collections.IDictionary]$Property,
        [switch]$Strict
    )
    # The archive module can also make ordinary .NET objects when it loads.
    if ($PSCmdlet.ParameterSetName -eq 'Net') {
        return Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
    }
    if ($ComObject -ne 'WScript.Shell') { throw "Unexpected COM object: $ComObject" }
    $shell = [PSCustomObject]@{}
    $shell | Add-Member -MemberType ScriptMethod -Name CreateShortcut -Value {
        param($Path)
        $shortcut = [PSCustomObject]@{ Path = $Path; TargetPath = ''; WorkingDirectory = ''; IconLocation = '' }
        $shortcut | Add-Member -MemberType ScriptMethod -Name Save -Value { $installerTestState.ShortcutSaved = $this }
        return $shortcut
    }
    return $shell
}

function Assert-True($Condition, $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Fails($Action, $Message) {
    $failure = $null
    try { & $Action } catch { $failure = $_.Exception.Message }
    Assert-True ($null -ne $failure -and $failure.Contains($Message)) "Expected '$Message', received '$failure'"
}

# The archive holds one folder, NsMetry\, as `nsh package --target windows` writes it.
function Write-Release {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    Compress-Archive -Path $payload -DestinationPath $archive
    $digest = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $other = '0' * 64
    Set-Content -LiteralPath (Join-Path $testRoot 'sha256sums') -Value @("$digest  $asset", "$other  nsmetry-web.tar.gz") -Encoding ascii
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = $null
    $payload = Join-Path $testRoot 'NsMetry'
    New-Item -ItemType Directory -Path (Join-Path $payload 'nsh') | Out-Null
    Set-Content -LiteralPath (Join-Path $payload 'NsMetry.exe') -Value 'fixture executable v1'
    Set-Content -LiteralPath (Join-Path $payload 'nsh\bundle.nshc') -Value 'fixture bytecode'
    $asset = 'nsmetry-windows-x86_64.zip'
    $archive = Join-Path $testRoot $asset
    Write-Release
    $destination = Join-Path $testRoot 'install with spaces\NsMetry'
    $exe = Join-Path $destination 'NsMetry.exe'

    & $installer -InstallDir $destination
    Assert-True ($installerTestState.LatestCalls -eq 1) 'latest release lookup'
    Assert-True ($installerTestState.DownloadCalls -eq 2) 'archive and checksum downloads'
    Assert-True (Test-Path -LiteralPath $exe) 'executable installed from the archive folder'
    Assert-True (Test-Path -LiteralPath (Join-Path $destination 'nsh\bundle.nshc')) 'interface bundle next to the executable'
    Assert-True ($installerTestState.ShortcutSaved.TargetPath -eq $exe) 'shortcut targets the installed executable'
    Assert-True ($installerTestState.ShortcutSaved.WorkingDirectory -eq $destination) 'shortcut working directory'
    Assert-True (@(Get-ChildItem -LiteralPath (Split-Path $destination -Parent) -Force).Count -eq 1) 'no staging folders stay'
    Write-Host 'PASS latest release installation and shortcut'

    Set-Content -LiteralPath $exe -Value 'old executable'
    Set-Content -LiteralPath (Join-Path $destination 'nsh\old.nshc') -Value 'stale file'
    & $installer -Version v0.4.0 -InstallDir $destination
    Assert-True ($installerTestState.LatestCalls -eq 1) 'explicit version avoids latest lookup'
    Assert-True ((Get-Content $exe) -eq 'fixture executable v1') 'upgrade replaces executable'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $destination 'nsh\old.nshc'))) 'upgrade removes stale files'
    Write-Host 'PASS explicit version upgrade'

    $env:NSMETRY_VERSION = '0.4.0'
    $env:NSMETRY_INSTALL_DIR = Join-Path $testRoot 'from environment'
    & $installer
    Assert-True (Test-Path -LiteralPath (Join-Path $env:NSMETRY_INSTALL_DIR 'NsMetry.exe')) 'NSMETRY_INSTALL_DIR selects the folder'
    Assert-True ($installerTestState.LatestCalls -eq 1) 'NSMETRY_VERSION avoids latest lookup'
    Remove-Item Env:\NSMETRY_VERSION, Env:\NSMETRY_INSTALL_DIR
    Write-Host 'PASS environment overrides'

    $before = Get-Content $exe
    Set-Content -LiteralPath (Join-Path $testRoot 'sha256sums') -Value ((('0' * 64) + "  $asset")) -Encoding ascii
    Assert-Fails { & $installer -Version 0.4.0 -InstallDir $destination } 'Checksum verification failed'
    Assert-True ((Get-Content $exe) -eq $before) 'failed verification keeps the installed version'
    Write-Host 'PASS checksum rejection keeps the installation'

    Write-Release
    Add-Content -LiteralPath (Join-Path $testRoot 'sha256sums') -Value (Get-Content (Join-Path $testRoot 'sha256sums'))
    Assert-Fails { & $installer -Version 0.4.0 -InstallDir $destination } 'Missing or ambiguous checksum'
    Write-Host 'PASS duplicate checksum rejection'

    Write-Release
    Assert-Fails { & $installer -Version 0.3.0 -InstallDir $destination } 'Release v0.3.0 has no'
    Write-Host 'PASS release without the asset'

    $downloadsBefore = $installerTestState.DownloadCalls
    Assert-Fails { & $installer -Version '../bad' -InstallDir $destination } 'Version must be'
    $env:PROCESSOR_ARCHITECTURE = 'ARM64'
    Assert-Fails { & $installer -Version 0.4.0 -InstallDir $destination } 'x86_64 build only'
    Assert-True ($installerTestState.DownloadCalls -eq $downloadsBefore) 'invalid input avoids downloads'
    Write-Host 'PASS invalid version and unsupported architecture'

    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    Remove-Item -LiteralPath (Join-Path $payload 'NsMetry.exe')
    Write-Release
    Assert-Fails { & $installer -Version 0.4.0 -InstallDir $destination } 'missing NsMetry.exe'
    Assert-True ((Get-Content $exe) -eq $before) 'an incomplete release keeps the installed version'
    Write-Host 'PASS incomplete release rejection'
    # -Uninstall is not run here: it removes the real Start menu shortcut.
} finally {
    $env:PROCESSOR_ARCHITECTURE = $oldArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $oldWowArchitecture
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
