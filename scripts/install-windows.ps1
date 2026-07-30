#requires -Version 5.1

[CmdletBinding()]
param(
  [string[]]$AllowedSender = @(),
  [string[]]$AllowedChat = @(),
  [string[]]$WorkbenchChat = @(),
  [string]$RepositoryAlias = "project",
  [string]$RepositoryPath,
  [string]$Profile = "codex-remote",
  [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA "feishu-codex-bridge"),
  [string]$CodexEntry,
  [string]$LarkCliEntry,
  [switch]$ToolsOnly,
  [switch]$SkipToolInstall,
  [switch]$SkipDoctor,
  [switch]$ForceConfig,
  [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SourceRoot = Split-Path -Parent $PSScriptRoot
$PackageManifest = Get-Content -LiteralPath (Join-Path $SourceRoot "package.json") -Raw |
  ConvertFrom-Json
$CodexVersion = [string]$PackageManifest.bridgeToolchain.codex
$LarkCliVersion = [string]$PackageManifest.bridgeToolchain.larkCli

if ($CodexVersion -notmatch "^\d+\.\d+\.\d+$" -or
  $LarkCliVersion -notmatch "^\d+\.\d+\.\d+$") {
  throw "package.json bridgeToolchain versions must be exact semantic versions."
}

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

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $($LASTEXITCODE): $FilePath"
  }
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content + [Environment]::NewLine, $encoding)
}

function Write-JsonAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  Assert-NoReparseComponents -Path $directory -Label "Configuration directory"
  $temporary = Join-Path $directory (".install-" + [guid]::NewGuid().ToString("N") + ".tmp")
  try {
    Write-Utf8File -Path $temporary -Content ($Value | ConvertTo-Json -Depth 12)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Copy-FileAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $sourceItem = Get-Item -LiteralPath $Source -Force
  if (-not $sourceItem.PSIsContainer -and
    ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    $directory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    Assert-NoReparseComponents -Path $directory -Label "Launcher directory"
    $temporary = Join-Path $directory (".install-" + [guid]::NewGuid().ToString("N") + ".tmp")
    try {
      [IO.File]::WriteAllBytes($temporary, [IO.File]::ReadAllBytes($sourceItem.FullName))
      Move-Item -LiteralPath $temporary -Destination $Destination -Force
    } finally {
      if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Force
      }
    }
    return
  }
  throw "Launcher source must be a regular file: $Source"
}

function Assert-Identifiers {
  foreach ($sender in $AllowedSender) {
    if ($sender -notmatch "^ou_[A-Za-z0-9_-]+$") {
      throw "Invalid Feishu open_id: $sender"
    }
  }
  foreach ($chat in @($AllowedChat) + @($WorkbenchChat)) {
    if ($chat -notmatch "^oc_[A-Za-z0-9_-]+$") {
      throw "Invalid Feishu chat_id: $chat"
    }
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "This installer supports Windows only."
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -and
  [string]::IsNullOrWhiteSpace($DataDirectory)) {
  throw "LOCALAPPDATA is unavailable; pass -DataDirectory explicitly."
}

$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersionText = (& $nodeCommand --version).Trim().TrimStart("v").Split("-")[0]
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion.Major -lt 20) {
  throw "Node.js 20 or newer is required; found $nodeVersionText."
}

$DataDirectory = Resolve-FullPath $DataDirectory
Assert-NoReparseComponents -Path $DataDirectory -Label "DataDirectory"
$RepositoryPathResolved = $null
if (-not $ToolsOnly) {
  if ($AllowedSender.Count -eq 0) {
    throw "Pass at least one -AllowedSender ou_... value. Use -ToolsOnly first if you still need to obtain it."
  }
  if ([string]::IsNullOrWhiteSpace($RepositoryPath)) {
    throw "Pass -RepositoryPath with the absolute path of the first managed repository."
  }
  if ($RepositoryAlias -notmatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$") {
    throw "RepositoryAlias must contain 1-32 letters, digits, underscores, or hyphens."
  }
  if ($Profile -notmatch "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$") {
    throw "Profile must contain 1-64 letters, digits, dots, underscores, or hyphens."
  }
  Assert-Identifiers
  $RepositoryPathResolved = Resolve-FullPath $RepositoryPath
  if (-not (Test-Path -LiteralPath $RepositoryPathResolved -PathType Container)) {
    throw "Repository path does not exist: $RepositoryPathResolved"
  }
  Assert-NoReparseComponents -Path $RepositoryPathResolved -Label "RepositoryPath"
  if (Test-PathWithin -Parent $RepositoryPathResolved -Candidate $DataDirectory) {
    throw "DataDirectory must be outside the managed repository."
  }
}
$toolchainDirectory = Join-Path $DataDirectory "tools\bridge-toolchain"
$toolManifestPath = Join-Path $toolchainDirectory "package.json"
$launcherSourcePath = Join-Path $SourceRoot "scripts\start-bridge-windows.ps1"
$launcherPath = Join-Path $DataDirectory "launcher\start-bridge-windows.ps1"
$defaultCodexEntry = Join-Path $toolchainDirectory "node_modules\@openai\codex\bin\codex.js"
$defaultLarkCliEntry = Join-Path $toolchainDirectory "node_modules\@larksuite\cli\scripts\run.js"
$toolManifest = [ordered]@{
  name = "feishu-codex-bridge-toolchain"
  version = "0.0.0"
  private = $true
  dependencies = [ordered]@{
    "@larksuite/cli" = $LarkCliVersion
    "@openai/codex" = $CodexVersion
  }
}

