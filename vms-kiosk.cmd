@echo off
REM Thin CMD shim for vms-kiosk (vms-kiosk.ps1 holds all logic).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vms-kiosk.ps1" %*
exit /b %ERRORLEVEL%
