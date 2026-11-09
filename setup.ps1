# One-time setup: links D:\1C to GitHub and enables auto-sync every 5 minutes
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$repo = 'https://github.com/ekoshmuss/1c.git'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'Git not found. Install it: winget install Git.Git  (then reopen PowerShell)' -ForegroundColor Red
    exit 1
}

if (-not (git config --global user.name))  { git config --global user.name  (Read-Host 'Your name for commits') }
if (-not (git config --global user.email)) { git config --global user.email (Read-Host 'Your GitHub email') }
git config --global core.quotepath false   # readable Cyrillic file names

$ErrorActionPreference = 'Continue'
if (-not (Test-Path .git)) {
    git init -b main
    git remote add origin $repo
}
git fetch origin
git rev-parse --verify origin/main 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { git pull origin main --allow-unrelated-histories --no-edit }

git add -A
git commit -m 'initial commit' 2>&1 | Out-Null
git push -u origin main    # first time a GitHub sign-in window opens
if ($LASTEXITCODE -ne 0) { Write-Host 'Push failed - check sign-in and run again.' -ForegroundColor Red; exit 1 }

# Scheduled task: every 5 minutes
$sync     = Join-Path $PSScriptRoot 'sync.ps1'
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$sync`""
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '1C Git Sync' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host 'Done. D:\1C now syncs with GitHub every 5 minutes.' -ForegroundColor Green
Write-Host "Log: $env:LOCALAPPDATA\1c-git-sync.log"
