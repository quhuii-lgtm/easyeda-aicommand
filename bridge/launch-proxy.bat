@echo off
rem Manual launcher. URL registration uses the PowerShell script directly.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-proxy.ps1"
exit /b %errorlevel%
