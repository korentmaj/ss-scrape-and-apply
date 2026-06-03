param(
  [ValidateSet('setup', 'self-test', 'chrome', 'chrome-real', 'chrome-verbose', 'chrome-real-verbose')]
  [string]$Mode = 'chrome-verbose',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "[ERROR] $Message" -ForegroundColor Red
  exit 1
}

function Step([string]$Message) {
  Write-Host "[step] $Message" -ForegroundColor Cyan
}

function Info([string]$Message) {
  Write-Host "[info] $Message"
}


$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

Step "Checking Node.js and npm"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js is not installed or not in PATH. Install Node LTS from https://nodejs.org/"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm is not available. Reinstall Node.js LTS."
}

if ($Mode -eq 'setup' -or ((-not $SkipInstall) -and -not (Test-Path (Join-Path $repoRoot 'node_modules')))) {
  Step "Installing npm dependencies"
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Fail "npm install failed. If you see EACCES/EPERM, open PowerShell as Administrator and retry setup once."
  }

  Step "Installing Playwright Chromium runtime"
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) {
    Fail "Playwright browser install failed."
  }
} else {
  Info "Dependency install skipped (already present)."
}

$envFile = Join-Path $repoRoot '.env'
$envExample = Join-Path $repoRoot '.env.example'
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Fail "Created .env from .env.example. Fill .env values and run again."
  } else {
    Fail ".env is missing and .env.example was not found."
  }
}

$chromeUserDataDir = Join-Path $repoRoot '.chrome-automation-profile'
if (-not (Test-Path $chromeUserDataDir)) {
  New-Item -ItemType Directory -Path $chromeUserDataDir | Out-Null
}

$lockPath = Join-Path (Join-Path $repoRoot 'logs') '.run.lock'
if (Test-Path $lockPath) {
  $active = $false
  try {
    $lockRaw = Get-Content -Path $lockPath -Raw
    $lockData = $lockRaw | ConvertFrom-Json
    if ($lockData.pid) {
      $proc = Get-Process -Id ([int]$lockData.pid) -ErrorAction SilentlyContinue
      if ($proc) {
        $active = $true
      }
    }
  } catch {
    # Ignore parse errors and treat as stale lock.
  }

  if ($active) {
    Fail "Another scraper run appears active (logs/.run.lock). Close old run first."
  }

  Info "Removing stale lock: logs/.run.lock"
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}

$args = @('scraper.js')
switch ($Mode) {
  'setup' {
    Info "Setup completed."
    exit 0
  }
  'self-test' {
    $args += '--self-test'
    $args += '--verbose'
  }
  'chrome' {
    $args += '--chrome-profile'
  }
  'chrome-real' {
    $args += '--chrome-profile'
    $args += '--real-submit'
  }
  'chrome-verbose' {
    $args += '--chrome-profile'
    $args += '--verbose'
  }
  'chrome-real-verbose' {
    $args += '--chrome-profile'
    $args += '--real-submit'
    $args += '--verbose'
  }
  default {
    Fail "Unsupported mode: $Mode"
  }
}

$args += '--chrome-user-data-dir'
$args += $chromeUserDataDir
$args += '--chrome-profile-directory'
$args += 'Default'

Step "Running: node $($args -join ' ')"
node @args
if ($LASTEXITCODE -ne 0) {
  Fail "Scraper failed. Check error.log and logs/events.jsonl."
}

Info "Done."
