#requires -Version 5.1

[CmdletBinding()]
param(
  [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Sha256Pattern = "^[a-fA-F0-9]{64}$"
$StartupTimeoutSeconds = 30

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path)
}

function Test-PathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Candidate
  )
  $parentPath = (Resolve-FullPath $Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $candidatePath = Resolve-FullPath $Candidate
  return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
    $candidatePath.StartsWith(
      $parentPath + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-NoReparseComponents {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $current = Resolve-FullPath $Path
  while (-not (Test-Path -LiteralPath $current)) {
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
      throw "$Label has no existing filesystem ancestor: $Path"
    }
    $current = $parent
  }
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not pass through a reparse point: $current"
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
      break
    }
    $current = $parent
  }
}

function Assert-RegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label does not exist: $Path"
  }
  Assert-NoReparseComponents -Path $Path -Label $Label
}

function Assert-RegularDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label does not exist: $Path"
  }
  Assert-NoReparseComponents -Path $Path -Label $Label
}

function Get-RequiredProperty {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    throw "$Label is missing required property '$Name'."
  }
  return $property.Value
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Cannot read $Label $Path`: $($_.Exception.Message)"
  }
}

function Write-JsonAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $directory = Split-Path -Parent $Path
  Assert-NoReparseComponents -Path $directory -Label "Deployment state directory"
  $temporary = Join-Path $directory (".startup-" + [guid]::NewGuid().ToString("N") + ".tmp")
  try {
    $encoding = New-Object Text.UTF8Encoding($false)
    $content = ($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine
    [IO.File]::WriteAllText($temporary, $content, $encoding)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Test-ProcessAlive {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-LiveBridgeOwner {
  param([Parameter(Mandatory = $true)][string]$DataDirectory)
  $lockPath = Join-Path $DataDirectory "bridge.lock"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    return $null
  }
  try {
    $owner = Read-JsonFile -Path $lockPath -Label "bridge instance lock"
    $ownerPid = Get-RequiredProperty -Value $owner -Name "pid" -Label "Bridge instance lock"
    if ($ownerPid -isnot [int] -and $ownerPid -isnot [long]) {
      return $null
    }
    $ownerPid = [int]$ownerPid
    if ($ownerPid -le 0 -or -not (Test-ProcessAlive -ProcessId $ownerPid)) {
      return $null
    }
    return $owner
  } catch {
    return $null
  }
}

function Enter-DeploymentLock {
  param([Parameter(Mandatory = $true)][string]$DataDirectory)
  $lockPath = Join-Path $DataDirectory "deployment.lock"
  $token = [guid]::NewGuid().ToString("N")
  for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
    $stream = $null
    try {
      $stream = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
      )
      $payload = [ordered]@{
        pid = $PID
        token = $token
        startedAt = [DateTime]::UtcNow.ToString("o")
      } | ConvertTo-Json -Compress
      $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($payload + [Environment]::NewLine)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
      return [pscustomobject]@{ Path = $lockPath; Token = $token }
    } catch [IO.IOException] {
      if ($attempt -gt 0) {
        throw "Another deployment or startup operation owns $lockPath."
      }
      $owner = $null
      try {
        $owner = Read-JsonFile -Path $lockPath -Label "deployment lock"
      } catch {
        # A malformed lock is only stale after the acquisition grace period.
      }
      $ownerPid = $null
      if ($null -ne $owner) {
        $property = $owner.PSObject.Properties["pid"]
        if ($null -ne $property -and ($property.Value -is [int] -or $property.Value -is [long])) {
          $ownerPid = [int]$property.Value
        }
      }
      if ($null -ne $ownerPid -and $ownerPid -gt 0 -and
        (Test-ProcessAlive -ProcessId $ownerPid)) {
        throw "Another deployment or startup operation is running (pid=$ownerPid)."
      }
      $metadata = Get-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
      if ($null -ne $metadata -and
        ([DateTime]::UtcNow - $metadata.LastWriteTimeUtc).TotalSeconds -lt 10) {
        throw "Another deployment or startup operation is acquiring the deployment lock."
      }
      Remove-Item -LiteralPath $lockPath -Force
    } finally {
      if ($null -ne $stream) {
        $stream.Dispose()
      }
    }
  }
  throw "Unable to acquire the deployment lock."
}

function Exit-DeploymentLock {
  param([Parameter(Mandatory = $true)]$Lock)
  try {
    $owner = Read-JsonFile -Path $Lock.Path -Label "deployment lock"
    $ownerPid = Get-RequiredProperty -Value $owner -Name "pid" -Label "Deployment lock"
    $ownerToken = Get-RequiredProperty -Value $owner -Name "token" -Label "Deployment lock"
    if ([int]$ownerPid -eq $PID -and [string]$ownerToken -eq $Lock.Token) {
      Remove-Item -LiteralPath $Lock.Path -Force
    }
  } catch {
    if (Test-Path -LiteralPath $Lock.Path) {
      throw
    }
  }
}

function Read-ActiveTarget {
  param([Parameter(Mandatory = $true)][string]$DataDirectory)
  $statePath = Join-Path $DataDirectory "deployment-state.json"
  Assert-RegularFile -Path $statePath -Label "Deployment state"
  $state = Read-JsonFile -Path $statePath -Label "deployment state"
  $version = Get-RequiredProperty -Value $state -Name "version" -Label "Deployment state"
  if ([int]$version -ne 1) {
    throw "Deployment state version must be 1."
  }
  $active = Get-RequiredProperty -Value $state -Name "active" -Label "Deployment state"
  if ($null -eq $active -or $active -is [string] -or $active -is [array]) {
    throw "Deployment state active target is invalid."
  }

  $runtimeValue = Get-RequiredProperty -Value $active -Name "runtimeDirectory" -Label "Active target"
  $bootstrapValue = Get-RequiredProperty -Value $active -Name "bootstrapPath" -Label "Active target"
  $manifestSha256 = Get-RequiredProperty -Value $active -Name "manifestSha256" -Label "Active target"
  $bootstrapSha256 = Get-RequiredProperty -Value $active -Name "bootstrapSha256" -Label "Active target"
  if ($runtimeValue -isnot [string] -or -not [IO.Path]::IsPathRooted($runtimeValue) -or
    $bootstrapValue -isnot [string] -or -not [IO.Path]::IsPathRooted($bootstrapValue)) {
    throw "Active runtime and bootstrap paths must be absolute."
  }
  if ($manifestSha256 -isnot [string] -or $manifestSha256 -notmatch $Sha256Pattern -or
    $bootstrapSha256 -isnot [string] -or $bootstrapSha256 -notmatch $Sha256Pattern) {
    throw "Active runtime digest metadata is invalid."
  }

  $runtimeDirectory = Resolve-FullPath $runtimeValue
  $bootstrapPath = Resolve-FullPath $bootstrapValue
  $runtimeRoot = Join-Path $DataDirectory "runtime"
  $bootstrapRoot = Join-Path $DataDirectory "bootstrap"
  if ($runtimeDirectory.Equals((Resolve-FullPath $runtimeRoot), [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-PathWithin -Parent $runtimeRoot -Candidate $runtimeDirectory)) {
    throw "Active runtime escaped the managed runtime directory."
  }
  if (-not (Test-PathWithin -Parent $bootstrapRoot -Candidate $bootstrapPath)) {
    throw "Active bootstrap escaped the managed bootstrap directory."
  }
  Assert-RegularDirectory -Path $runtimeDirectory -Label "Active runtime"
  Assert-RegularFile -Path $bootstrapPath -Label "Active runtime bootstrap"

  $actualBootstrapSha256 = (Get-FileHash -LiteralPath $bootstrapPath -Algorithm SHA256).Hash
  if (-not $actualBootstrapSha256.Equals(
    $bootstrapSha256,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Active runtime bootstrap hash mismatch."
  }

  return [pscustomobject]@{
    StatePath = $statePath
    State = $state
    Active = $active
    RuntimeDirectory = $runtimeDirectory
    BootstrapPath = $bootstrapPath
    ManifestSha256 = $manifestSha256.ToLowerInvariant()
    BootstrapSha256 = $bootstrapSha256.ToLowerInvariant()
  }
}

function ConvertTo-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
      }
      [void]$builder.Append('\')
      [void]$builder.Append([char]34)
    } else {
      if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * $backslashes))
      }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append(('\' * ($backslashes * 2)))
  }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function Start-ActiveRuntimeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$NodeCommand,
    [Parameter(Mandatory = $true)]$Target
  )
  $configPath = Join-Path $Target.RuntimeDirectory "bridge.config.json"
  $arguments = @(
    $Target.BootstrapPath,
    "--runtime",
    $Target.RuntimeDirectory,
    "--manifest-sha256",
    $Target.ManifestSha256,
    "--",
    "start",
    "--config",
    $configPath
  )
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodeCommand
  $startInfo.Arguments = (($arguments | ForEach-Object {
    ConvertTo-NativeArgument -Value $_
  }) -join " ")
  $startInfo.WorkingDirectory = $Target.RuntimeDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Failed to start the active runtime process."
  }
  return $process
}

function Wait-ForBridgeOwnership {
  param(
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [Parameter(Mandatory = $true)]$Process
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Active runtime exited before acquiring the bridge instance lock (exit=$($Process.ExitCode))."
    }
    $owner = Get-LiveBridgeOwner -DataDirectory $DataDirectory
    if ($null -ne $owner) {
      $ownerPid = [int](Get-RequiredProperty -Value $owner -Name "pid" -Label "Bridge instance lock")
      if ($ownerPid -eq $Process.Id) {
        return $owner
      }
      throw "Another bridge instance acquired the lock (pid=$ownerPid)."
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Active runtime did not acquire the bridge instance lock within $StartupTimeoutSeconds seconds."
}

function Set-PropertyValue {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$PropertyValue
  )
  $Value | Add-Member -MemberType NoteProperty -Name $Name -Value $PropertyValue -Force
}

if ($env:OS -ne "Windows_NT") {
  throw "This launcher supports Windows only."
}

$launcherDirectory = Resolve-FullPath $PSScriptRoot
if (-not [IO.Path]::GetFileName($launcherDirectory).Equals(
  "launcher",
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "Run the installed launcher from DataDirectory\launcher, not the source copy."
}
$dataDirectory = Resolve-FullPath (Split-Path -Parent $launcherDirectory)
Assert-NoReparseComponents -Path $launcherDirectory -Label "Installed launcher"
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source

Write-Host "Feishu Codex Bridge active-runtime launcher"
Write-Host "  data: $dataDirectory"

if ($PlanOnly) {
  $target = Read-ActiveTarget -DataDirectory $dataDirectory
  Write-Host "  runtime:  $($target.RuntimeDirectory)"
  Write-Host "  bootstrap: $($target.BootstrapPath)"
  Write-Host "Active runtime metadata and bootstrap verified; the bridge was not started."
  exit 0
}

$deploymentLock = $null
$process = $null
try {
  $deploymentLock = Enter-DeploymentLock -DataDirectory $dataDirectory
  $target = Read-ActiveTarget -DataDirectory $dataDirectory
  $existingOwner = Get-LiveBridgeOwner -DataDirectory $dataDirectory
  if ($null -ne $existingOwner) {
    $existingPid = Get-RequiredProperty -Value $existingOwner -Name "pid" -Label "Bridge instance lock"
    Write-Host "Bridge is already running (pid=$existingPid); no new process was started."
    exit 0
  }

  $process = Start-ActiveRuntimeProcess -NodeCommand $nodeCommand -Target $target
  try {
    $owner = Wait-ForBridgeOwnership -DataDirectory $dataDirectory -Process $process
    $startedAt = Get-RequiredProperty -Value $owner -Name "startedAt" -Label "Bridge instance lock"
    Set-PropertyValue -Value $target.Active -Name "pid" -PropertyValue $process.Id
    Set-PropertyValue -Value $target.Active -Name "startedAt" -PropertyValue ([string]$startedAt)
    Set-PropertyValue -Value $target.State -Name "updatedAt" -PropertyValue ([DateTime]::UtcNow.ToString("o"))
    Write-JsonAtomically -Path $target.StatePath -Value $target.State
  } catch {
    $process.Refresh()
    if (-not $process.HasExited) {
      $process.Kill()
      $process.WaitForExit()
    }
    throw
  }
} finally {
  if ($null -ne $deploymentLock) {
    Exit-DeploymentLock -Lock $deploymentLock
  }
}

Write-Host "Verified active runtime started (pid=$($process.Id))."
$process.WaitForExit()
exit $process.ExitCode
