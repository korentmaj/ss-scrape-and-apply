@echo off
setlocal

cd /d "%~dp0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=chrome-verbose"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_scraper.ps1" -Mode "%MODE%"
if errorlevel 1 (
  echo.
  echo [ERROR] Run failed.
  pause
  exit /b 1
)

echo.
echo Done.
pause
exit /b 0
