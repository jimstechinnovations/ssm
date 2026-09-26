# scripts/restore-chrome-window.ps1
# Un-minimize the placement Chrome on a debug port WITHOUT stealing focus. A minimized Chrome window stops
# rendering: its page freezes, clicks hang and even CDP evaluate never returns (seen 2026-09-26). CDP can't
# restore it ("Browser window not found"), so the placer calls this when its page goes hidden.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-chrome-window.ps1 -Port 9223

param([int]$Port = 9222)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PlacerWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
$main = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like "*remote-debugging-port=$Port*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
if (-not $main) { Write-Output "no Chrome on :$Port"; exit 1 }
$restored = 0
[PlacerWin]::EnumWindows({ param($h, $p)
  $wpid = 0; [PlacerWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
  if ($wpid -eq $main.ProcessId -and [PlacerWin]::IsWindowVisible($h) -and [PlacerWin]::IsIconic($h)) { [PlacerWin]::ShowWindow($h, 4) | Out-Null; $script:restored++ }   # 4 = SW_SHOWNOACTIVATE
  return $true }, [IntPtr]::Zero) | Out-Null
Write-Output "restored $restored window(s) on :$Port"
