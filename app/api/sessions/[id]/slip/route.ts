/**
 * GET /api/sessions/[id]/slip?slipId=N — one slip's legs (games + Under/Over side + odds) for the
 * click-to-view overlay. Pulls the heavy legs JSON for a single slip only.
 */

import { getSession, getSessionSlip } from '@/lib/sessions/store'

export const runtime = 'nodejs'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const slipId = Number(new URL(request.url).searchParams.get('slipId'))
  if (!slipId) return Response.json({ error: 'slipId required' }, { status: 400 })

  const slip = await getSessionSlip(session.id, slipId)   // single-row query
  if (!slip) return Response.json({ error: 'Slip not found' }, { status: 404 })
  const legs = (slip.legs as Array<{ fixtureId: number; game: string; kickoff: string; line: number; side: string; odds: number }> | undefined) ?? []
  return Response.json({
    slipId: slip.slipId, status: slip.status, stake: slip.stake, combinedOdds: slip.combinedOdds,
    payout: slip.potentialPayout, bookingCode: slip.bookingCode, betId: slip.betId,
    legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, kickoff: l.kickoff, line: l.line, side: l.side, odds: l.odds }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff)),
  })
}
