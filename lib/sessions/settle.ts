// lib/sessions/settle.ts — refresh results for every game in a session and settle its placed slips.
// Shared by POST /api/sessions/[id]/settle and the live monitor (lib/monitor/tick.ts).

import { getSession, updateSession, listPlacedSlipsWithLegs, settleSessionSlip, sessionSummary, effectivePayout } from '../sessions/store'
import { fetchResults } from '../pedlas/results'
import { settleSlip, flexiMinCorrect, cutLegs, type SlipLeg } from '../pedlas/settle-slips'
import { getBookConfig, bookBoost } from '../books/config-store'
import { getBook } from '../books/registry'
import { boostFromTable, reconciledPayout } from '../pedlas/boost'


type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>

export async function settleSessionNow(session: Session) {
  const allPlaced = await listPlacedSlipsWithLegs(session.id) // placed + won + lost, with legs
  if (allPlaced.length === 0) return ({ checked: 0, settled: 0, note: 'no placed slips yet' })

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
    return {
      fixtureId: fid, finished: !!r?.finished, total: r?.finished ? (r?.total ?? null) : null,
      home: r?.finished ? (r?.home ?? null) : null, away: r?.finished ? (r?.away ?? null) : null,
      over: r?.finished ? (r!.total > line) : null,   // legacy totals view only
    }
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
    boost = await bookBoost(session.bookIds[0])
    cap = Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout)
  }
  const unsettled = allPlaced.filter(s => s.status === 'placed')
  let won = 0, lost = 0, pending = 0
  for (const s of unsettled) {
    const legs = s.legs as (SlipLeg & { suspended?: boolean; odds?: number })[]
    const verdict = settleSlip(legs, results, { minCorrect: flexiMinCorrect(s.decision) })   // floor tickets: at least k of N
    if (verdict === 'pending') { pending++; continue }
    const dropped = legs.some(l => l.suspended)
    // Credit what the BOOK will pay: the site's own Potential Win captured at Confirm (exact — it already
    // reflects accepted odds changes, dropped legs and the real bonus). Older slips without a receipt fall
    // back to the reconciled shorter-combo payout, else the built payout.
    const returned = verdict !== 'won' ? 0
      : s.sitePayout != null ? s.sitePayout
      : (dropped && boost) ? reconciledPayout(legs, Number(s.stake), boost, cap) : effectivePayout(s)
    const note = verdict === 'lost' ? `cut by ${cutLegs(legs, results).slice(0, 2).map(l => l.fixtureId).join(', ')}` : (dropped ? 'live legs landed (shorter combo)' : 'all legs landed')
    await settleSessionSlip(session.id, s.slipId, verdict === 'won', returned, note)
    if (verdict === 'won') won++; else lost++
  }

  return ({
    checked: unsettled.length, gamesFinished: finishedCount, of: fixtureIds.length,
    settled: won + lost, won, lost, pending, gameResults, summary: await sessionSummary(session.id),
  })
}
