<#
.SYNOPSIS
claude-statusline setup for Windows (PowerShell 5.1 or 7). On macOS and Linux, use install.sh.

.DESCRIPTION
Gets a claude-statusline binary for this machine, then runs its own installer:
  1. bun found                        -> build the binary from this checkout
  2. no bun, gh signed in, a release  -> download the release binary for this machine
  3. neither                          -> install bun (winget, else scoop, else bun's own
                                         installer), then build
Then it checks for the claude CLI, which writes the Haiku labels, and offers to install it.
It asks before it installs anything; -Yes answers yes, and with no console the answer is no.
Git for Windows is not needed.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -Yes -SkipClaude
#>
param([switch]$Yes, [switch]$SkipClaude)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar slows Invoke-WebRequest down a lot

function Say([string]$m) { Write-Host '==> ' -ForegroundColor Green -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Warning $m }
function Fail([string]$m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Ask([string]$q) {
  if ($Yes) { return $true }
  if ([Console]::IsInputRedirected) { return $false }
  return (Read-Host "$q [y/N]") -match '^[yY]'
}
# A program installed in this run is on the PATH of new consoles only: read PATH again.
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$Repo = $PSScriptRoot
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$Bin = Join-Path $Repo 'dist\claude-statusline.exe'

function Find-Bun {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:USERPROFILE\.bun\bin\bun.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\bun.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Invoke-Checked([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') exited with $LASTEXITCODE" }
}

function Build([string]$bun) {
  Say "Building claude-statusline with $bun"
  Push-Location $Repo
  try {
    Invoke-Checked $bun @('install', '--frozen-lockfile')
    Invoke-Checked $bun @('run', 'build')
  } finally { Pop-Location }
}

function Get-Release {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $false }
  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  Push-Location $Repo
  try { $repo = gh repo view --json nameWithOwner -q .nameWithOwner 2> $null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0 -or -not $repo) { return $false }
  gh release view --repo $repo *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  Say "Downloading the latest claude-statusline release for windows-$Arch from $repo"
  New-Item -ItemType Directory -Force (Split-Path $Bin) | Out-Null
  Invoke-Checked gh @('release', 'download', '--repo', $repo, '--pattern', "claude-statusline-windows-$Arch.exe", '--output', $Bin, '--clobber')
  return $true
}

function Install-Bun {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if (-not (Ask 'Bun is needed to build claude-statusline. Install it with winget (winget install Oven-sh.Bun)?')) { return $false }
    Invoke-Checked winget @('install', '--id', 'Oven-sh.Bun', '--exact', '--accept-source-agreements', '--accept-package-agreements')
  } elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
    if (-not (Ask 'Bun is needed to build claude-statusline. Install it with scoop (scoop install bun)?')) { return $false }
    Invoke-Checked scoop @('install', 'bun')
  } else {
    if (-not (Ask 'Bun is needed to build claude-statusline. Install it with its installer (irm https://bun.sh/install.ps1 | iex)?')) { return $false }
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  }
  Update-Path
  return $true
}

# --- 1. The binary -------------------------------------------------------------------
$bun = Find-Bun
if ($bun) {
  Build $bun
} elseif (Get-Release) {
} elseif (Install-Bun) {
  $bun = Find-Bun
  if (-not $bun) { Fail 'bun is installed but not found; open a new console and run this again' }
  Build $bun
} else {
  Fail 'bun is needed to build claude-statusline: install it from https://bun.sh and run this again, or download a release binary and run: <binary> install'
}

# --- 2. The claude CLI, for the Haiku labels -----------------------------------------
$hasClaude = (Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")
if (-not $hasClaude) {
  if ($SkipClaude) {
    Warn 'the claude CLI is not installed: there are no Haiku task and scope labels without it'
  } elseif (Ask 'The claude CLI is not installed, and the Haiku labels need it. Install it (irm https://claude.ai/install.ps1 | iex)?') {
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Update-Path
  } else {
    Warn 'without the claude CLI there are no Haiku task and scope labels'
  }
}

# --- 3. Install into Claude Code -----------------------------------------------------
& $Bin install
exit $LASTEXITCODE
