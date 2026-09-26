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

param([ValidateSet('dedicated','default')] [string]$Mode = 'dedicated', [int]$Port = 9222)
# -Port: each extra placement window gets its own port AND its own profile (.chrome-bot-<port>), so each
# has its own betslip. :9222 keeps the original .chrome-bot profile.

$ErrorActionPreference = 'Stop'

# Anti-throttle flags: Chrome slows timers / defers paint on UNFOCUSED or occluded tabs, which makes
# CDP clicks miss and submits fail when you're using the laptop for something else. These keep every
# tab running full-speed in the background so the placer is reliable without you focusing the window.
$antiThrottle = @(
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion"
)
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "chrome.exe not found" }

if ($Mode -eq 'default') {
  if ($Port -ne 9222) { throw "-Mode default only on port 9222" }
  $running = Get-Process chrome -ErrorAction SilentlyContinue
  if ($running) {
    Write-Output "Chrome is still running ($($running.Count) processes). Close ALL Chrome windows first, then re-run."
    exit 1
  }
  $args = @(
    "--remote-debugging-port=$Port", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=$env:LocalAppData\Google\Chrome\User Data", "--profile-directory=Default"
  ) + $antiThrottle + @("https://www.sportybet.com/ng/")
} else {
  # Dedicated profile — a separate instance that coexists with the main Chrome.
  $dedicated = Join-Path (Get-Location) $(if ($Port -eq 9222) { ".chrome-bot" } else { ".chrome-bot-$Port" })
  New-Item -ItemType Directory -Force $dedicated | Out-Null
  # Extra windows open staggered (not exactly on top of the main one). Keep them open and un-minimized:
  # a minimized window stops painting and its clicks hang (the placer restores one if it finds it).
  $place = @()
  if ($Port -ne 9222) { $k = $Port - 9222; $place = @("--window-position=$(60 * $k),$(40 * $k)", "--window-size=1100,850") }
  $args = @(
    "--remote-debugging-port=$Port", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=$dedicated"
  ) + $place + $antiThrottle + @("https://www.sportybet.com/ng/")
}

# Launch DETACHED (Start-Process, not "& chrome | Out-Null"): the call operator blocks and Chrome dies
# when the launcher exits/times out — which is why the UI "Prepare browser" never brought the port up.
# Start-Process returns immediately and Chrome keeps running independently.
Start-Process -FilePath $chrome -ArgumentList $args
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try { $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2; Write-Output "OK ($Mode): debug port up -> $($v.Browser)"; break }
  catch { }
}
if ($Mode -eq 'dedicated') { Write-Output "Log into SportyBet in the new window (once), then tell the bot to verify." }
