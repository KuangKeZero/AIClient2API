@echo off
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
    echo [AIClient2API][ERROR] PowerShell was not found.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0aiclient2api-windows.ps1" status %*
exit /b %ERRORLEVEL%
