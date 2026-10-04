// lib/system/keep-awake.ts — stop Windows from sleeping while a session still has open bets.
//
// Why: on the night of 3–4 Oct the PC slept from 22:03 to 06:23 UTC. 11 of 13 slips were cut in that
// window with no checks running, and SportyBet's login expired meanwhile. While anything is live, a small
// PowerShell helper holds SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED): idle sleep is
// blocked, the screen may still turn off. It releases the request when told to, and exits by itself if
// this server process dies (it checks the parent every 30s), so it can never keep the PC awake forever.
// Not covered: closing a laptop lid (that follows the lid setting) or pulling the power.
// Windows only; elsewhere it does nothing.

import { spawn, type ChildProcess } from 'node:child_process'

const g = globalThis as { __ssmKeepAwake?: { child: ChildProcess | null; reason: string } }
const state = (g.__ssmKeepAwake ??= { child: null, reason: '' })   // one helper per server, across reloads

const script = (parent: number) => `
# the flag is declared int, not uint: Windows PowerShell reads 0x80000001 as a NEGATIVE Int32, which a uint
# parameter rejects — the call then silently never happened (caught testing, 2026-10-04)
$t = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(int f);' -Name P -Namespace KeepAwake -PassThru
while ($true) {
  [void]$t::SetThreadExecutionState(0x80000001)
  if (-not (Get-Process -Id ${parent} -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 30
}
[void]$t::SetThreadExecutionState(0x80000000)`

/** Hold (on=true) or release (on=false) the "don't sleep" request. Idempotent. */
export function keepAwake(on: boolean, reason = ''): void {
  if (process.platform !== 'win32') return
  const alive = state.child && state.child.exitCode == null && !state.child.killed
  if (on && !alive) {
    const encoded = Buffer.from(script(process.pid), 'utf16le').toString('base64')
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => { state.child = null })
    state.child = child
    state.reason = reason
    console.log(`[keep-awake] holding the PC awake: ${reason}`)
  } else if (!on && alive) {
    state.child!.kill()
    state.child = null
    console.log('[keep-awake] released')
  }
}

export const keepAwakeStatus = () => ({ on: !!(state.child && state.child.exitCode == null && !state.child.killed), reason: state.reason })
