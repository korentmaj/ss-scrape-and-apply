# ============================================================
#  install.ps1  -  Studentski servis - Prijave : Installer
#
#  Installs everything the app needs so a non-technical user
#  can get going by just double-clicking 1-Namesti.bat:
#    Step 1/5  Ensure Node.js >= 18 (install if missing)
#    Step 2/5  npm install (playwright + nodemailer)
#    Step 3/5  Install Playwright Chromium browser
#    Step 4/5  Create .env from .env.example (if needed)
#    Step 5/5  Create a Desktop shortcut to 2-Zazeni.bat
#
#  Target runtime: Windows PowerShell 5.1.
#  Avoids PS 7-only syntax (no ternary, no ??, no &&/||).
# ============================================================

# Stop on the first unhandled error so we never silently half-install.
$ErrorActionPreference = 'Stop'

# Always operate from the folder this script lives in (the project root).
Set-Location -LiteralPath $PSScriptRoot

# Pinned, permanent Node.js LTS MSI used as the offline/fallback installer.
$NodeMsiUrl = 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi'

# ------------------------------------------------------------
# Helper: Update-SessionPath
#   After a fresh Node.js install, the new install folder is NOT
#   on PATH for this already-running process. Rebuild $env:Path
#   from the authoritative Machine + User values in the registry
#   so that "node" / "npm" become callable without a restart.
# ------------------------------------------------------------
function Update-SessionPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')

    # Either value can be $null; treat that as an empty string.
    if ($null -eq $machinePath) { $machinePath = '' }
    if ($null -eq $userPath)    { $userPath    = '' }

    # Machine PATH first, then User PATH (mirrors how Windows builds it).
    $env:Path = $machinePath + ';' + $userPath
}

# ------------------------------------------------------------
# Helper: Get-NodeMajorVersion
#   Returns the installed Node.js major version as an integer,
#   or 0 if Node is not found / not parseable. Never throws.
# ------------------------------------------------------------
function Get-NodeMajorVersion {
    try {
        # "node -v" prints something like "v20.18.1".
        $raw = (& node -v) 2>$null
    } catch {
        return 0
    }

    if (-not $raw) { return 0 }

    # Normalise: take the first line, trim whitespace, drop a leading 'v'.
    $verText = ([string]$raw).Trim()
    if ($verText.StartsWith('v') -or $verText.StartsWith('V')) {
        $verText = $verText.Substring(1)
    }

    # Major version = the integer before the first dot.
    $firstPart = $verText.Split('.')[0]
    $major = 0
    if ([int]::TryParse($firstPart, [ref]$major)) {
        return $major
    }
    return 0
}

Write-Host ''
Write-Host '============================================================'
Write-Host '  Studentski servis - Prijave : Installer'
Write-Host '============================================================'
Write-Host ''

# ============================================================
# STEP 1/5 - Ensure Node.js >= 18
# ============================================================
try {
    Write-Host '==> Step 1/5: Checking Node.js'

    $major = Get-NodeMajorVersion

    if ($major -ge 18) {
        Write-Host ("    Node.js is already installed (major version " + $major + "). Skipping install.")
    }
    else {
        if ($major -gt 0) {
            Write-Host ("    Found Node.js major version " + $major + ", which is too old (need 18+).")
        } else {
            Write-Host '    Node.js was not found.'
        }
        Write-Host '    Installing Node.js LTS. Please click "Yes" if Windows asks for permission...'

        $installed = $false

        # ---- PRIMARY method: winget ----
        $wingetCmd = $null
        try {
            $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
        } catch {
            $wingetCmd = $null
        }

        if ($wingetCmd) {
            Write-Host '    Using Windows Package Manager (winget) to install Node.js LTS...'
            try {
                # winget shows its own UAC prompt that the user clicks "Yes" on.
                & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
                if ($LASTEXITCODE -eq 0) {
                    $installed = $true
                    Write-Host '    winget reported success.'
                } else {
                    Write-Host ("    winget did not succeed (exit code " + $LASTEXITCODE + "). Will try the direct download instead.")
                }
            } catch {
                Write-Host '    winget failed to run. Will try the direct download instead.'
            }
        }
        else {
            Write-Host '    winget is not available on this system. Will use the direct download instead.'
        }

        # ---- FALLBACK method: download + msiexec ----
        if (-not $installed) {
            $msiPath = Join-Path $env:TEMP 'node-lts-x64.msi'
            Write-Host '    Downloading the Node.js LTS installer...'

            $downloaded = $false
            try {
                # Use TLS 1.2 for older systems and a progress-free fast download.
                [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
                $oldProgress = $ProgressPreference
                $ProgressPreference = 'SilentlyContinue'
                Invoke-WebRequest -Uri $NodeMsiUrl -OutFile $msiPath -UseBasicParsing
                $ProgressPreference = $oldProgress
                $downloaded = $true
            } catch {
                $downloaded = $false
            }

            if (-not $downloaded) {
                Write-Host ''
                Write-Host '    ERROR: Could not download the Node.js installer.'
                Write-Host '    This usually means there is no internet connection.'
                Write-Host ''
                Write-Host '    Please install Node.js LTS manually from the page that is opening now,'
                Write-Host '    then run 1-Namesti.bat again.'
                Start-Process 'https://nodejs.org'
                exit 1
            }

            Write-Host '    Running the Node.js installer (a small progress window and a "Yes" prompt may appear)...'
            # /qb = basic UI with progress, /norestart = do not reboot automatically.
            $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msiPath, '/qb', '/norestart') -Wait -PassThru
            if ($proc.ExitCode -ne 0) {
                Write-Host ''
                Write-Host ('    ERROR: The Node.js installer exited with code ' + $proc.ExitCode + '.')
                Write-Host '    Please try running 1-Namesti.bat again, or install Node.js LTS manually'
                Write-Host '    from https://nodejs.org and then run 1-Namesti.bat again.'
                exit 1
            }
            Write-Host '    Node.js installer finished.'
        }

        # ---- Make the freshly installed Node visible to THIS process ----
        Update-SessionPath
        $major = Get-NodeMajorVersion

        if ($major -lt 18) {
            Write-Host ''
            Write-Host '    Node.js was installed but a restart is needed.'
            Write-Host '    Please close this window, restart your computer, and run 1-Namesti.bat again.'
            exit 1
        }

        Write-Host ("    Node.js is now installed (major version " + $major + ").")
    }
}
catch {
    Write-Host ''
    Write-Host '    ERROR while checking or installing Node.js:'
    Write-Host ('    ' + $_.Exception.Message)
    Write-Host '    Please make sure you are online and try running 1-Namesti.bat again.'
    Write-Host '    If it keeps failing, install Node.js LTS manually from https://nodejs.org.'
    exit 1
}

