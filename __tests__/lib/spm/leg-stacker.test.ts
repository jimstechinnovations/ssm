/**
 * SPM leg-stacker scanner — does a candidate pool support a +EV ₦100→max shot?
 *
 * Builds two pools (a sharp/low-margin one and a juiced/high-margin one), selects
 * the 50 lowest-margin ≥1.20 legs from each, stacks them at the 1000% boost tier,
 * and reports the honest verdict. Executable report — run and read the output.
 */

import { describe, it, expect } from 'vitest'
import type { MarketPair } from '../../../lib/spm/leg-stacker'
import { selectLegs, planSlip, boostFor, breakEvenMargin } from '../../../lib/spm/leg-stacker'

const round2 = (x: number) => Math.round(x * 100) / 100

// Build a pool of `n` candidate markets with a given true-prob and margin pattern.
// odds = 1 / (p × (1+m)); oppOdds = 1 / ((1-p) × (1+m)) → recovers margin=m, pBook=p.
function buildPool(prefix: string, n: number, p: (i: number) => number, m: (i: number) => number): MarketPair[] {
  const pool: MarketPair[] = []
  for (let i = 0; i < n; i++) {
    const pi = p(i)
    const mi = m(i)
    pool.push({
      game: `${prefix}${i + 1}`,
      market: 'O/U 2.5',
      sideLabel: 'pick',
      odds: round2(1 / (pi * (1 + mi))),
      oppOdds: round2(1 / ((1 - pi) * (1 + mi))),
    })
  }
  return pool
}

const CAP = 50_000_000
const STAKE = 100

describe('SPM leg-stacker scanner', () => {
  // Sharp pool: efficient markets, margins ~3–5%.
  const sharp = buildPool('S', 60, i => 0.79 - (i % 4) * 0.005, i => 0.03 + (i % 5) * 0.005)
  // Juiced pool: lower-league markets, margins ~5.5–8.5% (lower p so odds stay ≥1.20).
  const juiced = buildPool('J', 60, i => 0.75 - (i % 4) * 0.005, i => 0.055 + (i % 5) * 0.0075)

  it('selection is clean: 50 legs, all ≥1.20, sorted by ascending margin', () => {
    const legs = selectLegs(sharp, { count: 50 })
    expect(legs).toHaveLength(50)
    expect(legs.every(l => l.odds >= 1.20)).toBe(true)
    for (let i = 1; i < legs.length; i++) expect(legs[i].margin).toBeGreaterThanOrEqual(legs[i - 1].margin - 1e-9)
  })

  it('REPORT: does the pool support a +EV ₦100→₦50M shot?', () => {
    console.log(`\n── SPM SCANNER  (stake ₦${STAKE}, cap ₦${(CAP / 1e6).toFixed(0)}M, 50 legs → ${boostFor(50) * 100}% boost) ──`)
    console.log(`  break-even per-leg margin at 50 legs: ${(breakEvenMargin(50) * 100).toFixed(2)}%\n`)
    console.log('  pool     avgMargin  combOdds   maxWin       P(hit)      EV/₦1   verdict')

    for (const [name, pool] of [['SHARP', sharp], ['JUICED', juiced]] as const) {
      const legs = selectLegs(pool, { count: 50 })
      const plan = planSlip(legs, { stake: STAKE, cap: CAP })
      const verdict = plan.evWithCap >= 1 ? '✅ +EV' : '❌ −EV'
      console.log(
        `  ${name.padEnd(7)}  ${(plan.avgMargin * 100).toFixed(2)}%     ` +
        `${plan.combinedOdds.toFixed(0).padStart(7)}×  ` +
        `₦${(plan.maxWin / 1e6).toFixed(1).padStart(5)}M${plan.capped ? '*' : ' '}  ` +
        `1/${(1 / plan.pHit).toFixed(0).padStart(8)}  ` +
        `${plan.evWithCap.toFixed(2).padStart(5)}   ${verdict}`,
      )
    }
    console.log('  (* = combined odds overshoot the cap → forfeited odds, EV leakage)')

    // Ticket book: bankroll / min stake shots.
    const bankroll = 1000
    const shots = bankroll / STAKE
    const sharpPlan = planSlip(selectLegs(sharp, { count: 50 }), { stake: STAKE, cap: CAP })
    console.log(`\n  TICKET BOOK: ₦${bankroll} / ₦${STAKE} = ${shots} shots`)
    console.log(`    all ${shots} slips use the SAME 50 matches — they vary OUTCOMES, not matches`)
    console.log(`    → highly correlated; P(any) only modestly above 1 shot (sub-linear, never ${shots}×)`)
    console.log(`    book EV = ${shots} × per-ticket EV (sign unchanged by buying more tickets)`)
    void sharpPlan

    const sharpEV = planSlip(selectLegs(sharp, { count: 50 }), { stake: STAKE, cap: CAP }).evWithCap
    const juicedEV = planSlip(selectLegs(juiced, { count: 50 }), { stake: STAKE, cap: CAP }).evWithCap
    expect(sharpEV).toBeGreaterThan(juicedEV)
    expect(juicedEV).toBeLessThan(1) // juiced pool can't clear the boost
  })

  it('break-even margin rises with the boost tier (more legs tolerate more margin)', () => {
    // 1000% boost at 50 legs tolerates more per-leg margin than 14% at 8 legs.
    expect(breakEvenMargin(50)).toBeGreaterThan(breakEvenMargin(8))
    console.log(`\n  break-even per-leg margin: 8 legs ${(breakEvenMargin(8) * 100).toFixed(2)}%  |  ` +
      `31 legs ${(breakEvenMargin(31) * 100).toFixed(2)}%  |  50 legs ${(breakEvenMargin(50) * 100).toFixed(2)}%`)
  })
})
