@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Sending D:\1C to GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync.ps1"
echo.
git log -1 --format="Last commit: %h  %cd  %s" --date=format:"%Y-%m-%d %H:%M"
git status -sb | findstr /b "##"
echo.
echo --- last log lines ---
powershell -NoProfile -Command "Get-Content \"$env:LOCALAPPDATA\1c-git-sync.log\" -Tail 6 -ErrorAction SilentlyContinue"
pause
