# scripts/os-click.ps1 — physically click screen coords on the SportyBet window.
# Order matters: MOVE the cursor first (no focus needed), THEN foreground + click immediately, so
# there's no long move during which another app can steal foreground and eat the click. Foreground
# is retried and re-verified right before the click; aborts rather than clicking the wrong window.
param([int]$X, [int]$Y)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
}
public struct POINT { public int X; public int Y; }
'@
[Win]::SetProcessDPIAware() | Out-Null
[Win]::SystemParametersInfo(0x2001, 0, [IntPtr]::Zero, 0) | Out-Null   # SPI_SETFOREGROUNDLOCKTIMEOUT = 0

$w = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Sporty*' } | Select-Object -First 1
if (-not $w) { Write-Output "ERR: SportyBet window not found"; exit 2 }
$h = $w.MainWindowHandle

function Force-Foreground {
  $fg = [Win]::GetForegroundWindow()
  $fgT = [Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $my = [Win]::GetCurrentThreadId()
  [Win]::AttachThreadInput($my, $fgT, $true) | Out-Null
  [Win]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
  [Win]::ShowWindow($script:h, 3) | Out-Null            # SW_MAXIMIZE — also input-activates
  [Win]::BringWindowToTop($script:h) | Out-Null
  [Win]::SetForegroundWindow($script:h) | Out-Null
  [Win]::keybd_event(0x12, 0, 0x0002, [IntPtr]::Zero)
  [Win]::AttachThreadInput($my, $fgT, $false) | Out-Null
}

$rnd = New-Object System.Random

# 1. MOVE the cursor to the target first (does not require foreground)
$p = New-Object POINT; [Win]::GetCursorPos([ref]$p) | Out-Null
$steps = 22
for ($i = 1; $i -le $steps; $i++) {
  $t = $i / $steps
  if ($t -lt 0.5) { $ease = 2*$t*$t } else { $ease = 1 - [Math]::Pow(-2*$t+2,2)/2 }
  if ($i -lt $steps) { $jx = $rnd.Next(-2,3); $jy = $rnd.Next(-2,3) } else { $jx = 0; $jy = 0 }
  [Win]::SetCursorPos([int]($p.X + ($X - $p.X) * $ease) + $jx, [int]($p.Y + ($Y - $p.Y) * $ease) + $jy) | Out-Null
  Start-Sleep -Milliseconds ($rnd.Next(6,16))
}
[Win]::SetCursorPos($X, $Y) | Out-Null

# 2. foreground with retry, verifying right before the click (small gap = no time to steal focus)
$ok = $false
for ($try = 1; $try -le 8; $try++) {
  Force-Foreground
  Start-Sleep -Milliseconds 250
  if ([Win]::GetForegroundWindow() -eq $h) { $ok = $true; break }
  Start-Sleep -Milliseconds 200
}
if (-not $ok) { Write-Output "ERR: could not hold SportyBet foreground after retries. Not clicking."; exit 3 }
Write-Output "foregrounded: $($w.MainWindowTitle)"

# 3. click IMMEDIATELY (cursor already at target, window just verified foreground)
[Win]::SetCursorPos($X, $Y) | Out-Null
[Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds ($rnd.Next(45,90))
[Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
$f = New-Object POINT; [Win]::GetCursorPos([ref]$f) | Out-Null
Write-Output "clicked at $($f.X),$($f.Y)"
