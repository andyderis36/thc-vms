@echo off
REM Thin CMD shim for vms-git-auth (vms-git-auth.ps1 holds all logic).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vms-git-auth.ps1" %*
exit /b %ERRORLEVEL%
