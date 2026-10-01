param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [string]$UpgradeInstaller = "",
  [switch]$CheckExplicitQuit,
  [switch]$AllowElevatedDiagnostic
)

# Manual D13 acceptance for a machine with no existing 网申快填 install.
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
$installDir = Join-Path $env:LOCALAPPDATA "网申快填"
$userDataDir = Join-Path $env:LOCALAPPDATA "ResumePro"
$registrationKeys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.resumepro.desktop"
)

$principal = [Security.Principal.WindowsPrincipal]::new(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
$runningElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($runningElevated -and -not $AllowElevatedDiagnostic) {
  throw "Run this acceptance check from a non-elevated PowerShell session"
}

if (Test-Path -LiteralPath $installDir) {
  throw "Refusing to overwrite an existing installation: $installDir"
}
foreach ($key in $registrationKeys) {
  if (Test-Path $key) { throw "Refusing to overwrite an existing Native Messaging registration: $key" }
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
  foreach ($key in $registrationKeys) {
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
  return $registrationKeys
}

function Wait-NativeMessagingRegistration([string]$Executable) {
  $deadline = (Get-Date).AddSeconds(30)
  while ($true) {
    try {
      return Assert-NativeMessagingRegistration $Executable
    } catch {
      if ((Get-Date) -ge $deadline) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

$before = Get-ArchiveSnapshot
$testRoot = Join-Path $env:TEMP ("resumepro-d13-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$userDataExisted = Test-Path -LiteralPath $userDataDir
if (-not $userDataExisted) { New-Item -ItemType Directory -Path $userDataDir | Out-Null }
$sentinel = Join-Path $userDataDir ("d13-install-acceptance-" + [guid]::NewGuid().ToString("N") + ".sentinel")
New-Item -ItemType File -Path $sentinel | Out-Null
$oldOverride = $env:RESUMEPRO_DATA_DIR
$installedThisRun = $false
$app = $null

function Read-NativeBytes([IO.Stream]$Stream, [int]$Count, [DateTime]$Deadline) {
  $bytes = [byte[]]::new($Count)
  $offset = 0
  while ($offset -lt $Count) {
    $remaining = [int][Math]::Max(0, ($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remaining -eq 0) { throw "Native response read timed out" }
    $read = $Stream.ReadAsync($bytes, $offset, $Count - $offset)
    if (-not $read.Wait($remaining)) { throw "Native response read timed out" }
    if ($read.Result -eq 0) { throw "Native host closed an incomplete response frame" }
    $offset += $read.Result
  }
  return ,$bytes
}

function Invoke-NativeFrame([string]$Executable, [string]$Type, [hashtable]$Payload) {
  $request = @{
    protocolVersion = 2; messageId = [guid]::NewGuid().ToString()
    clientInstanceId = "11111111-1111-4111-8111-111111111111"
    messageType = $Type; occurredAt = [DateTime]::UtcNow.ToString("o"); payload = $Payload
  } | ConvertTo-Json -Depth 5 -Compress
  $process = [Diagnostics.Process]::new()
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.Arguments = "chrome-extension://diagjmploldedipjdenmecmjokckelkl/"
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardInput = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $started = $false
  try {
    $started = $process.Start()
    $errors = $process.StandardError.ReadToEndAsync()
    $bytes = [Text.Encoding]::UTF8.GetBytes($request)
    $length = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $process.StandardInput.BaseStream.Write($length, 0, 4)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
    # Read one length-prefixed frame, not EOF: a spawned GUI can inherit another
    # handle to the pipe and keep it open after the native host has already exited.
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $header = Read-NativeBytes $process.StandardOutput.BaseStream 4 $deadline
    $replyLength = [BitConverter]::ToUInt32($header, 0)
    if ($replyLength -eq 0 -or $replyLength -gt 1048576) { throw "Invalid native reply length" }
    $wire = Read-NativeBytes $process.StandardOutput.BaseStream $replyLength $deadline
    if (-not $process.WaitForExit(15000)) { throw "Native request $Type did not exit" }
    if ($process.ExitCode -ne 0) {
      $errorText = if ($errors.IsCompleted -and -not $errors.IsFaulted) { $errors.Result } else { "stderr still open" }
      throw "Native request $Type failed: $errorText"
    }
    return [Text.Encoding]::UTF8.GetString($wire) | ConvertFrom-Json
  } finally {
    if ($started -and -not $process.HasExited) { $process.Kill() }
    $process.Dispose()
  }
}

function Request-InstalledQuit([string]$Executable) {
  Write-Host "Explicit quit request"
  $forwarder = Start-Process -FilePath $Executable -ArgumentList "--quit" -PassThru -WindowStyle Hidden
  if (-not $forwarder.WaitForExit(15000)) {
    Stop-Process -Id $forwarder.Id -Force -ErrorAction SilentlyContinue
    throw "Quit forwarding process did not exit within 15 seconds"
  }
  # Forwarder exit only means the arguments were delivered. Callers separately
  # inspect the actual application process and persisted marker.
}

try {
  # The preflight above proves the install directory and registration keys were absent. From this
  # point on, any of them that appear belong to this attempt and are safe for finally to remove,
  # even when NSIS returns a non-zero exit code after writing partial state.
  Write-Host "Install candidate"
  $installedThisRun = $true
  $install = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }
  if (-not (Test-Path -LiteralPath $installDir)) { throw "Installer did not create $installDir" }

  $exe = Get-ChildItem -LiteralPath $installDir -Filter "*.exe" -File |
    Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "*uninstall*.exe" -File |
    Select-Object -First 1
  if (-not $exe -or -not $uninstaller) { throw "Installed executable or uninstaller is missing" }

  Write-Host "Launch installed candidate and wait for registration"
  $env:RESUMEPRO_DATA_DIR = $testRoot
  $app = Start-Process -FilePath $exe.FullName -ArgumentList "--hidden" -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
  if ($app.HasExited) {
    throw "Installed application exited before Native Messaging registration (exit $($app.ExitCode)); check packaged runtime dependencies"
  }
  $keys = Wait-NativeMessagingRegistration $exe.FullName

  Request-InstalledQuit $exe.FullName
  if (-not $app.HasExited) { $null = $app.WaitForExit(10000) }

  if ($CheckExplicitQuit) {
    if (-not $app.HasExited) { throw "Explicit quit did not terminate the installed application" }
    $marker = Join-Path $testRoot "explicit-quit"
    if (-not (Test-Path -LiteralPath $marker)) { throw "Explicit quit was not persisted" }
    Write-Host "Verify delayed hidden launch and stopped native hosts"
    $delayed = Start-Process -FilePath $exe.FullName -ArgumentList "--hidden" -PassThru -WindowStyle Hidden
    if (-not $delayed.WaitForExit(15000)) {
      Stop-Process -Id $delayed.Id -Force
      throw "A delayed hidden launch bypassed explicit quit"
    }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      $reply = Invoke-NativeFrame $exe.FullName "handshake" @{
        pluginVersion = "0.4.1"; minProtocolVersion = 2; maxProtocolVersion = 2
      }
      if ($reply.ok -or $reply.error.code -ne "unavailable" -or -not $reply.error.retryable) {
        throw "Background request did not preserve the stopped/retryable state"
      }
    }
    $running = @(Get-Process -Name "resume-pro-desktop" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $exe.FullName })
    if ($running.Count -ne 0) { throw "Background requests restarted the installed application" }
    Write-Host "Resume through explicit ui.open"
    $opened = Invoke-NativeFrame $exe.FullName "ui.open" @{ view = "resume" }
    if (-not $opened.ok -or -not $opened.payload.opened -or (Test-Path -LiteralPath $marker)) {
      throw "Explicit ui.open did not resume the installed application"
    }
    $app = Get-Process -Name "resume-pro-desktop" | Where-Object { $_.Path -eq $exe.FullName } | Select-Object -First 1
    if (-not $app) { throw "No desktop process after explicit open" }
    Request-InstalledQuit $exe.FullName
    if (-not $app.WaitForExit(10000)) { throw "Second explicit quit did not terminate the application" }
    Write-Host "Resume through a manual executable launch"
    # A shortcut launch has no --hidden argument and must resume as well.
    $app = Start-Process -FilePath $exe.FullName -PassThru
    $deadline = (Get-Date).AddSeconds(15)
    while ((Test-Path -LiteralPath $marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ((Test-Path -LiteralPath $marker) -or $app.HasExited) { throw "Manual launch did not resume" }
    Request-InstalledQuit $exe.FullName
    if (-not $app.WaitForExit(10000)) { throw "Final explicit quit did not terminate the application" }
    # Exercise setup's quit branch as well as the single-instance forwarding path.
    $quitAlone = Start-Process -FilePath $exe.FullName -ArgumentList "--quit" -PassThru -WindowStyle Hidden
    if (-not $quitAlone.WaitForExit(10000)) { throw "Quit without a running instance did not exit" }
    if ($quitAlone.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $marker)) {
      throw "Quit without a running instance did not preserve explicit quit"
    }
  }

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
    # An upgrade verification is a manual launch, even if the old version was quit.
    $app = Start-Process -FilePath $exe.FullName -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 500
    if ($app.HasExited) {
      throw "Upgraded application exited before Native Messaging registration (exit $($app.ExitCode)); check packaged runtime dependencies"
    }
    $keys = Wait-NativeMessagingRegistration $exe.FullName
    Request-InstalledQuit $exe.FullName
    if (-not $app.HasExited) { $null = $app.WaitForExit(10000) }
    $upgradeTested = $true
  }

  Write-Host "Uninstall candidate and verify preserved data"
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
  if ($upgradeTested) {
    if (-not (Test-Path -LiteralPath $upgradeSentinel)) {
      throw "Uninstall removed the active data attachment sentinel"
    }
    if ((Get-FileHash -LiteralPath $upgradeSentinel -Algorithm SHA256).Hash -ne $upgradeSentinelHash) {
      throw "Uninstall changed the active data attachment sentinel"
    }
  }
  if (-not (Test-Path -LiteralPath $sentinel)) { throw "Uninstall removed the user-data sentinel" }

  Assert-ArchiveUnchanged $before
  [pscustomobject]@{
    InstallerExit = $install.ExitCode
    InstalledExecutable = $exe.FullName
    ChromeAndEdgeRegistered = $true
    ExplicitQuitChecked = [bool]$CheckExplicitQuit
    UpgradeTested = $upgradeTested
    UpgradeAttachmentPreserved = if ($upgradeTested) { $true } else { $null }
    UninstallerExit = $uninstall.ExitCode
    InstallDirectoryRemoved = $true
    ArchiveFilesVerified = $before.Count
    ArchiveUnchanged = $true
    UserDataSentinelPreserved = $true
    RunningElevated = $runningElevated
    AcceptanceEligible = -not $runningElevated
    EvidencePurpose = if ($runningElevated) { "ELEVATED_DIAGNOSTIC" } else { "STANDARD_USER_ACCEPTANCE" }
  }
} finally {
  $env:RESUMEPRO_DATA_DIR = $oldOverride
  # The script refuses pre-existing installs, so an install directory created during this run is
  # always safe to remove through its own uninstaller. Failed registration/startup must not leave
  # a half-tested product installed on the machine.
  if ($installedThisRun) {
    # ui.open may have spawned a process before returning an error. This directory
    # was absent at preflight, so only this run's installed candidate can match it.
    Get-Process -Name "resume-pro-desktop" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and [IO.Path]::GetDirectoryName($_.Path) -eq $installDir } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    if ($app -and -not $app.HasExited) {
      Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $installDir) {
      try {
        $cleanupUninstaller = Get-ChildItem -LiteralPath $installDir -Filter "*uninstall*.exe" -File |
          Select-Object -First 1
        if ($cleanupUninstaller) {
          $cleanup = Start-Process -FilePath $cleanupUninstaller.FullName -ArgumentList "/S" `
            -Wait -PassThru -WindowStyle Hidden
          if ($cleanup.ExitCode -ne 0) {
            Write-Warning "Cleanup uninstaller exited with $($cleanup.ExitCode)"
          }
          $cleanupDeadline = (Get-Date).AddSeconds(20)
          while ((Test-Path -LiteralPath $installDir) -and (Get-Date) -lt $cleanupDeadline) {
            Start-Sleep -Milliseconds 250
          }
        }
      } catch {
        Write-Warning "Cleanup uninstaller failed: $($_.Exception.Message)"
      }
    }
    foreach ($key in $registrationKeys) {
      if (Test-Path $key) {
        try {
          Remove-Item -Path $key -Recurse -Force
        } catch {
          Write-Warning "Failed to remove registration created by this run ($key): $($_.Exception.Message)"
        }
      }
    }
    if (Test-Path -LiteralPath $installDir) {
      try {
        $resolvedInstallDir = (Resolve-Path -LiteralPath $installDir).Path
        $expectedInstallDir = [IO.Path]::GetFullPath($installDir)
        if ($resolvedInstallDir -ne $expectedInstallDir) {
          throw "Unsafe install cleanup target: $resolvedInstallDir"
        }
        Remove-Item -LiteralPath $resolvedInstallDir -Recurse -Force
      } catch {
        Write-Warning "Failed to remove install directory created by this run: $($_.Exception.Message)"
      }
    }
  }
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
  if (-not $userDataExisted -and (Test-Path -LiteralPath $userDataDir)) {
    $resolvedUserData = (Resolve-Path -LiteralPath $userDataDir).Path
    $expectedUserData = [IO.Path]::GetFullPath($userDataDir)
    $empty = -not (Get-ChildItem -LiteralPath $resolvedUserData -Force | Select-Object -First 1)
    if ($resolvedUserData -eq $expectedUserData -and $empty) {
      Remove-Item -LiteralPath $resolvedUserData -Force
    }
  }
}
