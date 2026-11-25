# Автозапуск веб-интерфейса при включении сервера (запускать PowerShell от имени администратора)
$ErrorActionPreference = 'Stop'
$dir  = $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js не найден. Установите Node.js LTS с https://nodejs.org' -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $dir '.env'))) { Write-Host 'Нет файла .env - скопируйте .env.example в .env и заполните' -ForegroundColor Red; exit 1 }

$port = 8080
$envLine = Get-Content (Join-Path $dir '.env') | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
if ($envLine) { $port = [int](($envLine -split '=')[1].Trim()) }

$action   = New-ScheduledTaskAction -Execute $node -Argument 'server.js' -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'LabStock Web' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# Разрешить порт в брандмауэре (только для частной/доменной сети)
if (-not (Get-NetFirewallRule -DisplayName "LabStock Web $port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "LabStock Web $port" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Domain,Private | Out-Null
}

Start-ScheduledTask -TaskName 'LabStock Web'
Write-Host "Готово. Веб-интерфейс: http://$($env:COMPUTERNAME):$port  (или http://<IP сервера>:$port)" -ForegroundColor Green
