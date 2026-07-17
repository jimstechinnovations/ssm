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
  status: z.enum(['pending', 'placing', 'placed', 'failed', 'skipped']),
  bookingCode: z.string().nullish(),
  betId: z.string().nullish(),
  failureReason: z.string().nullish(),
  live: z.boolean().optional(),
})

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => i.message) }, { status: 400 })
  const ok = await updateSessionSlipStatus(session.id, parsed.data.slipId, parsed.data)
  await touchSession(session.id)   // heartbeat: proves the run is alive
  const stop = Boolean((session.meta as Record<string, unknown> | null)?.stopRequested)
  return ok ? Response.json({ updated: true, stop }) : Response.json({ error: 'update failed', stop }, { status: 500 })
}
