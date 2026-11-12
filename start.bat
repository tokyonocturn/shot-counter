@echo off
setlocal
cd /d "%~dp0"
title Shot Counter

if not exist "bin\shot-counter-hotkey.exe" goto build
goto run

:build
echo First run: building the local hotkey agent.
rem No internet and no extra tools: this compiles a small C# file with the
rem .NET compiler that already ships with Windows.
call node setup-local-hotkey.mjs
echo.

:run
rem The agent reads its key from config.json and exits by itself once the app stops.
start "Shot Counter hotkey" /min "bin\shot-counter-hotkey.exe"

echo.
echo Shot Counter is starting.
echo   dashboard  http://localhost:4321/
echo   overlay    http://localhost:4321/window
echo Press your hotkey to add a shot.
echo Close this window to stop the counter and the hotkey agent.
echo.

node server.mjs

echo.
echo Shot counter stopped. Press any key to close.
pause >nul
