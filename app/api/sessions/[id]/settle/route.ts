/**
 * POST /api/sessions/[id]/settle — refresh live results for EVERY game in the session and settle
 * placed slips. Two independent things happen:
 *   1. GAME OUTCOMES: we fetch results for all distinct fixtures (every slip shares the pool) and
 *      persist them to session.meta.gameResults — so the UI keeps showing each game's outcome as it
 *      finishes, EVEN for slips already lost (one leg cut it, but we still track the rest).
 *   2. SLIP SETTLEMENT: still-unsettled slips are settled with early-cut (lost the moment one leg is
 *      contradicted; won when all legs finished+correct; else pending). Re-runnable as games finish.
 */

import { getSession, updateSession, listPlacedSlipsWithLegs, settleSessionSlip, sessionSummary } from '@/lib/sessions/store'
import { fetchResults } from '@/lib/pedlas/results'
import { settleSlip, cutLegs, type SlipLeg } from '@/lib/pedlas/settle-slips'
import { getBookConfig } from '@/lib/books/config-store'
import { getBook } from '@/lib/books/registry'
import { boostFromTable, reconciledPayout } from '@/lib/pedlas/boost'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const allPlaced = await listPlacedSlipsWithLegs(session.id) // placed + won + lost, with legs
  if (allPlaced.length === 0) return Response.json({ checked: 0, settled: 0, note: 'no placed slips yet' })

  // ── 1. ALL games in the session (union across every slip — the pool is shared) ──
  const legLine = (l: SlipLeg) => (l as SlipLeg & { line?: number }).line ?? 4.5
  const fixtureIds = [...new Set(allPlaced.flatMap(s => (s.legs as SlipLeg[]).map(l => l.fixtureId)))]
  const lineByFixture = new Map<number, number>()
  for (const s of allPlaced) for (const l of s.legs as SlipLeg[]) if (!lineByFixture.has(l.fixtureId)) lineByFixture.set(l.fixtureId, legLine(l))

  const results = await fetchResults(fixtureIds)
  const finishedCount = [...results.values()].filter(r => r?.finished).length

  // Persist per-game outcomes so the UI keeps updating them regardless of slip status.
  const gameResults = fixtureIds.map(fid => {
    const r = results.get(fid)
    const line = lineByFixture.get(fid) ?? 4.5
    return { fixtureId: fid, finished: !!r?.finished, total: r?.finished ? (r?.total ?? null) : null, over: r?.finished ? (r!.total > line) : null }
  })
  // touch:false — persisting outcomes must NOT bump the placer heartbeat (would make an idle session
  // look like it's actively placing again).
  await updateSession(session.id, { meta: { ...(session.meta ?? {}), gameResults, gameResultsAt: new Date().toISOString() } }, { touch: false })

  // ── 2. Settle the still-unsettled slips (early-cut), judged on the legs ACTUALLY placed ──
  // A won slip pays only its live legs: if any leg was dropped at placement (suspended), the real bet is
  // the shorter combo, so credit the reconciled (shorter) payout — not the original 32-leg payout.
  const anyDropped = allPlaced.some(s => (s.legs as (SlipLeg & { suspended?: boolean })[]).some(l => l.suspended))
  let boost = null as ReturnType<typeof boostFromTable> | null, cap = Infinity
  if (anyDropped) {
    const cfg = await getBookConfig(session.bookIds[0]); const adapter = getBook(session.bookIds[0])
    boost = cfg.boost ? boostFromTable(cfg.boost) : adapter.boostFor
    cap = Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout)
  }
  const unsettled = allPlaced.filter(s => s.status === 'placed')
  let won = 0, lost = 0, pending = 0
  for (const s of unsettled) {
    const legs = s.legs as (SlipLeg & { suspended?: boolean; odds?: number })[]
    const verdict = settleSlip(legs, results)
    if (verdict === 'pending') { pending++; continue }
    const dropped = legs.some(l => l.suspended)
    const returned = verdict !== 'won' ? 0
      : (dropped && boost) ? reconciledPayout(legs, Number(s.stake), boost, cap) : (s.potentialPayout ?? 0)
    const note = verdict === 'lost' ? `cut by ${cutLegs(legs, results).slice(0, 2).map(l => l.fixtureId).join(', ')}` : (dropped ? 'live legs landed (shorter combo)' : 'all legs landed')
    await settleSessionSlip(session.id, s.slipId, verdict === 'won', returned, note)
    if (verdict === 'won') won++; else lost++
  }

  return Response.json({
    checked: unsettled.length, gamesFinished: finishedCount, of: fixtureIds.length,
    settled: won + lost, won, lost, pending, gameResults, summary: await sessionSummary(session.id),
  })
}
