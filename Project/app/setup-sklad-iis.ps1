# Setup of sklad.gkib.kz in IIS: URL Rewrite + ARR, reverse proxy to LabStock (127.0.0.1:8080)
# Run as Administrator on the 1C server. 1C publication (/new) is not touched.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dl = 'C:\LabStock\dl'; New-Item -ItemType Directory -Force $dl | Out-Null

$pkgs = [ordered]@{
  'rewrite_amd64_en-US.msi' = 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi'
  'requestRouter_amd64.msi' = 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi'
}
$need = @{ 'rewrite_amd64_en-US.msi' = (Test-Path "$env:windir\System32\inetsrv\rewrite.dll");
           'requestRouter_amd64.msi' = (Test-Path "$env:ProgramFiles\IIS\Application Request Routing") }
foreach ($n in $pkgs.Keys) {
  if ($need[$n]) { "SKIP $n (already installed)"; continue }
  $f = Join-Path $dl $n
  if (-not (Test-Path $f)) { Invoke-WebRequest -UseBasicParsing $pkgs[$n] -OutFile $f }
  $sig = Get-AuthenticodeSignature $f
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') { throw "BAD SIGNATURE: $n ($($sig.Status))" }
  "SIGNED OK $n  ($((Get-Item $f).Length) bytes)"
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$f`" /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "INSTALL FAILED $n exit $($p.ExitCode)" }
  "INSTALLED $n"
}

Import-Module WebAdministration
$ah = 'MACHINE/WEBROOT/APPHOST'
Set-WebConfigurationProperty -PSPath $ah -Filter 'system.webServer/proxy' -Name enabled -Value $true
Set-WebConfigurationProperty -PSPath $ah -Filter 'system.webServer/proxy' -Name reverseRewriteHostInResponseHeaders -Value $false
if (-not (Get-WebConfiguration -PSPath $ah -Filter "system.webServer/rewrite/allowedServerVariables/add[@name='HTTP_X_FORWARDED_PROTO']")) {
  Add-WebConfigurationProperty -PSPath $ah -Filter 'system.webServer/rewrite/allowedServerVariables' -Name '.' -Value @{ name = 'HTTP_X_FORWARDED_PROTO' }
}
'ARR proxy enabled'

$root = 'C:\LabStock\iis'; New-Item -ItemType Directory -Force $root | Out-Null
$wc = @'
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="LabStockProxy" stopProcessing="true">
          <match url="(.*)" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="{MapHttps:{HTTPS}}" />
          </serverVariables>
          <action type="Rewrite" url="http://127.0.0.1:8080/{R:1}" />
        </rule>
      </rules>
      <rewriteMaps>
        <rewriteMap name="MapHttps">
          <add key="on" value="https" />
          <add key="off" value="http" />
        </rewriteMap>
      </rewriteMaps>
    </rewrite>
  </system.webServer>
</configuration>
'@
[IO.File]::WriteAllText("$root\web.config", $wc, (New-Object Text.UTF8Encoding $false))
icacls $root /grant 'IIS_IUSRS:(OI)(CI)RX' | Out-Null

if (-not (Test-Path 'IIS:\AppPools\LabStockSklad')) { New-WebAppPool -Name 'LabStockSklad' | Out-Null }
Set-ItemProperty 'IIS:\AppPools\LabStockSklad' -Name managedRuntimeVersion -Value ''
if (-not (Get-Website -Name 'LabStock sklad')) {
  New-Website -Name 'LabStock sklad' -PhysicalPath $root -HostHeader 'sklad.gkib.kz' -Port 6536 -IPAddress '*' -ApplicationPool 'LabStockSklad' | Out-Null
}
Start-Website -Name 'LabStock sklad'
'IIS site "LabStock sklad" (http *:6536:sklad.gkib.kz) ready'

# Site behind proxy: trust X-Forwarded-For (for login lockout per client IP)
$envf = 'C:\LabStock\app\.env'; $u8 = New-Object Text.UTF8Encoding $false
$lines = [IO.File]::ReadAllLines($envf, $u8)
if ($lines -match '^TRUST_PROXY=') { $lines = $lines | ForEach-Object { if ($_ -like 'TRUST_PROXY=*') { 'TRUST_PROXY=1' } else { $_ } } } else { $lines += 'TRUST_PROXY=1' }
[IO.File]::WriteAllLines($envf, $lines, $u8)
$a = 'C:\LabStock\app\auth.js'; $t = [IO.File]::ReadAllText($a, $u8)
$t = $t.Replace("split(',')[0].trim()", "split(',').pop().trim()"); [IO.File]::WriteAllText($a, $t, $u8)
Stop-ScheduledTask 'LabStock Web'; Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2; Start-ScheduledTask 'LabStock Web'; Start-Sleep 6

'--- checks:'
'sklad via IIS : ' + (curl.exe -s -o NUL -w '%{http_code}' -H 'Host: sklad.gkib.kz' http://127.0.0.1:6536/login.html)
'1C /new       : ' + (curl.exe -s -o NUL -w '%{http_code}' http://127.0.0.1:6536/new/ru_RU/)
'site :8080    : ' + (curl.exe -s -o NUL -w '%{http_code}' http://127.0.0.1:8080/login.html)
'DONE'
