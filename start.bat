@echo off
cd /d "%~dp0"
title Shot Counter

rem Offline mode needs its own global hotkey: start the bundled agent if it was built.
set AGENT_PID=
if exist "bin\shot-counter-hotkey.exe" (
  for /f %%i in ('powershell -NoProfile -Command "(Start-Process -FilePath 'bin\shot-counter-hotkey.exe' -WindowStyle Minimized -PassThru).Id"') do set AGENT_PID=%%i
  echo Local hotkey agent running. Close this window to stop everything.
  echo.
) else (
  echo [offline] No local hotkey agent yet. Build it once with: node setup-local-hotkey.mjs
  echo [offline] Without it, the app still counts from the dashboard button or the OBS hotkey.
  echo.
)

node server.mjs

if defined AGENT_PID taskkill /PID %AGENT_PID% /F >nul 2>&1
echo.
echo Shot counter stopped. Press any key to close.
pause >nul
