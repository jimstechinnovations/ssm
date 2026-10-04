// lib/monitor/scheduler.ts — the live monitor runs on its own, page open or not.
//
// Before: a check only ran while the session page was open (or someone polled it), and the PC could
// sleep. Now the server itself checks every session with open bets every 5 minutes, and keeps Windows
// awake while there are any (lib/system/keep-awake.ts). It calls the monitor's own route over HTTP —
// the route already serialises ticks per session and runs in the normal server context.
// Started from instrumentation.ts; MONITOR_SCHEDULER=off disables it.

import { keepAwake } from '../system/keep-awake'

const EVERY_MS = 5 * 60_000
const RECENT_MS = 4 * 24 * 3_600_000      // sessions older than this are not live, whatever they say

const g = globalThis as { __ssmMonitorScheduler?: { timer: ReturnType<typeof setInterval>; running: boolean } }

type Listed = { id: string; code: string; createdAt: string; summary?: { open?: number } }

async function runOnce(base: string) {
  const s = g.__ssmMonitorScheduler
  if (!s || s.running) return
  s.running = true
  try {
    const r = await fetch(`${base}/api/sessions?limit=15`, { cache: 'no-store', signal: AbortSignal.timeout(60_000) })
    const list = ((await r.json()) as { sessions?: Listed[] }).sessions ?? []
    const live = list.filter(x => (x.summary?.open ?? 0) > 0 && Date.now() - Date.parse(x.createdAt) < RECENT_MS)
    keepAwake(live.length > 0, live.map(x => `${x.code} (${x.summary?.open} open)`).join(', '))
    for (const x of live) {
      // not forced: the route skips a session checked in the last 4 minutes (an open page may have just done it)
      await fetch(`${base}/api/sessions/${x.id}/monitor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(280_000) })
        .catch(e => console.warn(`[monitor] ${x.code}: ${e instanceof Error ? e.message : e}`))
    }
  } catch (e) {
    console.warn(`[monitor] scheduler: ${e instanceof Error ? e.message : e}`)
  } finally { s.running = false }
}

export function startMonitorScheduler() {
  if (g.__ssmMonitorScheduler) return                      // once per server process (dev reloads re-run register)
  const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`
  g.__ssmMonitorScheduler = { timer: setInterval(() => void runOnce(base), EVERY_MS), running: false }
  setTimeout(() => void runOnce(base), 30_000)             // first pass once the server is up
  console.log(`[monitor] scheduler on: every ${EVERY_MS / 60_000} min, sessions with open bets`)
}
