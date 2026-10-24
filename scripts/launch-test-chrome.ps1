<#
.SYNOPSIS
  Launch Google Chrome with the dedicated Batch Studio test profile and DevTools remote debugging.

.DESCRIPTION
  This script locates Google Chrome, attaches the unpacked Batch Studio extension from dist,
  uses the dedicated isolated test profile, and binds CDP to 127.0.0.1:9222.
  It can be run directly from any PowerShell terminal or by right-clicking.
#>

param(
  [int]$Port = 9222,
  [string]$ProfileDir = "C:\Users\assem\.gemini\antigravity\chrome-test-profile",
  [string]$ExtensionDist = "$PSScriptRoot\..\dist",
  [string]$Url = "https://flow.google/"
)

$ErrorActionPreference = "Stop"

Write-Host "================ BATCH STUDIO CHROME LAUNCHER ================" -ForegroundColor Cyan

# 1. Resolve Chrome executable
$chromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)

$chromeExe = $null
foreach ($path in $chromeCandidates) {
  if (Test-Path $path) {
    $chromeExe = $path
    break
  }
}

if (-not $chromeExe) {
  $whereLookup = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($whereLookup) {
    $chromeExe = $whereLookup.Source
  }
}

if (-not $chromeExe) {
  Write-Error "Google Chrome executable was not found. Please install Chrome or verify path."
  exit 1
}

Write-Host "Chrome executable: $chromeExe" -ForegroundColor Gray
Write-Host "Dedicated profile: $ProfileDir" -ForegroundColor Gray
Write-Host "Extension dist:    $ExtensionDist" -ForegroundColor Gray
Write-Host "CDP Port:          $Port" -ForegroundColor Gray

# 2. Check if already running on port
$isOpen = $false
try {
  $tcp = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
  if ($tcp) { $isOpen = $true }
} catch {}

if ($isOpen) {
  Write-Host "`nPort $Port is already open. Checking CDP endpoint..." -ForegroundColor Yellow
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    Write-Host "Chrome is ALREADY active on port $Port ($($ver.Browser))." -ForegroundColor Green
    Write-Host "WebSocket URL: $($ver.webSocketDebuggerUrl)" -ForegroundColor Gray
    Write-Host "`nYou can run 'node scripts/browser-harness.mjs observe' directly." -ForegroundColor Cyan
    exit 0
  } catch {
    Write-Host "Port $Port is in use but CDP did not respond. Check running processes." -ForegroundColor Red
  }
}

# 3. Ensure profile directory exists
if (-not (Test-Path $ProfileDir)) {
  New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

# 4. Resolve absolute dist path
$resolvedDist = (Resolve-Path $ExtensionDist).Path

# 5. Launch Chrome using WMI to detach from Job Object
Write-Host "`nLaunching independent Chrome via WMI..." -ForegroundColor Cyan
$cmd = '"{0}" --remote-debugging-port={1} --user-data-dir="{2}" --disable-extensions-except="{3}" --load-extension="{3}" --no-first-run --no-default-browser-check "{4}"' -f $chromeExe, $Port, $ProfileDir, $resolvedDist, $Url

$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }

if ($res.ReturnValue -ne 0) {
  Write-Host "WMI failed (ReturnValue $($res.ReturnValue)). Falling back to Start-Process..." -ForegroundColor Yellow
  $proc = Start-Process -FilePath $chromeExe -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--disable-extensions-except=$resolvedDist",
    "--load-extension=$resolvedDist",
    "--no-first-run",
    "--no-default-browser-check",
    $Url
  ) -PassThru
  $pidToWatch = $proc.Id
} else {
  $pidToWatch = $res.ProcessId
}

Write-Host "Spawned Chrome Process ID: $pidToWatch" -ForegroundColor Green

# 6. Verify CDP responsiveness
Write-Host "Waiting for CDP endpoint to respond (15s timeout)..." -ForegroundColor Gray
$deadline = (Get-Date).AddSeconds(15)
$ready = $false

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 600
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    if ($ver.webSocketDebuggerUrl) {
      $ready = $true
      Write-Host "`nBrowser is READY!" -ForegroundColor Green
      Write-Host "  Browser:       $($ver.Browser)" -ForegroundColor Gray
      Write-Host "  WebSocket URL: $($ver.webSocketDebuggerUrl)" -ForegroundColor Gray
      break
    }
  } catch {}
}

if (-not $ready) {
  Write-Error "Chrome started but CDP endpoint at http://127.0.0.1:$Port/json/version failed to respond within 15 seconds."
  exit 1
}

Write-Host "`nSuccess! Run 'node scripts/browser-harness.mjs observe' to inspect Google Flow." -ForegroundColor Cyan
