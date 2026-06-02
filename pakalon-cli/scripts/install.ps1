# Pakalon CLI installer (Windows PowerShell 5+).
# Installs `pakalon` + `omp` globally via npm / pnpm / bun and sets up
# shell completions for PowerShell.
#
# Usage:
#   irm https://pakalon.com/install.ps1 | iex
#   .\install.ps1
#   .\install.ps1 -Prefix "$env:USERPROFILE\.local" -NoCompletions
#   .\install.ps1 -FromSource
#   .\install.ps1 -Version 1.2.3
#   .\install.ps1 -DryRun
[CmdletBinding()]
param(
  [string]$Prefix,
  [string]$Version,
  [switch]$FromSource,
  [switch]$NoCompletions,
  [string]$Registry = "https://registry.npmjs.org",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ─────────────────────────────────────────────────────────────────────────────
# Pretty output
# ─────────────────────────────────────────────────────────────────────────────
function Info($m)  { Write-Host "  * $m" -ForegroundColor Blue }
function Ok($m)    { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "  ! $m" -ForegroundColor Yellow }
function Err($m)   { Write-Host "  ✗ $m" -ForegroundColor Red }

function Run([scriptblock]$cmd) {
  if ($DryRun) {
    Write-Host "    $($cmd.ToString().Trim())" -ForegroundColor DarkGray
  } else {
    & $cmd
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Detect package manager
# ─────────────────────────────────────────────────────────────────────────────
function Get-PackageManager {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { return "pnpm" }
  if (Get-Command bun  -ErrorAction SilentlyContinue) { return "bun" }
  if (Get-Command npm  -ErrorAction SilentlyContinue) { return "npm" }
  return $null
}

# ─────────────────────────────────────────────────────────────────────────────
# Header
# ─────────────────────────────────────────────────────────────────────────────
$PackageName = "pakalon"
if (-not $Prefix) {
  if ($env:PAKALON_INSTALL_PREFIX) {
    $Prefix = $env:PAKALON_INSTALL_PREFIX
  } else {
    $Prefix = Join-Path $env:USERPROFILE ".local"
  }
}
if ($env:PAKALON_NO_COMPLETIONS -eq "1") { $NoCompletions = $true }

Write-Host "Pakalon CLI installer" -ForegroundColor Green
Write-Host "  prefix:      $Prefix" -ForegroundColor DarkGray
Write-Host "  registry:    $Registry" -ForegroundColor DarkGray
Write-Host "  completions: $([bool](-not $NoCompletions))" -ForegroundColor DarkGray
Write-Host "  source:      $(if ($FromSource) {'local build'} else {'npm'})" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $Prefix)) {
  Info "Creating install prefix: $Prefix"
  Run { New-Item -ItemType Directory -Path $Prefix -Force | Out-Null }
}

# ─────────────────────────────────────────────────────────────────────────────
# Install
# ─────────────────────────────────────────────────────────────────────────────
$pm = Get-PackageManager
if (-not $pm) {
  Err "Need npm, pnpm, or bun on PATH. Install Node.js: https://nodejs.org"
  exit 1
}

$pkg = if ($Version) { "${PackageName}@${Version}" } else { $PackageName }

if ($FromSource) {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Err "bun is required for -FromSource. Install: irm bun.sh/install.ps1 | iex"
    exit 1
  }
  $root = Split-Path -Parent $PSCommandPath
  Info "Building from source in $root"
  Run { Set-Location $root }
  Run { bun install --frozen-lockfile }
  Run { bun run build }
  $binDir = Join-Path $Prefix "bin"
  Run { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
  Info "Installing to $binDir"
  if (Test-Path "dist/pakalon.cmd") {
    Run { Copy-Item -Force "dist/pakalon.cmd" (Join-Path $binDir "pakalon.cmd") }
  } elseif (Test-Path "dist/pakalon.ps1") {
    Run { Copy-Item -Force "dist/pakalon.ps1" (Join-Path $binDir "pakalon.ps1") }
  } else {
    Run { Copy-Item -Force "dist/pakalon" (Join-Path $binDir "pakalon") }
  }
  if (Test-Path "dist/omp.cmd") {
    Run { Copy-Item -Force "dist/omp.cmd" (Join-Path $binDir "omp.cmd") }
  } elseif (Test-Path "dist/omp") {
    Run { Copy-Item -Force "dist/omp" (Join-Path $binDir "omp") }
  }
} else {
  switch ($pm) {
    "pnpm" {
      Info "Installing via pnpm…"
      Run { pnpm add -g $pkg --registry $Registry }
    }
    "npm" {
      Info "Installing via npm…"
      Run { npm install -g $pkg --registry $Registry }
    }
    "bun" {
      Info "Installing via bun…"
      Run { bun add -g $pkg }
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Completions (PowerShell)
# ─────────────────────────────────────────────────────────────────────────────
if (-not $NoCompletions) {
  $completionsDir = Join-Path $Prefix "completions"
  $srcDir = Split-Path -Parent $PSCommandPath
  $candidate = Join-Path $srcDir "..\completions\pakalon.ps1"
  if (Test-Path $candidate) {
    Info "Installing PowerShell completions to $completionsDir"
    Run { New-Item -ItemType Directory -Path $completionsDir -Force | Out-Null }
    Run { Copy-Item -Force $candidate (Join-Path $completionsDir "pakalon.ps1") }
    Ok "PowerShell completions installed"
    Warn "Add this to your $PROFILE to enable completions:"
    Write-Host "    . '$completionsDir\pakalon.ps1'" -ForegroundColor DarkGray
  } else {
    Warn "Completions source not found at $candidate"
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# PATH nudge
# ─────────────────────────────────────────────────────────────────────────────
$binDir = Join-Path $Prefix "bin"
$currentPath = $env:PATH -split ";"
if ($currentPath -contains $binDir) {
  Ok "PATH already contains $binDir"
} else {
  Warn "$binDir is not in your PATH. Run this in PowerShell to add it for this session:"
  Write-Host "    `$env:PATH = `"$binDir;`$env:PATH`"" -ForegroundColor DarkGray
  Write-Host "    [Environment]::SetEnvironmentVariable('PATH', `"$binDir;`$env:PATH`", 'User')" -ForegroundColor DarkGray
}

Ok "Done. Try: pakalon --version"
