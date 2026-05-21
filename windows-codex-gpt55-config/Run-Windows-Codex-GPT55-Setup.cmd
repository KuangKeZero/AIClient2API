@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-codex-gpt55-models.ps1" -NoPause
echo.
pause
