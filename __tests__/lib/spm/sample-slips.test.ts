/**
 * Sample output: a 50-match selection rendered as two distinct ₦100 slips
 * (base + one outcome-variation), under the one-match-per-slip rule.
 */

import { describe, it, expect } from 'vitest'
import type { MarketPair, Leg } from '../../../lib/spm/leg-stacker'
import { groupByMatch, buildTicketBook, planSlip, boostFor, hasDuplicateMatch } from '../../../lib/spm/leg-stacker'

const round2 = (x: number) => Math.round(x * 100) / 100
const PRIMARY = ['Over 1.5', 'Over 2.5', 'BTTS Yes', 'Odd', 'DC 1X', 'Under 3.5', 'Even', 'BTTS No', 'DC 12', 'Over 2.5']
const ALT = ['Under 2.5', 'BTTS No', 'Over 2.5', 'Even', 'DC 12', 'Over 3.5', 'Odd', 'BTTS Yes', 'DC 1X', 'Under 2.5']

function buildPool(): MarketPair[] {
  const pool: MarketPair[] = []
  for (let i = 0; i < 50; i++) {
    const game = `M${String(i + 1).padStart(2, '0')}`
    const pP = 0.775 + (i % 5) * 0.004, mP = 0.035 + (i % 3) * 0.003 // primary: likely, ≥1.20, low margin
    const pA = 0.42 + (i % 4) * 0.03, mA = 0.06                      // alternative: the "other shot"
    pool.push({ game, market: PRIMARY[i % PRIMARY.length], sideLabel: PRIMARY[i % PRIMARY.length], odds: round2(1 / (pP * (1 + mP))), oppOdds: round2(1 / ((1 - pP) * (1 + mP))) })
    pool.push({ game, market: ALT[i % ALT.length], sideLabel: ALT[i % ALT.length], odds: round2(1 / (pA * (1 + mA))), oppOdds: round2(1 / ((1 - pA) * (1 + mA))) })
  }
  return pool
}

const CAP = 50_000_000
const STAKE = 100

function show(name: string, legs: Leg[]) {
  const plan = planSlip(legs, { stake: STAKE, cap: CAP })
  console.log(`\n  ${name}  —  ₦${STAKE} stake, ${legs.length} legs, ${boostFor(legs.length) * 100}% boost`)
  console.log(`    combined odds : ${plan.combinedOdds.toFixed(0)}×`)
  console.log(`    raw payout    : ₦${(plan.rawMaxWin / 1e6).toFixed(1)}M${plan.capped ? `  → capped at ₦${(plan.maxWin / 1e6).toFixed(0)}M` : ''}`)
  console.log(`    P(all hit)    : 1 / ${(1 / plan.pHit).toFixed(0)}`)
}

describe('SPM sample — 50 selection, two ₦100 slips', () => {
  const matches = groupByMatch(buildPool())
  const book = buildTicketBook(matches, { legCount: 50, shots: 2 })
  const [slipA, slipB] = book.slips

  it('renders the 50-match selection and two distinct slips', () => {
    console.log('\n══ 50-MATCH SELECTION (Slip A — base) ════════════════════════')
    let line = '  '
    slipA.forEach((l, i) => {
      line += `${l.game} ${l.side.padEnd(9)}@${l.odds.toFixed(2)}`.padEnd(26)
      if ((i + 1) % 2 === 0) { console.log(line); line = '  ' }
    })
    if (line.trim()) console.log(line)

    show('SLIP A (base)', slipA)

    // Slip B differs from A only where the variation swapped an outcome.
    const diffs = slipA.map((l, i) => ({ i, a: l, b: slipB[i] })).filter(d => d.a.side !== d.b.side || d.a.odds !== d.b.odds)
    console.log('\n══ SLIP B (variation) — same 50 matches, outcome(s) swapped ══')
    for (const d of diffs) {
      console.log(`    ${d.a.game}: ${d.a.side} @${d.a.odds.toFixed(2)}  →  ${d.b.side} @${d.b.odds.toFixed(2)}  (riskiest leg → alternative)`)
    }
    show('SLIP B (variation)', slipB)

    console.log(`\n  BOOK: 2 slips × ₦${STAKE} = ₦${2 * STAKE} total`)
    console.log(`    P(either slip hits) = 1 / ${(1 / book.pAnyHit).toFixed(0)}  (${(book.pAnyHit / book.pBase).toFixed(2)}× the base alone)`)

    // both valid, distinct
    expect(slipA).toHaveLength(50)
    expect(slipB).toHaveLength(50)
    expect(hasDuplicateMatch(slipA)).toBe(false)
    expect(hasDuplicateMatch(slipB)).toBe(false)
    expect(diffs.length).toBeGreaterThan(0) // genuinely distinct
  })
})
