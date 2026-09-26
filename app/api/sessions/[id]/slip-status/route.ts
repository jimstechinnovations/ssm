/**
 * POST /api/sessions/[id]/slip-status — the placer reports each slip's outcome here so the session
 * page shows live progress. Body: { slipId, status, bookingCode?, betId?, failureReason?, live? }.
 * The response carries { stop } — the placer stops between slips when the user hits Stop. This POST
 * also doubles as the run heartbeat (touches the session), so a crashed/closed run reads as stalled.
 */

import { z } from 'zod'
import { getSession, updateSessionSlipStatus, touchSession } from '@/lib/sessions/store'

export const runtime = 'nodejs'

const Schema = z.object({
  slipId: z.number().int(),
  status: z.enum(['pending', 'placing', 'placed', 'failed', 'skipped', 'retry', 'verify']),
  worker: z.string().optional(),                           // queue mode: only the lease holder may report
  bookingCode: z.string().nullish(),
  betId: z.string().nullish(),
  failureReason: z.string().nullish(),
  live: z.boolean().optional(),
  droppedFixtures: z.array(z.number().int()).optional(),   // legs the placer dropped (game suspended at placement)
  placedLegs: z.number().int().optional(),                 // actual leg count on the real bet
  // the SITE's own numbers, read off the betslip right before Confirm (what was really staked)
  siteOdds: z.number().positive().nullish(),
  siteStake: z.number().positive().nullish(),
  sitePayout: z.number().positive().nullish(),
  placedFixtures: z.array(z.number().int()).nullish(),
})

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const stopReq = Boolean((session.meta as Record<string, unknown> | null)?.stopRequested)
  // Heartbeat-only ping: the placer sends this every ~10s so a live-but-busy run (retrying/respawning
  // between slips) isn't misread as "stalled". Just touch the session + return the stop flag.
  if (body && typeof body === 'object' && (body as { heartbeat?: unknown }).heartbeat) {
    await touchSession(session.id)
    return Response.json({ updated: true, stop: stopReq, heartbeat: true })
  }
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => i.message) }, { status: 400 })
  const ok = await updateSessionSlipStatus(session.id, parsed.data.slipId, parsed.data)
  // queue mode: a false here means this worker no longer holds the slip (lease lost) — tell it, don't 500
  if (!ok && parsed.data.worker) { await touchSession(session.id); return Response.json({ updated: false, notOwner: true, stop: Boolean((session.meta as Record<string, unknown> | null)?.stopRequested) }) }
  await touchSession(session.id)   // heartbeat: proves the run is alive
  const stop = Boolean((session.meta as Record<string, unknown> | null)?.stopRequested)
  return ok ? Response.json({ updated: true, stop }) : Response.json({ error: 'update failed', stop }, { status: 500 })
}
