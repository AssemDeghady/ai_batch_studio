<#
.SYNOPSIS
  Safely start the user's existing Chrome session with DevTools debugging on 127.0.0.1:9222.

.DESCRIPTION
  This script allows Batch Studio harness to connect to your REAL, already-authenticated Chrome session
  (preserving all Google logins, cookies, history, and extensions).
  
  SAFETY RULES:
  - Binds ONLY to 127.0.0.1 (localhost). Never exposed to network.
  - Never touches or deletes user profile data.
  - Never force-terminates running Chrome without user confirmation.
#>

$ErrorActionPreference = "Stop"

Write-Host "================ BATCH STUDIO: EXISTING CHROME SESSION LAUNCHER ================" -ForegroundColor Cyan

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
  Write-Error "Google Chrome executable was not found. Please install Chrome or verify path."
  exit 1
}

# 2. Check if Chrome is currently running
$runningProcs = Get-Process -Name chrome -ErrorAction SilentlyContinue

# Check if port 9222 is ALREADY open
$tcp = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
if ($tcp) {
  Write-Host "Port 9222 is ALREADY active!" -ForegroundColor Green
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
    Write-Host "Connected to Chrome ($($ver.Browser))." -ForegroundColor Green
    Write-Host "You can now run 'node scripts/browser-harness.mjs observe' to inspect Google Flow." -ForegroundColor Cyan
    exit 0
  } catch {}
}

if ($runningProcs) {
  Write-Host "`n[!] Chrome is currently running ($($runningProcs.Count) processes detected)." -ForegroundColor Yellow
  Write-Host "    Chromium security prevents retroactively attaching a debugger to an already-running session." -ForegroundColor Yellow
  Write-Host "`nTo enable debugging on your normal profile:" -ForegroundColor White
  Write-Host "  1. Save your open work in Chrome." -ForegroundColor White
  Write-Host "  2. Close all Chrome windows completely." -ForegroundColor White
  Write-Host "  3. Re-run this script: .\scripts\launch-existing-chrome.ps1" -ForegroundColor Cyan
  Write-Host "`n(When you restart, Chrome will offer 'Restore pages' to re-open your tabs with all logins intact.)" -ForegroundColor Gray
  exit 0
}

# 3. If Chrome is not running, launch it with remote debugging
Write-Host "`nStarting Chrome with your existing normal profile and remote debugging enabled..." -ForegroundColor Cyan
Start-Process -FilePath $chromeExe -ArgumentList @(
  "--remote-debugging-port=9222",
  "https://flow.google/"
)

Write-Host "Waiting for Chrome DevTools endpoint to bind on 127.0.0.1:9222..." -ForegroundColor Gray
$deadline = (Get-Date).AddSeconds(15)
$ready = $false

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 600
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2
    if ($ver.webSocketDebuggerUrl) {
      $ready = $true
      Write-Host "`nCHROME READY WITH EXISTING PROFILE!" -ForegroundColor Green
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

Write-Host "`nSuccess! Run 'node scripts/browser-harness.mjs observe' to inspect Google Flow." -ForegroundColor Cyan
