/**
 * POST /api/sessions/[id]/place  { live?: boolean }
 * Start a placement run for this session's slips via the CDP placer (scripts/place-session.mjs →
 * place-all-cdp). DRY-RUN by default. A LIVE (real-money) run requires ALL of:
 *   - PLACEMENT_LIVE=1 in the environment
 *   - the debug browser up on :9222, logged in, in REAL mode, with enough balance
 * Returns immediately; the run proceeds in the background (truth-confirmed per slip, idempotent).
 */

import { spawn } from 'node:child_process'
import { getSession, updateSession, sessionSummary, clearStop } from '@/lib/sessions/store'
import { isLivePlacementAllowed } from '@/lib/placement/queue'
import { browserStatus } from '@/lib/placement/browser'

export const runtime = 'nodejs'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  let live = false
  let workers = 1
  try { const b = await request.json(); live = Boolean(b?.live); workers = Math.min(8, Math.max(1, Number(b?.workers) || 1)) } catch { /* dry */ }
  const summary = await sessionSummary(session.id)
  if (summary.pending === 0) return Response.json({ error: 'No pending slips to place' }, { status: 409 })

  // Guard against a second concurrent run (double-click / two tabs): a fresh heartbeat + not-stopped
  // means a placer is already working — two placers would collide on submits (per-process mutex).
  const heartbeatMs = Date.now() - Date.parse(session.updatedAt)
  const stopReq = Boolean((session.meta as Record<string, unknown> | null)?.stopRequested)
  if (session.status === 'placing' && heartbeatMs < 25_000 && !stopReq) {
    return Response.json({ error: 'A placement run is already active for this session — Stop it first, or wait for it to finish.' }, { status: 409 })
  }

  if (live) {
    if (!isLivePlacementAllowed()) return Response.json({ error: 'Live placement locked — set PLACEMENT_LIVE=1' }, { status: 403 })
    const st = await browserStatus()
    if (!st.up) return Response.json({ error: 'Browser not up — launch it first (/config)' }, { status: 409 })
    if (!st.loggedIn) return Response.json({ error: 'Browser not logged into SportyBet' }, { status: 409 })
    if (st.mode === 'SIM') return Response.json({ error: 'Browser is in SIM mode — switch to REAL' }, { status: 409 })
    if (st.balance != null && st.balance < session.minStake) return Response.json({ error: `Balance ₦${st.balance} below min stake ₦${session.minStake}` }, { status: 409 })
  }

  await clearStop(session.id, session.meta)   // fresh run: drop any stale stop flag
  const origin = new URL(request.url).origin
  const args = ['scripts/place-session.mjs', session.code, '--base', origin, '--workers', String(workers), ...(live ? ['--live'] : [])]
  const child = spawn('node', args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
  child.unref()

  if (live) await updateSession(session.id, { status: 'placing' })   // only live drives the run-state UI; dry is a rehearsal
  return Response.json({ started: true, live, workers, session: session.code, pending: summary.pending })
}