Write-Host ''

# ============================================================
# STEP 2/5 - Install npm dependencies
# ============================================================
try {
    Write-Host '==> Step 2/5: Installing app dependencies (npm install)'
    Write-Host '    This downloads the libraries the app needs. Please wait...'

    # --no-audit / --no-fund keep the output clean and a bit faster.
    & npm install --no-audit --no-fund

    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host ('    ERROR: "npm install" failed (exit code ' + $LASTEXITCODE + ').')
        Write-Host '    What you can try:'
        Write-Host '      - Check your internet connection and run 1-Namesti.bat again.'
        Write-Host '      - If you saw a permission error (EPERM / EACCES), close other programs'
        Write-Host '        and right-click 1-Namesti.bat -> "Run as administrator".'
        exit 1
    }

    Write-Host '    Dependencies installed.'
}
catch {
    Write-Host ''
    Write-Host '    ERROR while installing dependencies:'
    Write-Host ('    ' + $_.Exception.Message)
    Write-Host '    Please check your internet connection and run 1-Namesti.bat again.'
    exit 1
}

Write-Host ''

# ============================================================
# STEP 3/5 - Install the Playwright Chromium browser
# ============================================================
try {
    Write-Host '==> Step 3/5: Installing the Chromium browser for Playwright'
    Write-Host '    This downloads a browser the app uses. This may take a few minutes...'

    & npx playwright install chromium

    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host ('    ERROR: Installing the Chromium browser failed (exit code ' + $LASTEXITCODE + ').')
        Write-Host '    Please check your internet connection and run 1-Namesti.bat again.'
        exit 1
    }

    Write-Host '    Chromium browser installed.'
}
catch {
    Write-Host ''
    Write-Host '    ERROR while installing the Chromium browser:'
    Write-Host ('    ' + $_.Exception.Message)
    Write-Host '    Please check your internet connection and run 1-Namesti.bat again.'
    exit 1
}

Write-Host ''

# ============================================================
# STEP 4/5 - Create .env from .env.example (if it does not exist)
# ============================================================
try {
    Write-Host '==> Step 4/5: Setting up the configuration file (.env)'

    $envPath     = Join-Path $PSScriptRoot '.env'
    $envExample  = Join-Path $PSScriptRoot '.env.example'

    if (Test-Path -LiteralPath $envPath) {
        Write-Host '    A .env file already exists. Leaving it unchanged.'
    }
    elseif (Test-Path -LiteralPath $envExample) {
        Copy-Item -LiteralPath $envExample -Destination $envPath
        Write-Host '    Created .env from .env.example.'
        Write-Host '    You can leave it as-is for the basic local / CSV mode.'
    }
    else {
        # No template to copy from - not fatal, the app can still run in basic mode.
        Write-Host '    No .env.example found, skipping. You can run in basic local / CSV mode.'
    }
}
catch {
    Write-Host ''
    Write-Host '    ERROR while creating the configuration file:'
    Write-Host ('    ' + $_.Exception.Message)
    Write-Host '    This step is optional - you can usually continue without it.'
    exit 1
}

Write-Host ''

# ============================================================
# STEP 5/5 - Create a Desktop shortcut to 2-Zazeni.bat
#   A failed shortcut is non-fatal: we only warn and continue.
# ============================================================
try {
    Write-Host '==> Step 5/5: Creating a Desktop shortcut'

    $desktop      = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'Studentski servis - Prijave.lnk'
    $targetPath   = Join-Path $PSScriptRoot '2-Zazeni.bat'

    $wsh      = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath       = $targetPath
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description       = 'Zazeni Studentski servis - Prijave'
    $shortcut.Save()

    Write-Host '    Desktop shortcut created: "Studentski servis - Prijave".'
}
catch {
    # Non-fatal: just let the user know they can start from the folder instead.
    Write-Host '    NOTE: Could not create the Desktop shortcut (this is not a problem).'
    Write-Host '    You can still start the app from the project folder using 2-Zazeni.bat.'
}

Write-Host ''

# ============================================================
# FINAL - Success banner
# ============================================================
Write-Host '============================================================'
Write-Host '  Installation complete!'
Write-Host '============================================================'
Write-Host ''
Write-Host '  To start the app: double-click  2-Zazeni.bat'
Write-Host "  (or the 'Studentski servis - Prijave' icon on your Desktop)."
Write-Host ''
Write-Host '  A window will open in your web browser.'
Write-Host '  Upload your CV, then click Run.'
Write-Host ''

exit 0
