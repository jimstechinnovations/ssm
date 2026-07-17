/**
 * POST /api/sessions/[id]/settle — check live results and settle placed slips. A slip is marked LOST
 * the moment one leg is contradicted (early cut — no need to wait for the other games); WON when every
 * leg is finished and correct; else left pending. Re-runnable as more games finish.
 */

import { getSession, listPlacedSlipsWithLegs, settleSessionSlip, sessionSummary } from '@/lib/sessions/store'
import { fetchResults } from '@/lib/pedlas/results'
import { settleSlip, cutLegs, type SlipLeg } from '@/lib/pedlas/settle-slips'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const placed = (await listPlacedSlipsWithLegs(session.id)).filter(s => s.status === 'placed') // not-yet-settled
  if (placed.length === 0) return Response.json({ checked: 0, settled: 0, note: 'no unsettled placed slips' })

  const fixtureIds = [...new Set(placed.flatMap(s => (s.legs as SlipLeg[]).map(l => l.fixtureId)))]
  const results = await fetchResults(fixtureIds)
  const finishedCount = [...results.values()].filter(r => r?.finished).length

  let won = 0, lost = 0, pending = 0
  for (const s of placed) {
    const legs = s.legs as SlipLeg[]
    const verdict = settleSlip(legs, results)
    if (verdict === 'pending') { pending++; continue }
    const returned = verdict === 'won' ? (s.potentialPayout ?? 0) : 0
    const note = verdict === 'lost' ? `cut by ${cutLegs(legs, results).slice(0, 2).map(l => l.fixtureId).join(', ')}` : 'all legs landed'
    await settleSessionSlip(session.id, s.slipId, verdict === 'won', returned, note)
    if (verdict === 'won') won++; else lost++
  }

  return Response.json({ checked: placed.length, gamesFinished: finishedCount, of: fixtureIds.length, settled: won + lost, won, lost, pending, summary: await sessionSummary(session.id) })
}
