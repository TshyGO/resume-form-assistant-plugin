param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [string]$UpgradeInstaller = ""
)

# Manual D13 acceptance for a machine with no existing Resume Pro Desktop install.
# Run from a non-elevated PowerShell session. The script refuses to overwrite an
# installed copy, isolates application data, and verifies the real user archive
# plus a disposable sentinel survive silent install/uninstall.

$ErrorActionPreference = "Stop"
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$upgradeInstallerPath = if ($UpgradeInstaller) {
  (Resolve-Path -LiteralPath $UpgradeInstaller).Path
} else {
  $null
}
$installDir = Join-Path $env:LOCALAPPDATA "Resume Pro Desktop"
$userDataDir = Join-Path $env:LOCALAPPDATA "ResumePro"

if (Test-Path -LiteralPath $installDir) {
  throw "Refusing to overwrite an existing installation: $installDir"
}

function Get-ArchiveSnapshot {
  $roots = @(
    (Join-Path $userDataDir "archive"),
    (Join-Path $userDataDir "archives-retired")
  ) | Where-Object { Test-Path -LiteralPath $_ }
  $snapshot = @{}
  foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
      $snapshot[$_.FullName] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  }
  return $snapshot
}

function Assert-ArchiveUnchanged([hashtable]$Before) {
  $after = Get-ArchiveSnapshot
  if ($Before.Count -ne $after.Count) {
    throw "Archive file count changed: $($Before.Count) -> $($after.Count)"
  }
  foreach ($path in $Before.Keys) {
    if (-not $after.ContainsKey($path) -or $after[$path] -ne $Before[$path]) {
      throw "Archive changed during install acceptance: $path"
    }
  }
}

function Assert-NativeMessagingRegistration([string]$Executable) {
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.resumepro.desktop"
  )
  foreach ($key in $keys) {
    if (-not (Test-Path $key)) { throw "Missing registration: $key" }
    $manifest = Get-ItemPropertyValue -Path $key -Name "(default)"
    if (-not (Test-Path -LiteralPath $manifest)) { throw "Missing host manifest: $manifest" }
    $payload = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($payload.path -ne $Executable) {
      throw "Manifest points at $($payload.path), expected $Executable"
    }
    if (@($payload.allowed_origins).Count -ne 1 -or
        $payload.allowed_origins[0] -ne "chrome-extension://diagjmploldedipjdenmecmjokckelkl/") {
      throw "Manifest allowed_origins does not contain exactly the store extension"
    }
  }
  return $keys
}

