@echo off
REM Thin CMD shim for vms-export-sync (vms-export-sync.ps1 holds all logic).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vms-export-sync.ps1" %*
exit /b %ERRORLEVEL%
