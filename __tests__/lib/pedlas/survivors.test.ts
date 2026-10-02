import { describe, it, expect } from 'vitest'
import { analyzeCoverage, stillPossible, tableFromPicks, type CovGame, type CovSlip } from '@/lib/pedlas/survivors'
import { ruleWins, type LegRule } from '@/lib/pedlas/selections'

const N = 11
const pOf = (t: Float64Array, r: LegRule) => { let s = 0; for (let i = 0; i < t.length; i++) if (ruleWins(r, Math.floor(i / N), i % N)) s += t[i]; return s }
const under05: LegRule = { kind: 'total', line: 0.5, side: 'Under' }
const over05: LegRule = { kind: 'total', line: 0.5, side: 'Over' }
const home: LegRule = { kind: '1x2', pick: 'H' }
const away: LegRule = { kind: '1x2', pick: 'A' }
const g = (fixtureId: number, state: CovGame['state'] = { kind: 'pending' }): CovGame => ({ fixtureId, game: `G${fixtureId}`, kickoff: `2026-10-02T1${fixtureId}:00:00Z`, state })
const slip = (slipId: number, legs: [number, LegRule, number][]): CovSlip => ({ key: `S#${slipId}`, slipId, stake: 10, payout: 1000, legs: legs.map(([fixtureId, rule, p]) => ({ fixtureId, rule, name: JSON.stringify(rule), p })) })

describe('survivors', () => {
  it('fits a scoreline table to the stored pick probabilities', () => {
    const t = tableFromPicks([{ rule: under05, p: 0.08 }, { rule: home, p: 0.55 }, { rule: away, p: 0.2 }])
    expect(pOf(t, under05)).toBeCloseTo(0.08, 2)
    expect(pOf(t, home)).toBeCloseTo(0.55, 2)
    expect(pOf(t, away)).toBeCloseTo(0.2, 2)
  })

  it('kills a leg in play only when no final score can still win it', () => {
    expect(stillPossible(under05, 1, 0)).toBe(false)            // a goal: Under 0.5 is beaten
    expect(stillPossible({ kind: 'total', line: 1.5, side: 'Under' }, 1, 0)).toBe(true)
    expect(stillPossible({ kind: 'btts', yes: false }, 1, 1)).toBe(false)
    expect(stillPossible(home, 0, 2)).toBe(true)                 // a comeback is still possible
  })

  it('counts early kills separately from full-time settlement', () => {
    const games = [g(1, { kind: 'live', h: 1, a: 0, minute: 30 }), g(2)]
    const c = analyzeCoverage(games, [slip(1, [[1, under05, 0.08], [2, home, 0.5]]), slip(2, [[1, over05, 0.92], [2, home, 0.5]])], { days: 4000 })
    expect(c.aliveAtFullTime).toBe(2)
    expect(c.aliveNow).toBe(1)
    expect(c.earlyKilled.map(k => k.key)).toEqual(['S#1'])
  })

  it('two slips on opposite sides of a game can never both win: P(≥1) = the sum', () => {
    const s = [slip(1, [[1, under05, 0.1]]), slip(2, [[1, over05, 0.9]])]
    const c = analyzeCoverage([g(1)], s, { days: 20000 })
    expect(c.plan.pAnyWin).toBeGreaterThan(0.99)                 // one of them always wins
    expect(c.plan.journey[0].pAllCut).toBeCloseTo(0, 5)
    expect(c.plan.journey[0].oneSided).toBe(false)
  })

  it('flags a one-sided game and the chance moves both ways with its result', () => {
    const s = [slip(1, [[1, home, 0.3], [2, home, 0.5]]), slip(2, [[1, home, 0.3], [2, away, 0.3]])]
    const c = analyzeCoverage([g(1), g(2)], s, { days: 40000 })
    const j1 = c.plan.journey[0]
    expect(j1.oneSided).toBe(true)                               // both slips need a home win in game 1
    expect(j1.pAllCut).toBeCloseTo(0.7, 1)
    expect(j1.pWinIfWorst).toBe(0)                               // not a home win → nobody can win
    expect(j1.pWinIfBest).toBeGreaterThan(c.plan.pAnyWin)         // a home win → the chance goes UP
  })

  it('prices new slips off the family before kickoff, never off survivors', () => {
    const games = [g(1, { kind: 'final', h: 0, a: 0 }), g(2)]
    const s = [slip(1, [[1, under05, 0.1], [2, home, 0.5]]), slip(2, [[1, over05, 0.9], [2, home, 0.5]])]
    const c = analyzeCoverage(games, s, { days: 20000, target: 1000, stake: 10 })
    expect(c.aliveNow).toBe(1)
    expect(c.now.pAnyWin).toBeCloseTo(0.5, 1)                    // the survivor needs one more 50% leg
    expect(c.budget.keep).toBeLessThan(c.now.keep)               // a survivor is worth far more than a fresh slip
    expect(c.timeline.length).toBe(2)                            // before kickoff + game 1
    expect(c.timeline[1].pAfter).toBeGreaterThan(c.timeline[0].pAfter - 0.2)
  })
})
