@echo off
title Accounting MCP server
cd /d "%~dp0"

REM ASCII only. cmd reads .bat in the system ANSI codepage, so non-ASCII text
REM here corrupts the parse in ways that look nothing like the cause.

set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

REM Which accounting system this machine talks to. Edit these two lines.
if not defined ACCT_ENGINE set "ACCT_ENGINE=mssql"
if not defined ACCT_SQL_INSTANCE set "ACCT_SQL_INSTANCE=.\A2006"

if not exist "remote-tokens.txt" (
  echo.
  echo No access tokens yet. Make one first, naming the device:
  echo.
  echo     node make-token.mjs "boss laptop"
  echo.
  pause
  exit /b 1
)

echo.
echo Starting. Other computers connect to one of the addresses below.
echo Close this window, or press Ctrl+C, and nothing is reachable any more.
echo.

"%NODE%" remote.js
if errorlevel 1 (
  echo.
  echo The server stopped with an error. Copy the message above and show it to Claude.
  echo.
  pause
)
