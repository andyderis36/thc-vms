@echo off
REM Double-click runner for the THC-VMS Playwright E2E suite.
REM All logic lives in e2e.ps1; this shim forwards args and keeps the window open.
REM   e2e.cmd            -> local headed
REM   e2e.cmd live       -> production headed (requires typing LIVE)
REM   e2e.cmd check      -> local stack preflight only
REM   e2e.cmd live-check -> production GET /health only, no test data
setlocal
title THC-VMS E2E
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0e2e.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (echo [E2E] OK) else (echo [E2E] FAILED - exit %CODE%)
echo Report: frontend\playwright-report\index.html
echo.
pause
exit /b %CODE%
