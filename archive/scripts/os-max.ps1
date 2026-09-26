# scripts/os-max.ps1 — force the SportyBet window to the foreground + MAXIMIZE (no click), defeating
# the Windows foreground lock (AttachThreadInput + ALT). Reports whether it actually came forward.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class WinMax {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
}
'@
[WinMax]::SetProcessDPIAware() | Out-Null
[WinMax]::SystemParametersInfo(0x2001, 0, [IntPtr]::Zero, 0) | Out-Null   # SPI_SETFOREGROUNDLOCKTIMEOUT = 0
$w = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*SportyBet*' } | Select-Object -First 1
if (-not $w) { Write-Output "ERR: SportyBet window not found"; exit 2 }
$h = $w.MainWindowHandle

$fg = [WinMax]::GetForegroundWindow()
$fgThread = [WinMax]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$myThread = [WinMax]::GetCurrentThreadId()
[WinMax]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
[WinMax]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)         # ALT down
[WinMax]::ShowWindow($h, 3) | Out-Null                    # SW_MAXIMIZE
[WinMax]::BringWindowToTop($h) | Out-Null
[WinMax]::SetForegroundWindow($h) | Out-Null
[WinMax]::keybd_event(0x12, 0, 0x0002, [IntPtr]::Zero)    # ALT up
[WinMax]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
Start-Sleep -Milliseconds 900
$now = [WinMax]::GetForegroundWindow()
if ($now -eq $h) { Write-Output "OK: SportyBet is foreground + maximized" } else { Write-Output "WARN: SportyBet maximized but NOT foreground (handle $now vs $h)" }
