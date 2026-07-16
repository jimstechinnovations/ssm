# scripts/os-clickonly.ps1 — ACTIVATE the SportyBet window for input (SetForegroundWindow, NO
# maximize so the betslip scroll is preserved), then human-like move + click via SendInput.
# A synthetic click only registers on an input-ACTIVE window; foreground z-order alone isn't enough.
param([int]$X, [int]$Y)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
public class Wc {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
'@
[Wc]::SetProcessDPIAware() | Out-Null
$w = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Sporty*' } | Select-Object -First 1
if (-not $w) { Write-Output "ERR: SportyBet window not found"; exit 2 }
$h = $w.MainWindowHandle

# ACTIVATE for input (no ShowWindow → scroll preserved). Defeat the foreground lock via AttachThreadInput+ALT.
$fg = [Wc]::GetForegroundWindow()
$fgT = [Wc]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$my = [Wc]::GetCurrentThreadId()
[Wc]::AttachThreadInput($my, $fgT, $true) | Out-Null
[Wc]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[Wc]::BringWindowToTop($h) | Out-Null
[Wc]::SetForegroundWindow($h) | Out-Null
[Wc]::SetActiveWindow($h) | Out-Null
[Wc]::keybd_event(0x12, 0, 0x0002, [IntPtr]::Zero)
[Wc]::AttachThreadInput($my, $fgT, $false) | Out-Null
Start-Sleep -Milliseconds 700
$now = [Wc]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256; [Wc]::GetWindowText($now, $sb, 256) | Out-Null
if ($sb.ToString() -notlike '*Sporty*') { Write-Output "ERR: SportyBet not active (fg='$($sb.ToString())'). Not clicking."; exit 3 }

# human-like move
$p = New-Object POINT; [Wc]::GetCursorPos([ref]$p) | Out-Null
$rnd = New-Object System.Random; $steps = 26
for ($i=1; $i -le $steps; $i++) {
  $t=$i/$steps; if ($t -lt 0.5) { $e=2*$t*$t } else { $e=1-[Math]::Pow(-2*$t+2,2)/2 }
  if ($i -lt $steps) { $jx=$rnd.Next(-2,3); $jy=$rnd.Next(-2,3) } else { $jx=0; $jy=0 }
  [Wc]::SetCursorPos([int]($p.X+($X-$p.X)*$e)+$jx, [int]($p.Y+($Y-$p.Y)*$e)+$jy) | Out-Null
  Start-Sleep -Milliseconds ($rnd.Next(8,20))
}
[Wc]::SetCursorPos($X,$Y) | Out-Null
Start-Sleep -Milliseconds ($rnd.Next(140,260))

# click via SendInput (LEFTDOWN=0x0002, LEFTUP=0x0004) at current cursor pos
$down = New-Object INPUT; $down.type = 0; $down.mi.dwFlags = 0x0002
$up   = New-Object INPUT; $up.type   = 0; $up.mi.dwFlags   = 0x0004
[Wc]::SendInput(1, @($down), [Runtime.InteropServices.Marshal]::SizeOf([type][INPUT])) | Out-Null
Start-Sleep -Milliseconds ($rnd.Next(50,95))
[Wc]::SendInput(1, @($up), [Runtime.InteropServices.Marshal]::SizeOf([type][INPUT])) | Out-Null
$f = New-Object POINT; [Wc]::GetCursorPos([ref]$f) | Out-Null
Write-Output "clicked at $($f.X),$($f.Y)"
