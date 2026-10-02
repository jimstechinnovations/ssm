import { describe, it, expect } from 'vitest'
import { flexiOdds, oneCut, correctDist, atLeast, weightedRtp } from '@/lib/books/sportybet-flexi'

// A real betslip, 2026-10-02 (booking code G0JEDL, 8 × Under 2.5, ₦100). Odds + SportyBet's own outcome
// probabilities from the live feed; the expected payouts are what the betslip displayed.
const LEGS = [[2.15, 0.447306], [2.25, 0.425347], [2.7, 0.347234], [2.1, 0.451349], [2.05, 0.471618], [2.55, 0.370513], [1.84, 0.52516], [1.76, 0.549803]]
  .map(([odds, probability]) => ({ odds, probability }))

describe('SportyBet Flexibet / One Cut — exact against a real betslip', () => {
  it('pays exactly what the betslip showed for every "k of 8"', () => {
    const site: Record<number, number> = { 8: 49578.37, 7: 4926.08, 6: 1052.69, 5: 367.88, 4: 183.62 }
    for (const [k, win] of Object.entries(site)) expect(Math.round(flexiOdds(LEGS, Number(k)).odds * 100 * 100) / 100).toBe(win)
  })

  it('One Cut at the 99% slider pays the betslip figures', () => {
    const O = LEGS.reduce((x, l) => x * l.odds, 1)
    const r = oneCut({ stake: 100, oddsProduct: O, bonusAmount: 6964.97, cutOdds: flexiOdds(LEGS, 7).odds, sliderPct: 0.99 })
    expect(r.allWin).toBe(5410.8)
    expect(r.oneCutWin).toBe(4876.82)
  })

  it('the key sits near one leg’s return for loose tickets and shrinks for tight ones', () => {
    const L = weightedRtp(LEGS)
    expect(L).toBeCloseTo(0.9549, 3)
    const keys = [4, 5, 6, 7, 8].map(k => flexiOdds(LEGS, k).key)
    expect(keys[0]).toBeCloseTo(L, 6)                          // 4+ of 8: capped at L
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeLessThan(keys[i - 1])
  })

  it('the distribution of correct legs sums to 1 and matches inclusion–exclusion', () => {
    const d = correctDist(LEGS.map(l => l.probability))
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(atLeast(d, 8)).toBeCloseTo(LEGS.reduce((x, l) => x * l.probability, 1), 12)
  })
})
