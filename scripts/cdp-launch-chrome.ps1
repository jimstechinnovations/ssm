# scripts/cdp-launch-chrome.ps1
# Launch a genuine Chrome with a DevTools debug port so the bot can attach over CDP and drive a
# real, REAL-mode SportyBet session (no Playwright launcher = no navigator.webdriver = no SIM-lock).
#
#   -Mode dedicated (default): a SEPARATE Chrome window (its own profile dir), runs ALONGSIDE your
#       main Chrome, non-disruptive. Log into SportyBet in it ONCE; it persists for future runs.
#   -Mode default: your real "Default" profile (already logged into SportyBet). Requires ALL Chrome
#       closed first; tabs restore on relaunch and the SportyBet login persists.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/cdp-launch-chrome.ps1 [-Mode dedicated|default]

param([ValidateSet('dedicated','default')] [string]$Mode = 'dedicated')

$ErrorActionPreference = 'Stop'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "chrome.exe not found" }

if ($Mode -eq 'default') {
  $running = Get-Process chrome -ErrorAction SilentlyContinue
  if ($running) {
    Write-Output "Chrome is still running ($($running.Count) processes). Close ALL Chrome windows first, then re-run."
    exit 1
  }
  $args = @(
    "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=$env:LocalAppData\Google\Chrome\User Data", "--profile-directory=Default",
    "https://www.sportybet.com/ng/"
  )
} else {
  # Dedicated profile — a separate instance that coexists with the main Chrome.
  $dedicated = Join-Path (Get-Location) ".chrome-bot"
  New-Item -ItemType Directory -Force $dedicated | Out-Null
  $args = @(
    "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=$dedicated",
    "https://www.sportybet.com/ng/"
  )
}

& $chrome @args | Out-Null
Start-Sleep -Seconds 4
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5
  Write-Output "OK ($Mode): debug port up -> $($v.Browser)"
  if ($Mode -eq 'dedicated') { Write-Output "Log into SportyBet in the new window (once), then tell the bot to verify." }
} catch {
  Write-Output "WARN: debug port not responding yet; give Chrome a few seconds."
}
