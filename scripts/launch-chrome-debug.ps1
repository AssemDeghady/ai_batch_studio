$ErrorActionPreference = "Stop"

$chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "C:\Users\assem\ChromeDebug"
$url = "https://flow.google.com/"

Write-Host "Checking if ChromeDebug is already running on port 9222..." -ForegroundColor Cyan

$tcp = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
if ($tcp) {
  Write-Host "Port 9222 is ALREADY active!" -ForegroundColor Green
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
    Write-Host "Connected to Chrome ($($ver.Browser))." -ForegroundColor Green
    exit 0
  } catch {}
}

Write-Host "Launching Chrome with profile: $profileDir" -ForegroundColor Cyan
$cmd = '"{0}" --remote-debugging-port=9222 --user-data-dir="{1}" "{2}"' -f $chromeExe, $profileDir, $url
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }

if ($res.ReturnValue -ne 0) {
  Write-Host "WMI failed (ReturnValue $($res.ReturnValue)). Falling back to Start-Process..." -ForegroundColor Yellow
  Start-Process -FilePath $chromeExe -ArgumentList @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$profileDir",
    $url
  )
} else {
  Write-Host "Chrome spawned via WMI (ProcessId: $($res.ProcessId))." -ForegroundColor Green
}

Write-Host "Waiting for CDP to bind on port 9222..." -ForegroundColor Gray
$deadline = (Get-Date).AddSeconds(15)
$ready = $false

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 600
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2
    if ($ver.webSocketDebuggerUrl) {
      $ready = $true
      Write-Host "`nCHROME DEBUG READY!" -ForegroundColor Green
      Write-Host "  Browser:       $($ver.Browser)" -ForegroundColor Gray
      Write-Host "  WebSocket URL: $($ver.webSocketDebuggerUrl)" -ForegroundColor Gray
      break
    }
  } catch {}
}

if (-not $ready) {
  Write-Error "Chrome started but port 9222 failed to respond within 15 seconds."
  exit 1
}
