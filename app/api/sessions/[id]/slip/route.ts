/**
 * GET /api/sessions/[id]/slip?slipId=N — one slip's legs (games + Under/Over side + odds) for the
 * click-to-view overlay. Pulls the heavy legs JSON for a single slip only.
 */

import { getSession, getSessionSlip } from '@/lib/sessions/store'
import { getBookConfig } from '@/lib/books/config-store'
import { getBook } from '@/lib/books/registry'
import { boostFromTable } from '@/lib/pedlas/boost'
import { reconciledPayout } from '../reconcile/route'

export const runtime = 'nodejs'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const slipId = Number(new URL(request.url).searchParams.get('slipId'))
  if (!slipId) return Response.json({ error: 'slipId required' }, { status: 400 })

  const slip = await getSessionSlip(session.id, slipId)   // single-row query
  if (!slip) return Response.json({ error: 'Slip not found' }, { status: 404 })
  const legs = (slip.legs as Array<{ fixtureId: number; game: string; kickoff: string; line: number; side: string; odds: number; suspended?: boolean }> | undefined) ?? []
  // If reconcile marked any leg suspended, compute the shorter-combo payout (original stays for the UI).
  let reconciled: number | null = null
  if (legs.some(l => l.suspended)) {
    const cfg = await getBookConfig(session.bookIds[0]); const adapter = getBook(session.bookIds[0])
    const boost = cfg.boost ? boostFromTable(cfg.boost) : adapter.boostFor
    const cap = Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout)
    reconciled = reconciledPayout(legs, Number(slip.stake), boost, cap)
  }
  return Response.json({
    slipId: slip.slipId, status: slip.status, stake: slip.stake, combinedOdds: slip.combinedOdds,
    payout: slip.potentialPayout, reconciledPayout: reconciled, bookingCode: slip.bookingCode, betId: slip.betId,
    legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, kickoff: l.kickoff, line: l.line, side: l.side, odds: l.odds, suspended: !!l.suspended }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff)),
  })
}
