@echo off
title AutoCount Dashboard
cd /d "%~dp0"

REM ASCII only. cmd reads .bat in the system ANSI codepage, so non-ASCII text
REM here gets mangled and breaks the parser - do not add Chinese to this file.

set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

if not exist "serve.mjs" (
  echo.
  echo ERROR: serve.mjs not found.
  echo This file must sit in the same folder as the dashboard scripts.
  echo.
  pause
  exit /b 1
)

if not exist "dashboard.html" (
  echo.
  echo No dashboard.html yet - building it once, this takes about a minute...
  "%NODE%" build-data.mjs
  if errorlevel 1 goto failed
  "%NODE%" render-dashboard.mjs
  if errorlevel 1 goto failed
)

echo.
echo   AutoCount Dashboard
echo   ------------------------------------------------
echo   URL   : http://localhost:8787
echo   Refresh: the button in the page header re-reads AutoCount
echo   Stop   : close this window, or press Ctrl+C
echo.

start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:8787"

"%NODE%" serve.mjs
goto :eof

:failed
echo.
echo Build failed. Copy the error above and show it to Claude.
echo.
pause
