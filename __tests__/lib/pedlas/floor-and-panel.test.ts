import { describe, it, expect } from 'vitest'
import { buildFloor } from '@/lib/pedlas/floor'
import { settleSlip, flexiMinCorrect } from '@/lib/pedlas/settle-slips'
import { powerDevig, buildPanel, consensus, emptyFair, type RefBoard } from '@/lib/books/reference'
import type { SelectionGame, Selection, LegRule } from '@/lib/pedlas/selections'

const sel = (key: string, name: string, odds: number, probability: number, rule: LegRule): Selection =>
  ({ key, name, marketId: '18', specifier: 'total=2.5', outcomeId: '13', odds, rule, flipKey: key + '-flip', margin: 0.05, probability })
const game = (id: number, likelyOdds: number, likelyP: number): SelectionGame => ({
  fixtureId: id, home: `H${id}`, away: `A${id}`, game: `H${id} vs A${id}`, league: 'L', kickoff: `2026-10-03T1${id % 10}:00:00Z`,
  selections: [
    sel(`${id}u`, 'Under 3.5', likelyOdds, likelyP, { kind: 'total', line: 3.5, side: 'Under' }),
    sel(`${id}o`, 'Over 3.5', 3.4, 0.27, { kind: 'total', line: 3.5, side: 'Over' }),
  ],
})

describe('floor builder', () => {
  const games = Array.from({ length: 20 }, (_, i) => game(100 + i, 1.25 + (i % 5) * 0.03, 0.76 - (i % 5) * 0.02))
  it('builds Flexi tickets on likely legs that land ≥ 45% of the time and pay more than the stake', () => {
    const { tickets } = buildFloor(games, { budget: 100, stake: 10 })
    expect(tickets).toHaveLength(10)
    for (const t of tickets) {
      expect(t.legs).toHaveLength(8)
      expect(new Set(t.legs.map(l => l.game.fixtureId)).size).toBe(8)      // one pick per game
      expect(t.legs.every(l => l.p >= 0.55 && l.sel.odds >= 1.2)).toBe(true)
      expect(t.pWin).toBeGreaterThanOrEqual(0.45)
      expect(t.payout).toBeGreaterThan(10)
      expect(t.k).toBeLessThan(8)
    }
  })
  it('keeps away from the jackpot slips\' games while others are left', () => {
    const avoid = new Set(games.slice(0, 10).map(g => g.fixtureId))
    const { tickets } = buildFloor(games, { budget: 50, stake: 10, avoidFixtures: avoid })
    for (const t of tickets) for (const l of t.legs) expect(avoid.has(l.game.fixtureId)).toBe(false)
  })
})

describe('Flexi settlement — at least k of N', () => {
  const legs = Array.from({ length: 8 }, (_, i) => ({ fixtureId: i + 1, rule: { kind: 'total', line: 2.5, side: 'Under' } as LegRule }))
  const res = (scores: [number, number][]) => new Map(scores.map(([h, a], i) => [i + 1, { finished: true, total: h + a, home: h, away: a }]))
  it('wins once k legs are right, loses once more than N − k are wrong, else pending', () => {
    const six = res([[0, 0], [1, 0], [1, 1], [0, 1], [2, 0], [0, 2], [3, 1], [2, 2]])   // 6 right, 2 wrong
    expect(settleSlip(legs, six, { minCorrect: 6 })).toBe('won')
    expect(settleSlip(legs, six, { minCorrect: 7 })).toBe('lost')
    expect(settleSlip(legs, six)).toBe('lost')                                        // a plain slip dies at the first miss
    const partial = new Map([...six].slice(0, 5))                                     // 5 right, 0 wrong, 3 to play
    expect(settleSlip(legs, partial, { minCorrect: 6 })).toBe('pending')
  })
  it('reads k from a floor ticket\'s decision only', () => {
    expect(flexiMinCorrect({ product: 'flexi', k: 6 })).toBe(6)
    expect(flexiMinCorrect({ engine: 'decision_bot' })).toBeUndefined()
  })
})

describe('reference panel', () => {
  it('power de-vig sums to 1 and shades the long shot more than the favourite', () => {
    const p = powerDevig([1.3, 5.0, 9.0])
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    const prop = [1 / 1.3, 1 / 5, 1 / 9].map(v => v / (1 / 1.3 + 1 / 5 + 1 / 9))
    expect(p[2]).toBeLessThan(prop[2]); expect(p[0]).toBeGreaterThan(prop[0])
  })
  const board = (source: string, weight: number, home: number, start = '2026-10-03T15:00:00Z'): RefBoard => {
    const f = emptyFair(); f.moneyline = { home, draw: 0.25, away: 0.75 - home }; f.totals.set(2.5, 0.5)
    return { source, weight, fixtures: [{ id: 'x', home: 'Manchester United', away: 'Tottenham Hotspur', start, league: 'EPL' }], fair: new Map([['x', f]]) }
  }
  const g = { fixtureId: 1, home: 'Man Utd', away: 'Tottenham', kickoff: '2026-10-03T15:05:00Z', own1x2: { home: 0.5, draw: 0.25, away: 0.25 } }
  it('matches names across books and weights the consensus', () => {
    const panel = buildPanel([g], [board('pinnacle', 2, 0.5), board('kambi', 1, 0.47)])
    const c = consensus(panel.get(1), { kind: '1x2', pick: 'H' })!
    expect(c.n).toBe(2)
    expect(c.p).toBeCloseTo((2 * 0.5 + 0.47) / 3, 9)
    expect(c.spread).toBeCloseTo(0.03, 9)
  })
  it('drops a pairing whose 1X2 is far from SportyBet\'s own (a wrong match)', () => {
    const panel = buildPanel([g], [board('pinnacle', 2, 0.2)])
    expect(panel.get(1)!.sources).toHaveLength(0)
    expect(panel.get(1)!.rejected[0].source).toBe('pinnacle')
  })
})
