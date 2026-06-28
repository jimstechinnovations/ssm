// __tests__/lib/pedlas/quality.test.ts
// Selection quality: confident, clean-priced, form-corroborated legs rank higher; decisions emitted.

import { describe, it, expect } from 'vitest'
import type { BinaryAxis } from '../../../lib/pedlas/types'
import { scoreAxis, selectByQuality } from '../../../lib/pedlas/quality'

function ax(id: number, o: { dom?: 'Over' | 'Under'; pDom?: number; line?: number; margin?: number; vol?: number; league?: number; edge?: number } = {}): BinaryAxis {
  const dom = o.dom ?? 'Under', pDom = o.pDom ?? 0.74, margin = o.margin ?? 0.05, line = o.line ?? 4.5
  const pOther = 1 - pDom
  const oDom = 1 / (pDom * (1 + margin)), oOther = 1 / (pOther * (1 + margin))
  const a: BinaryAxis = {
    fixtureId: id, game: `G${id}H vs G${id}A`, league: `L${o.league ?? 0}`, leagueId: o.league ?? 0,
    kickoff: '2026-06-27T12:00:00Z', line,
    underOdds: dom === 'Under' ? oDom : oOther, underProb: dom === 'Under' ? pDom : pOther,
    overOdds: dom === 'Over' ? oDom : oOther, overProb: dom === 'Over' ? pDom : pOther,
    dominantSide: dom, margin, volatility: o.vol ?? 0.4,
  }
  if (o.edge !== undefined) a.advisory = { pHat: pDom, edge: o.edge, lean: o.edge > 1.05 ? 'back' : o.edge < 0.95 ? 'fade' : 'neutral', note: 'test form' }
  return a
}

describe('quality selection', () => {
  it('emits a decision: pick, confidence, reasons', () => {
    const { decision } = scoreAxis(ax(1))
    expect(decision.pick).toBe('Under 4.5')
    expect(decision.confidence).toBeGreaterThanOrEqual(0)
    expect(decision.confidence).toBeLessThanOrEqual(100)
    expect(decision.reasons.length).toBeGreaterThan(1)
    expect(decision.reasons.some(r => /Most likely/.test(r))).toBe(true)
  })

  it('prefers cleaner-priced (lower-margin) legs', () => {
    expect(scoreAxis(ax(1, { margin: 0.03 })).quality).toBeGreaterThan(scoreAxis(ax(2, { margin: 0.10 })).quality)
  })

  it('form agreement boosts; form disagreement penalises', () => {
    expect(scoreAxis(ax(1, { edge: 1.2 })).quality).toBeGreaterThan(scoreAxis(ax(2, { edge: 0.8 })).quality)
  })

  it('prefers more confident anchors', () => {
    expect(scoreAxis(ax(1, { pDom: 0.80 })).quality).toBeGreaterThan(scoreAxis(ax(2, { pDom: 0.62 })).quality)
  })

  it('selectByQuality returns the best N, decorrelated by league, each with a decision', () => {
    const axes = [
      ax(1, { pDom: 0.80, league: 0 }), ax(2, { pDom: 0.78, league: 0 }), ax(3, { pDom: 0.76, league: 0 }),
      ax(4, { pDom: 0.74, league: 1 }), ax(5, { pDom: 0.72, league: 1 }), ax(6, { pDom: 0.70, league: 2 }),
    ]
    const out = selectByQuality(axes, 4, 2)
    expect(out).toHaveLength(4)
    const perLeague = new Map<number, number>()
    for (const a of out) { perLeague.set(a.leagueId, (perLeague.get(a.leagueId) ?? 0) + 1); expect(a.decision).toBeTruthy() }
    expect([...perLeague.values()].every(c => c <= 2)).toBe(true)
    // highest-confidence axis is included
    expect(out.some(a => a.fixtureId === 1)).toBe(true)
  })
})
