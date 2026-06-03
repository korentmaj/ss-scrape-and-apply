@echo off
title Studentski servis - Prijave
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js is not installed yet.
  echo      Please run  1-Namesti.bat  first and click Yes on the prompts.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo  [!] The app is not installed yet.
  echo      Please run  1-Namesti.bat  first.
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting the control panel... a page will open in your web browser.
echo  Keep THIS window open while you use the app.
echo  To quit: close this window or press Ctrl+C.
echo.

node gui-server.js

echo.
echo  The app has stopped.
pause
