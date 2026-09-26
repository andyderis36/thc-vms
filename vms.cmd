@echo off
REM Thin CMD shim so the dispatcher works from cmd.exe as well as PowerShell.
REM All logic lives in vms.ps1; this only forwards the arguments.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vms.ps1" %*
exit /b %ERRORLEVEL%
