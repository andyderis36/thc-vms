@echo off
REM Double-click runner for the THC-VMS Playwright E2E suite in LIVE mode.
REM This always targets production and requires typing LIVE before any test runs.
REM For local mode use e2e.cmd instead.
setlocal
title THC-VMS E2E LIVE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0e2e.ps1" live
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (echo [E2E LIVE] OK) else (echo [E2E LIVE] FAILED - exit %CODE%)
echo Report: frontend\playwright-report\index.html
echo.
pause
exit /b %CODE%
