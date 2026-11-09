# Auto-sync D:\1C <-> GitHub (run by Task Scheduler every 5 minutes)
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$log = Join-Path $env:LOCALAPPDATA '1c-git-sync.log'
function Log($m) { "$(Get-Date -Format s)  $m" | Out-File -Append -Encoding utf8 $log }

# 1. Commit local changes
git add -A 2>&1 | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "auto-sync $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-Null
    Log 'local changes committed'
}

# 2. Get changes from GitHub
git pull --rebase --autostash origin main 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) {
    git rebase --abort 2>&1 | Out-Null
    Log 'CONFLICT: resolve manually (git status), sync paused until fixed'
    exit 1
}

# 3. Send to GitHub
git push origin main 2>&1 | ForEach-Object { Log $_ }
