@echo off
REM Thin CMD shim for vms-tunnel (vms-tunnel.ps1 holds all logic).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vms-tunnel.ps1" %*
exit /b %ERRORLEVEL%
