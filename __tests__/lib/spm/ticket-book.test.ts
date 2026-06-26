/**
 * SPM ticket book + Mode S report.
 *
 * Verifies the hard "one match per slip" rule, builds the ticket book as
 * outcome-variation coverage over a shared match pool (base + single-deviations),
 * and shows where the Bet Saver band (Mode S) actually catches the binomial.
 */

import { describe, it, expect } from 'vitest'
import type { MarketPair } from '../../../lib/spm/leg-stacker'
import {
  groupByMatch, selectBaseSlip, buildTicketBook, hasDuplicateMatch,
  binomialBand, betSaverBand, chooseLegCount,
} from '../../../lib/spm/leg-stacker'

const round2 = (x: number) => Math.round(x * 100) / 100
const pair = (game: string, market: string, p: number, m: number): MarketPair => ({
  game, market, sideLabel: market,
  odds: round2(1 / (p * (1 + m))),
  oppOdds: round2(1 / ((1 - p) * (1 + m))),
})

// 52 matches, each with TWO eligible outcomes: a likely primary + an alternative
// "other shot" outcome (the deviation scenario) on the SAME match.
function buildPool(): MarketPair[] {
  const pool: MarketPair[] = []
  for (let i = 0; i < 52; i++) {
    const pPrimary = 0.74 + (i % 6) * 0.01 // 0.74–0.79 (riskiest = 0.74)
    pool.push(pair(`M${i + 1}`, 'primary', pPrimary, 0.035 + (i % 4) * 0.004))
    pool.push(pair(`M${i + 1}`, 'alt', 0.30 + (i % 3) * 0.04, 0.05)) // the alternative outcome
  }
  return pool
}

describe('SPM ticket book + Mode S', () => {
  const matches = groupByMatch(buildPool())

  it('hard rule: no slip contains the same match twice', () => {
    const book = buildTicketBook(matches, { legCount: 50, shots: 10 })
    for (const slip of book.slips) {
      expect(slip).toHaveLength(50)
      expect(hasDuplicateMatch(slip)).toBe(false)
    }
  })

  it('REPORT: ticket book as outcome-variation coverage (base + single-deviations)', () => {
    const book = buildTicketBook(matches, { legCount: 50, shots: 10 })
    console.log('\n── TICKET BOOK (10 shots, shared 50-match pool) ───────────────')
    console.log(`  slips: ${book.slips.length} (1 base + ${book.variedMatches.length} variations)`)
    console.log(`  each slip: 50 legs, one per match (constraint enforced)`)
    console.log(`  varied matches (riskiest legs swapped to an alternative outcome):`)
    console.log(`    ${book.variedMatches.join(', ')}`)
    console.log(`  P(base hits)      = 1 / ${(1 / book.pBase).toFixed(0)}`)
    console.log(`  P(any slip hits)  = 1 / ${(1 / book.pAnyHit).toFixed(0)}  (${(book.pAnyHit / book.pBase).toFixed(1)}× the base)`)
    console.log(`  → 10 outcome-variations lift the shot ~${(book.pAnyHit / book.pBase).toFixed(1)}×, still a lottery`)
    expect(book.pAnyHit).toBeGreaterThan(book.pBase)
  })

  it('REPORT: Mode S — where the Bet Saver band actually catches the binomial', () => {
    console.log('\n── MODE S: Bet Saver band vs leg count ────────────────────────')
    console.log('  N   per-leg p  band     expected correct  P(in band)  P(full hit)')
    const rows: { n: number; p: number }[] = [
      { n: 31, p: 0.88 }, { n: 31, p: 0.80 }, { n: 50, p: 0.88 }, { n: 50, p: 0.79 },
    ]
    for (const { n, p } of rows) {
      const b = binomialBand(n, p)
      const [lo, hi] = betSaverBand(n)
      console.log(
        `  ${n}    ${p.toFixed(2)}     ${lo}-${hi}    ` +
        `${b.expectedCorrect.toFixed(1).padStart(6)}            ` +
        `${(b.pInBand * 100).toFixed(1).padStart(5)}%       ${(b.pFullHit * 100).toFixed(4)}%`,
      )
    }
    console.log(`  chooseLegCount(survival) = ${chooseLegCount(0.88, 'survival')}  |  chooseLegCount(maxwin) = ${chooseLegCount(0.88, 'maxwin')}`)

    // Mode S works at 31 with bankers; 50 legs overshoots the band (mode below it).
    expect(binomialBand(31, 0.88).pInBand).toBeGreaterThan(binomialBand(50, 0.79).pInBand)
  })
})
