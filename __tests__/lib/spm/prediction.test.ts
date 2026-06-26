/**
 * SPM v2 prediction layer — the +EV lever.
 *
 * Shows the break-even per-leg edge at the 1000% tier (tiny), and demonstrates a
 * 50-leg slip flipping −EV → +EV once a small, calibrated edge (p̂ > p_book) is applied.
 */

import { describe, it, expect } from 'vitest'
import type { MarketPair } from '../../../lib/spm/leg-stacker'
import { selectLegs, breakEvenEdge, slipEVWithEdge, legEdge } from '../../../lib/spm/leg-stacker'

// pool of 50 legs at a fixed margin; pBook recovered = p, odds ≥ 1.20 at p ≤ ~0.78.
function pool(p: number, m: number): MarketPair[] {
  return Array.from({ length: 50 }, (_, i) => ({
    game: `M${i + 1}`, market: 'pick', sideLabel: 'pick',
    odds: 1 / (p * (1 + m)),
    oppOdds: 1 / ((1 - p) * (1 + m)),
  }))
}

describe('SPM v2 prediction layer', () => {
  it('REPORT: break-even per-leg edge at the 1000% tier is tiny', () => {
    console.log('\n── BREAK-EVEN PER-LEG EDGE  (50 legs, 1000% boost) ────────────')
    console.log('  margin   required edge e*   as %')
    for (const m of [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10]) {
      const e = breakEvenEdge(50, m)
      console.log(`  ${(m * 100).toFixed(0).padStart(2)}%      ${e.toFixed(3)}            ${((e - 1) * 100 >= 0 ? '+' : '')}${((e - 1) * 100).toFixed(1)}%`)
    }
    // 3% margin needs no edge; 8% needs ~3%.
    expect(breakEvenEdge(50, 0.03)).toBeLessThan(1)
    expect(breakEvenEdge(50, 0.08)).toBeGreaterThan(1.02)
  })

  it('REPORT: a small calibrated edge flips a 50-leg slip −EV → +EV', () => {
    const margin = 0.06
    const legs = selectLegs(pool(0.77, margin), { count: 50 })
    const req = breakEvenEdge(50, margin)
    console.log(`\n── EDGE TIPS THE SHOT  (50 legs, margin ${(margin * 100).toFixed(0)}%, need e* = ${req.toFixed(3)}) ──`)
    console.log('  per-leg edge e   slip EV multiple   verdict')
    for (const e of [1.00, 1.005, 1.01, 1.02, 1.03]) {
      const plan = slipEVWithEdge(legs, l => l.pBook * e)
      console.log(`  ${e.toFixed(3)}            ${plan.evMultiple.toFixed(3)}             ${plan.positiveEV ? '✅ +EV' : '❌ −EV'}`)
    }
    // No edge (e=1) at 6% margin → −EV; a ~1% edge → +EV.
    expect(slipEVWithEdge(legs, l => l.pBook * 1.00).positiveEV).toBe(false)
    expect(slipEVWithEdge(legs, l => l.pBook * 1.02).positiveEV).toBe(true)
    // legEdge sanity
    expect(legEdge(legs[0], legs[0].pBook * 1.05)).toBeCloseTo(1.05, 6)
  })
})
