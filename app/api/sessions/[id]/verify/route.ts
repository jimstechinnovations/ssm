/**
 * /api/sessions/[id]/verify — slips whose worker vanished MID-SUBMIT (status 'verify'). Such a slip may or
 * may not be on SportyBet, so it is never re-placed on a guess: it is checked against the account's bet
 * history (automatically by the placer, or by you) and resolved either way.
 *
 *   GET                                         → { slips: [{ slipId, stake, legs, submitStartedAt, lastError }] }
 *   POST { slipId, placed, bookingCode?, betId?, note? } → { resolved }
 *        placed=true  → recorded as placed (it IS on bet history)
 *        placed=false → returned to the queue (it is NOT on bet history)
 */

import { z } from 'zod'
import { getSession, resolveVerify } from '@/lib/sessions/store'
import { createServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const { data, error } = await ((createServerClient() as any).from('pedla_placements')
    .select('slip_id,stake,legs,booking_code,submit_started_at,last_error').eq('session_id', session.id).eq('status', 'verify').order('slip_id')) as { data: any[] | null; error: unknown }
  if (error) return Response.json({ error: 'read failed' }, { status: 500 })
  return Response.json({
    slips: (data ?? []).map(r => ({ slipId: r.slip_id, stake: Number(r.stake), legs: r.legs ?? [], bookingCode: r.booking_code, submitStartedAt: r.submit_started_at, lastError: r.last_error })),
  })
}

const Body = z.object({ slipId: z.number().int(), placed: z.boolean(), bookingCode: z.string().nullish(), betId: z.string().nullish(), note: z.string().max(300).optional() })

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const p = Body.safeParse(body)
  if (!p.success) return Response.json({ error: 'Validation failed' }, { status: 400 })
  const resolved = await resolveVerify(session.id, p.data.slipId, p.data.placed, { bookingCode: p.data.bookingCode, betId: p.data.betId, note: p.data.note })
  return resolved ? Response.json({ resolved: true }) : Response.json({ resolved: false, error: 'slip is not awaiting verification' }, { status: 409 })
}
