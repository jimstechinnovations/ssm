/**
 * POST /api/sessions/[id]/place  { live?: boolean }
 * Start a placement run for this session's slips via the CDP placer (scripts/place-session.mjs →
 * place-all-cdp). DRY-RUN by default. A LIVE (real-money) run requires ALL of:
 *   - PLACEMENT_LIVE=1 in the environment
 *   - the debug browser up on :9222, logged in, in REAL mode, with enough balance
 * Returns immediately; the run proceeds in the background (truth-confirmed per slip, idempotent).
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { hostname } from 'node:os'
import { getSession, updateSession, sessionSummary, clearStop } from '@/lib/sessions/store'
import { browserStatus } from '@/lib/placement/browser'

export const runtime = 'nodejs'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  let live = false, join = false
  let workers = 1
  try { const b = await request.json(); live = Boolean(b?.live); join = Boolean(b?.join); workers = Math.min(8, Math.max(1, Number(b?.workers) || 1)) } catch { /* dry */ }
  const summary = await sessionSummary(session.id)
  if (summary.pending === 0) return Response.json({ error: 'No pending slips to place' }, { status: 409 })

  // A run is already active (maybe on ANOTHER PC). Live placement goes through the shared database queue,
  // so a second PC can safely JOIN it (no slip can be placed twice) — but only when asked explicitly, so a
  // double-click never starts an accidental second run on this PC.
  const stopReq = Boolean((session.meta as Record<string, unknown> | null)?.stopRequested)
  if (session.status === 'placing' && session.heartbeatAgeMs < 25_000 && !stopReq && !(live && join)) {
    return Response.json({ error: 'Already placing (possibly on another PC). Use “Add this PC” to place in parallel, or Stop it first.', active: true }, { status: 409 })
  }

  if (live) {
    // The real safety gate is the BROWSER STATE (up + logged in + REAL + balance) + the UI confirm +
    // per-slip truth confirmation — verified below. PLACEMENT_LIVE is an optional extra lock.
    const st = await browserStatus()
    if (!st.up) return Response.json({ error: 'Browser not up — press “Prepare browser” first' }, { status: 409 })
    if (!st.loggedIn) return Response.json({ error: 'Browser not logged into SportyBet — press “Prepare browser”' }, { status: 409 })
    if (st.mode === 'SIM') return Response.json({ error: 'Browser is in SIM mode — switch to REAL' }, { status: 409 })
    if (st.balance != null && st.balance < session.minStake) return Response.json({ error: `Balance ₦${st.balance} below min stake ₦${session.minStake}` }, { status: 409 })
  }

  if (!join) await clearStop(session.id, session.meta)   // fresh run: drop any stale stop flag (a join keeps the run's state)
  const origin = new URL(request.url).origin
  const args = ['scripts/place-session.mjs', session.code, '--base', origin, '--workers', String(workers), ...(live ? ['--live'] : [])]
  // Keep the placer's full output: one log file per run, per PC (logs/ is git-ignored). Diagnosing a failed
  // or stuck run starts here — the session page shows the file name.
  mkdirSync('logs', { recursive: true })
  const logFile = joinPath('logs', `placer-${session.code}-${hostname()}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const out = openSync(logFile, 'a')
  // Launch node DIRECTLY (no shell): on Windows a detached `cmd` wrapper does not pass the log file handles
  // on, so the run's output was lost. process.execPath is the same node that runs this server.
  const child = spawn(process.execPath, args, { stdio: ['ignore', out, out], detached: true, windowsHide: true })
  child.unref()

  if (live) await updateSession(session.id, { status: 'placing' })   // only live drives the run-state UI; dry is a rehearsal
  return Response.json({ started: true, live, join, workers, session: session.code, pending: summary.pending, logFile })
}