Write-Host "Feishu Codex Bridge Windows installer"
Write-Host "  source:    $SourceRoot"
Write-Host "  data:      $DataDirectory"
Write-Host "  Codex CLI: $CodexVersion (isolated)"
Write-Host "  Lark CLI:  $LarkCliVersion (isolated)"

if (-not $SkipToolInstall) {
  if ($PlanOnly) {
    Write-Host "PLAN install isolated npm toolchain at $toolchainDirectory"
  } else {
    New-Item -ItemType Directory -Force -Path $toolchainDirectory | Out-Null
    Assert-NoReparseComponents -Path $toolchainDirectory -Label "Toolchain directory"
    Write-JsonAtomically -Path $toolManifestPath -Value $toolManifest
    Invoke-NativeCommand -FilePath $npmCommand -ArgumentList @(
      "install", "--prefix", $toolchainDirectory, "--omit=dev", "--no-audit", "--no-fund"
    )
  }
}

if ($PlanOnly) {
  Write-Host "PLAN install fixed active-runtime launcher at $launcherPath"
} else {
  Copy-FileAtomically -Source $launcherSourcePath -Destination $launcherPath
  Write-Host "Fixed active-runtime launcher installed: $launcherPath"
}

if ([string]::IsNullOrWhiteSpace($CodexEntry)) {
  $CodexEntry = $defaultCodexEntry
}
if ([string]::IsNullOrWhiteSpace($LarkCliEntry)) {
  $LarkCliEntry = $defaultLarkCliEntry
}
$CodexEntry = Resolve-FullPath $CodexEntry
$LarkCliEntry = Resolve-FullPath $LarkCliEntry

if (-not $PlanOnly) {
  if (-not (Test-Path -LiteralPath $CodexEntry -PathType Leaf)) {
    throw "Codex entry was not installed: $CodexEntry"
  }
  if (-not (Test-Path -LiteralPath $LarkCliEntry -PathType Leaf)) {
    throw "Lark CLI entry was not installed: $LarkCliEntry"
  }
}

if ($ToolsOnly) {
  Write-Host ""
  if ($PlanOnly) {
    Write-Host "Plan completed; no tools or files were installed."
  } else {
    Write-Host "Isolated tools are ready. Continue with:"
  }
  Write-Host ('  node "{0}" login' -f $CodexEntry)
  Write-Host ('  node "{0}" config init --new --name "{1}" --lang zh' -f $LarkCliEntry, $Profile)
  Write-Host ('  node "{0}" --profile "{1}" event consume im.message.receive_v1 --as bot --max-events 1 --timeout 2m' -f $LarkCliEntry, $Profile)
  exit 0
}

$RepositoryPath = $RepositoryPathResolved

$allAllowedChats = @(@($AllowedChat) + @($WorkbenchChat) | Select-Object -Unique)
$allWorkbenchChats = @(@($WorkbenchChat) | Select-Object -Unique)
$repositories = [ordered]@{}
$repositories[$RepositoryAlias] = [ordered]@{ path = $RepositoryPath }
$configuration = [ordered]@{
  version = 1
  lark = [ordered]@{
    profile = $Profile
    allowedSenders = @($AllowedSender | Select-Object -Unique)
    allowedChats = @($allAllowedChats)
    workbenchChats = @($allWorkbenchChats)
    p2pOnly = $allWorkbenchChats.Count -eq 0
    allowedMessageTypes = @("text", "post")
    maxMessageAgeMinutes = 10
  }
  larkCliEntry = $LarkCliEntry
  repositories = $repositories
  defaultRepository = $RepositoryAlias
  codex = [ordered]@{
    sandbox = "workspace-write"
    approvalPolicy = "never"
    model = $null
    provider = $null
    maxRuntimeMinutes = 60
    entry = $CodexEntry
    appServer = [ordered]@{ enabled = $true }
  }
  queue = [ordered]@{ concurrency = 1 }
  desktopSync = [ordered]@{ pollIntervalMs = 5000 }
  limits = [ordered]@{
    maxPromptChars = 8000
    maxReplyChars = 12000
    processedMessageLimit = 2000
    storedJobLimit = 500
  }
  dataDirectory = $DataDirectory
}

$configPath = Join-Path $DataDirectory "config\bridge.config.json"
if ((Test-Path -LiteralPath $configPath) -and -not $ForceConfig) {
  throw "Configuration already exists: $configPath. Review it or pass -ForceConfig explicitly."
}

if ($PlanOnly) {
  Write-Host "PLAN write canonical configuration to $configPath"
} else {
  Write-JsonAtomically -Path $configPath -Value $configuration
  Write-Host "Canonical configuration written: $configPath"
}

if (-not $SkipDoctor) {
  if ($PlanOnly) {
    Write-Host "PLAN run bridge doctor"
  } else {
    Invoke-NativeCommand -FilePath $nodeCommand -ArgumentList @(
      (Join-Path $SourceRoot "src\main.js"), "doctor", "--config", $configPath
    )
  }
}

Write-Host ""
Write-Host "Installation preparation completed."
Write-Host ('Change to the source directory: Set-Location "{0}"' -f $SourceRoot)
Write-Host ('Start in the foreground: npm.cmd start -- --config "{0}"' -f $configPath)
Write-Host ('Deploy after the foreground smoke test: npm.cmd run deploy -- --config "{0}"' -f $configPath)
Write-Host ('Start the deployed active snapshot after login: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $launcherPath)
