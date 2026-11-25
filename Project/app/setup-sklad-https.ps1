# HTTPS for sklad.gkib.kz on the 1C server: Let's Encrypt via win-acme (auto-renewal), IIS binding https *:3656 (SNI)
# Router: external 443 -> server 3656, external 80 -> server 6536. Run as Administrator.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Import-Module WebAdministration
$root = 'C:\LabStock\iis'

function Write-WebConfig([bool]$redirect) {
  $r = ''
  if ($redirect) {
    $r = @'
        <rule name="HttpsRedirect" stopProcessing="true">
          <match url="(.*)" />
          <conditions>
            <add input="{HTTPS}" pattern="off" />
            <add input="{REQUEST_URI}" pattern="^/\.well-known/acme-challenge/" negate="true" />
          </conditions>
          <action type="Redirect" url="https://sklad.gkib.kz/{R:1}" redirectType="Found" />
        </rule>
'@
  }
  $wc = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="AcmeChallenge" stopProcessing="true">
          <match url="^\.well-known/acme-challenge/" />
          <action type="None" />
        </rule>
$r        <rule name="LabStockProxy" stopProcessing="true">
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
"@
  [IO.File]::WriteAllText("$root\web.config", $wc, (New-Object Text.UTF8Encoding $false))
}

Write-WebConfig $false
'web.config: ACME path excluded from proxy'

$w = 'C:\LabStock\win-acme'
if (-not (Test-Path "$w\wacs.exe")) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/win-acme/win-acme/releases/latest' -Headers @{ 'User-Agent' = 'labstock-setup' }
  $a = $rel.assets | Where-Object { $_.name -match 'x64\.pluggable\.zip$' } | Select-Object -First 1
  if (-not $a) { throw 'win-acme x64 pluggable asset not found' }
  "win-acme $($rel.tag_name): $($a.name) ($($a.size) bytes)"
  New-Item -ItemType Directory -Force 'C:\LabStock\dl' | Out-Null
  $zip = "C:\LabStock\dl\$($a.name)"
  Invoke-WebRequest -UseBasicParsing $a.browser_download_url -OutFile $zip
  $h = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($a.digest) { if ($a.digest -ne "sha256:$h") { throw "SHA256 MISMATCH: $h vs $($a.digest)" }; 'SHA256 matches GitHub digest' } else { "SHA256 $h (no digest published)" }
  Expand-Archive $zip $w -Force
  $sig = Get-AuthenticodeSignature "$w\wacs.exe"; "wacs.exe signature: $($sig.Status) $($sig.SignerCertificate.Subject)"
}

$id = (Get-Website -Name 'LabStock sklad').id
# Let's Encrypt (win-acme 2.4 defaults to ZeroSSL which needs e-mail); filesystem validation because external :80 lands on IIS :6536
& "$w\wacs.exe" --baseuri https://acme-v02.api.letsencrypt.org/ --source iis --siteid $id --host sklad.gkib.kz --validation filesystem --webroot $root --manualtargetisiis --installation iis --sslport 3656 --accepttos --closeonfinish
"wacs exit code: $LASTEXITCODE"
Get-WebBinding -Name 'LabStock sklad' | Select-Object protocol, bindingInformation, sslFlags | Format-Table -AutoSize

$ok = $false
try {
  $q = [Net.HttpWebRequest]::Create('https://sklad.gkib.kz/login.html'); $q.Timeout = 15000
  $s = $q.GetResponse(); "HTTPS sklad: $([int]$s.StatusCode)  cert: $($q.ServicePoint.Certificate.Subject) | $($q.ServicePoint.Certificate.Issuer)"; $s.Close(); $ok = $true
} catch { "HTTPS sklad FAIL: $($_.Exception.InnerException.Message)" }
if ($ok) { Write-WebConfig $true; 'http -> https redirect enabled' } else { 'redirect NOT enabled (https not working yet)' }
try { $q = [Net.HttpWebRequest]::Create('http://127.0.0.1:6536/new/ru_RU/'); $s = $q.GetResponse(); "1C /new: $([int]$s.StatusCode)"; $s.Close() } catch { "1C /new FAIL: $($_.Exception.Message)" }
Get-ScheduledTask | Where-Object TaskName -match 'win-acme' | Select-Object TaskName, State | Format-Table -AutoSize
'DONE'
