@echo off
chcp 65001 >nul
REM Daily AutoCount dashboard refresh, run by Windows Task Scheduler.
REM ASCII only - cmd reads .bat in the system ANSI codepage and non-ASCII
REM characters corrupt the parser.
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

set "LOG=%~dp0refresh-log.txt"

REM Keep the log from growing without bound - start fresh past ~1 MB.
for %%F in ("%LOG%") do if %%~zF GTR 1000000 del "%LOG%"

echo. >> "%LOG%"
echo ======================================================== >> "%LOG%"
echo START %date% %time% >> "%LOG%"

"%NODE%" build-data.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED at build-data.mjs %date% %time% >> "%LOG%"
  exit /b 1
)

"%NODE%" render-dashboard.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED at render-dashboard.mjs %date% %time% >> "%LOG%"
  exit /b 1
)

REM Static-host build is optional. It only runs if credentials are available.
REM Put them in site-credentials.bat next to this file, which is a two-line file:
REM     set "SITE_ID=youruser"
REM     set "SITE_PW=yourpassword"
REM Keep that file out of any folder that syncs or gets shared.
if exist "%~dp0site-credentials.bat" call "%~dp0site-credentials.bat"

if defined SITE_PW (
  "%NODE%" build-site.mjs --lock >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo FAILED at build-site.mjs %date% %time% >> "%LOG%"
    exit /b 1
  )
) else (
  echo SKIPPED build-site.mjs - no SITE_ID/SITE_PW set >> "%LOG%"
)

echo DONE %date% %time% >> "%LOG%"
exit /b 0