$before = Get-ArchiveSnapshot
$testRoot = Join-Path $env:TEMP ("resumepro-d13-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$sentinel = Join-Path $userDataDir ("d13-install-acceptance-" + [guid]::NewGuid().ToString("N") + ".sentinel")
New-Item -ItemType File -Path $sentinel | Out-Null
$oldOverride = $env:RESUMEPRO_DATA_DIR

try {
  $install = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }
  if (-not (Test-Path -LiteralPath $installDir)) { throw "Installer did not create $installDir" }

  $exe = Get-ChildItem -LiteralPath $installDir -Filter "*.exe" -File |
    Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "*uninstall*.exe" -File |
    Select-Object -First 1
  if (-not $exe -or -not $uninstaller) { throw "Installed executable or uninstaller is missing" }

  $env:RESUMEPRO_DATA_DIR = $testRoot
  $app = Start-Process -FilePath $exe.FullName -ArgumentList "--hidden" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 6
  $keys = Assert-NativeMessagingRegistration $exe.FullName

  $null = Start-Process -FilePath $exe.FullName -ArgumentList "--quit" -Wait -PassThru -WindowStyle Hidden
  if (-not $app.HasExited) { $null = $app.WaitForExit(10000) }

  $upgradeTested = $false
  $upgradeSentinelHash = $null
  if ($upgradeInstallerPath) {
    $attachmentDir = Join-Path $testRoot "attachments"
    New-Item -ItemType Directory -Path $attachmentDir -Force | Out-Null
    $upgradeSentinel = Join-Path $attachmentDir "upgrade-sentinel.bin"
    [IO.File]::WriteAllBytes($upgradeSentinel, [Text.Encoding]::UTF8.GetBytes("resume-pro-d13-upgrade"))
    $upgradeSentinelHash = (Get-FileHash -LiteralPath $upgradeSentinel -Algorithm SHA256).Hash

    $upgrade = Start-Process -FilePath $upgradeInstallerPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
    if ($upgrade.ExitCode -ne 0) { throw "Upgrade installer exited with $($upgrade.ExitCode)" }
    if (-not (Test-Path -LiteralPath $upgradeSentinel)) { throw "Upgrade removed the attachment sentinel" }
    if ((Get-FileHash -LiteralPath $upgradeSentinel -Algorithm SHA256).Hash -ne $upgradeSentinelHash) {
      throw "Upgrade changed the attachment sentinel"
    }

    $exe = Get-ChildItem -LiteralPath $installDir -Filter "*.exe" -File |
      Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
    $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "*uninstall*.exe" -File |
      Select-Object -First 1
    $app = Start-Process -FilePath $exe.FullName -ArgumentList "--hidden" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 6
    $keys = Assert-NativeMessagingRegistration $exe.FullName
    $null = Start-Process -FilePath $exe.FullName -ArgumentList "--quit" -Wait -PassThru -WindowStyle Hidden
    if (-not $app.HasExited) { $null = $app.WaitForExit(10000) }
    $upgradeTested = $true
  }

  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Test-Path -LiteralPath $installDir) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $installDir) { throw "Install directory remained after uninstall" }
  foreach ($key in $keys) {
    if (Test-Path $key) { throw "Registration remained after uninstall: $key" }
  }
  if (-not (Test-Path -LiteralPath $sentinel)) { throw "Uninstall removed the user-data sentinel" }

  Assert-ArchiveUnchanged $before
  [pscustomobject]@{
    InstallerExit = $install.ExitCode
    InstalledExecutable = $exe.FullName
    ChromeAndEdgeRegistered = $true
    UpgradeTested = $upgradeTested
    UpgradeAttachmentPreserved = if ($upgradeTested) { $true } else { $null }
    UninstallerExit = $uninstall.ExitCode
    InstallDirectoryRemoved = $true
    ArchiveFilesVerified = $before.Count
    ArchiveUnchanged = $true
    UserDataSentinelPreserved = $true
    IntegrityLevel = (whoami /groups | Select-String "Mandatory Label").Line.Trim()
  }
} finally {
  $env:RESUMEPRO_DATA_DIR = $oldOverride
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = (Resolve-Path -LiteralPath $testRoot).Path
    $tempResolved = (Resolve-Path -LiteralPath $env:TEMP).Path
    $safePrefix = $resolved.StartsWith($tempResolved, [System.StringComparison]::OrdinalIgnoreCase)
    $safeName = [IO.Path]::GetFileName($resolved) -like "resumepro-d13-install-*"
    if (-not $safePrefix -or -not $safeName) { throw "Unsafe cleanup target: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  if (Test-Path -LiteralPath $sentinel) {
    $resolvedSentinel = (Resolve-Path -LiteralPath $sentinel).Path
    $resolvedUserData = (Resolve-Path -LiteralPath $userDataDir).Path
    $safeParent = [IO.Path]::GetDirectoryName($resolvedSentinel) -eq $resolvedUserData
    $safeName = [IO.Path]::GetFileName($resolvedSentinel) -like "d13-install-acceptance-*.sentinel"
    if (-not $safeParent -or -not $safeName) { throw "Unsafe sentinel cleanup target: $resolvedSentinel" }
    Remove-Item -LiteralPath $resolvedSentinel -Force
  }
}
