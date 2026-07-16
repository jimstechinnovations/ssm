// __tests__/lib/pedlas/dominant-side.test.ts
// Generalised market policy: dominant side per line (Over 1.5 for high-scoring, Under 4.5 for low),
// and the engine maps state 0 → dominant side correctly. Back-compat (default Under) covered elsewhere.

import { describe, it, expect } from 'vitest'
import type { Fixture } from '../../../lib/pedlas/types'
import { selectAxes } from '../../../lib/pedlas/market-select'
import { makeVector } from '../../../lib/pedlas/vectors'
import { buildLegs } from '../../../lib/pedlas/budget'
import { buildPedlasBook } from '../../../lib/pedlas/build'

function fx(id: number, odds: { line: number; under: number; over: number }[]): Fixture {
  return {
    id, homeTeam: `H${id}`, awayTeam: `A${id}`, league: 'L', leagueId: 1,
    kickoff: '2026-06-27T12:00:00Z',
    odds: odds.flatMap(o => ([
      { bookmaker: 'b', market: `OVER_UNDER_${o.line}` as Fixture['odds'][number]['market'], label: `Under ${o.line}`, value: o.under },
      { bookmaker: 'b', market: `OVER_UNDER_${o.line}` as Fixture['odds'][number]['market'], label: `Over ${o.line}`, value: o.over },
    ])),
  }
}

// High-scoring fixture: Over 1.5 (@1.25) is the reliable dominant side.
const highScoring = fx(1, [
  { line: 1.5, under: 3.80, over: 1.25 },
  { line: 4.5, under: 1.50, over: 2.60 },
])

describe('dominant side per line', () => {
  it('picks Over as dominant on the low line (most reliable ≥ 1.20)', () => {
    const axes = selectAxes([highScoring])
    expect(axes).toHaveLength(1)
    expect(axes[0].line).toBe(1.5)
    expect(axes[0].dominantSide).toBe('Over')
  })

  it('engine maps state 0 → dominant (Over) and state 1 → breakout (Under)', () => {
    const a = selectAxes([highScoring])[0]
    const anchor = makeVector([0], [a])
    expect(anchor.combinedOdds).toBeCloseTo(a.overOdds, 9)  // state 0 uses the Over (dominant) odds
    expect(anchor.trueProb).toBeCloseTo(a.overProb, 9)

    expect(buildLegs([0], [a])[0]).toMatchObject({ side: 'Over', outcome: 'Over 1.5', odds: a.overOdds })
    expect(buildLegs([1], [a])[0]).toMatchObject({ side: 'Under', outcome: 'Under 1.5', odds: a.underOdds })
  })

  it('builds a coverage book of reliable Over-1.5 anchors', async () => {
    const fixtures = [1, 2, 3, 4, 5].map(i =>
      fx(i, [{ line: 1.5, under: 3.5 + i * 0.1, over: 1.22 + i * 0.01 }, { line: 4.5, under: 1.5, over: 2.6 }]))
    const axes = selectAxes(fixtures)
    expect(axes.every(a => a.dominantSide === 'Over' && a.line === 1.5)).toBe(true)

    const book = await buildPedlasBook({ axes, budget: 1000, minStake: 100, objective: 'coverage', rank: 'deterministic' })
    expect(book.slips.length).toBeGreaterThan(0)
    // dominant anchors are Over 1.5; each placed slip carries Over-1.5 legs
    expect(book.slips[0].legs.some(l => l.side === 'Over' && l.line === 1.5)).toBe(true)
    // payouts still computed correctly (combined odds = product of leg odds)
    for (const s of book.slips) expect(s.combinedOdds).toBeCloseTo(s.legs.reduce((a, l) => a * l.odds, 1), 6)
  })

  it('back-compat: Under-dominant fixture still anchors on Under', () => {
    const lowScoring = fx(9, [{ line: 4.5, under: 1.28, over: 3.55 }])
    const a = selectAxes([lowScoring])[0]
    expect(a.dominantSide).toBe('Under')
    expect(buildLegs([0], [a])[0].side).toBe('Under')
  })
})
