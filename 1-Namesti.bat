@echo off
REM ============================================================
REM  1-Namesti.bat  -  One-click installer entry point
REM
REM  Double-click this file to install everything the app needs:
REM    - Node.js (if not already installed)
REM    - npm dependencies (playwright, nodemailer)
REM    - the Playwright Chromium browser
REM
REM  All it does is hand off to install.ps1 (PowerShell) which
REM  does the real work. Keep this window open and click "Yes"
REM  on any prompts that appear.
REM ============================================================

title Studentski servis - Installer

REM Work from the folder this .bat file lives in.
cd /d "%~dp0"

echo.
echo ============================================================
echo   Studentski servis - Prijave : INSTALLER
echo ============================================================
echo.
echo This will install everything needed to run the app.
echo Please click "Yes" if Windows asks for permission.
echo.

REM Run the PowerShell installer. -NoProfile keeps it fast and clean,
REM -ExecutionPolicy Bypass lets the script run without changing system policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

REM If PowerShell exited with an error code, tell the user clearly.
if errorlevel 1 (
    echo.
    echo ============================================================
    echo   INSTALLATION FAILED
    echo ============================================================
    echo.
    echo Something went wrong during the installation.
    echo Please read the messages above for details.
    echo.
    echo What you can try:
    echo   1. Make sure you are connected to the internet.
    echo   2. Run this file again ^(double-click 1-Namesti.bat^).
    echo   3. If it still fails, right-click 1-Namesti.bat and
    echo      choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

REM Success path. Always pause so the window stays open to read.
echo.
pause
