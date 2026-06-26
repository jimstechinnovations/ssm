/**
 * Realistic market-overlap + coverage report.
 *
 * Shows: (1) which binary markets are redundant per game (partial fingerprint
 * overlap), (2) how eligibility (≥1.20) + pruning thin a game's market set, and
 * (3) how the number of slips and win-rate ceiling move with the number of games.
 *
 * Executable report — run and read the console output.
 */

import { describe, it, expect } from 'vitest'
import type { FpMarket } from '../../../lib/ssm/fingerprint'
import { poissonDist, pMarket } from '../../../lib/ssm/scoreline-model'
import type { ScorelineDist } from '../../../lib/ssm/scoreline-model'
import { marketOverlap, pruneRedundant } from '../../../lib/ssm/market-overlap'
import { makeAxis, optimizeCoverage } from '../../../lib/ssm/coverage-optimizer'
import type { GameAxis } from '../../../lib/ssm/coverage-optimizer'

const MARGIN = 0.06
const round2 = (x: number) => Math.round(x * 100) / 100
const bookOdds = (d: ScorelineDist, m: FpMarket) => round2(1 / (pMarket(d, m) * (1 + MARGIN)))

// Candidate binary markets the model can use as legs.
const CANDIDATES: FpMarket[] = [
  'OVER_1_5', 'OVER_2_5', 'OVER_3_5', 'UNDER_2_5', 'UNDER_3_5',
  'BTTS_YES', 'BTTS_NO', 'ODD', 'EVEN', 'DC1X', 'DC12',
]

// Realistic slate (home/away Poisson rates). G1 is a low-scoring "Kedainiai-like" game.
const SLATE: { name: string; lh: number; la: number }[] = [
  { name: 'G1 low (Kedainiai-like)', lh: 1.0, la: 0.9 },
  { name: 'G2 high',                 lh: 1.8, la: 1.5 },
  { name: 'G3 mid',                  lh: 1.4, la: 1.2 },
  { name: 'G4 home-strong',          lh: 2.0, la: 0.7 },
  { name: 'G5 very low',             lh: 0.9, la: 0.8 },
  { name: 'G6 high-ish',             lh: 1.6, la: 1.4 },
  { name: 'G7 balanced',             lh: 1.2, la: 1.2 },
  { name: 'G8 away-lean',            lh: 1.0, la: 1.5 },
]

describe('Market overlap + realistic coverage', () => {
  const dists = SLATE.map(g => poissonDist(g.lh, g.la))

  it('Odd/Even never overlap; complements have zero shared mass', () => {
    for (const d of dists) {
      expect(marketOverlap(d, 'ODD', 'EVEN').jointProb).toBeCloseTo(0, 6)
      expect(marketOverlap(d, 'BTTS_YES', 'BTTS_NO').jointProb).toBeCloseTo(0, 6)
    }
  })

  it('REPORT: redundant pair flips with game type (Under2.5≈BTTSNo low / Over2.5≈BTTSYes high)', () => {
    const low = dists[0]   // G1 low
    const high = dists[1]  // G2 high
    const oLow = marketOverlap(low, 'UNDER_2_5', 'BTTS_NO')
    const oHigh = marketOverlap(high, 'OVER_2_5', 'BTTS_YES')
    console.log('\n── REDUNDANT-PAIR FLIP ────────────────────────────────────────')
    console.log(`  LOW game:  Under2.5 ↔ BTTS No   shared ${(oLow.sharedOfA * 100).toFixed(0)}% / ${(oLow.sharedOfB * 100).toFixed(0)}%  → redundant=${oLow.redundant}`)
    console.log(`  HIGH game: Over2.5  ↔ BTTS Yes  shared ${(oHigh.sharedOfA * 100).toFixed(0)}% / ${(oHigh.sharedOfB * 100).toFixed(0)}%  → redundant=${oHigh.redundant}`)
    console.log(`  Both games: Odd ↔ Even shared 0% (orthogonal axis, always kept)`)
    expect(oLow.redundant).toBe(true)
    expect(oHigh.redundant).toBe(true)
  })

  it('REPORT: per-game eligibility (≥1.20) + overlap pruning', () => {
    console.log('\n── PER-GAME MARKETS: eligible (≥1.20) → pruned (distinct) ──────')
    SLATE.forEach((g, i) => {
      const d = dists[i]
      const eligible = CANDIDATES.filter(m => bookOdds(d, m) >= 1.20)
      const { kept, dropped } = pruneRedundant(d, eligible, 0.7)
      const dropStr = dropped.map(x => `${x.market}⊂${x.coveredBy}(${(x.shared * 100).toFixed(0)}%)`).join(' ')
      console.log(
        `  ${g.name.padEnd(24)} eligible=${String(eligible.length).padStart(2)}  distinct=${String(kept.length).padStart(2)}  ` +
        `kept=[${kept.join(',')}]`,
      )
      if (dropStr) console.log(`      dropped: ${dropStr}`)
      expect(kept.length).toBeLessThanOrEqual(eligible.length)
    })
  })

  it('REPORT: number of slips & win-rate ceiling vs number of games (costTarget 1.0)', () => {
    const axes: GameAxis[] = SLATE.map((g, i) => {
      const d = dists[i]
      return makeAxis(
        g.name,
        pMarket(d, 'UNDER_2_5'), bookOdds(d, 'UNDER_2_5'), 'Under 2.5',
        pMarket(d, 'OVER_2_5'), bookOdds(d, 'OVER_2_5'), 'Over 2.5',
      )
    })
    const B = 10_000
    console.log('\n── COVERAGE vs N GAMES (break-even costTarget = 1.0) ──────────')
    console.log('  N   slips  winRate  return/hit  ceiling(1/R)  affordable≥₦100')
    const rows: { n: number; slips: number; win: number }[] = []
    for (const n of [4, 5, 6, 7, 8]) {
      const r = optimizeCoverage(axes.slice(0, n), { bankroll: B, costTarget: 1.0 })
      const R = Math.pow(1 + MARGIN, n)
      console.log(
        `  ${n}   ${String(r.slips.length).padStart(4)}    ${(r.winRate * 100).toFixed(1).padStart(5)}%   ` +
        `₦${r.returnPerHit.toFixed(0).padStart(6)}     ${(100 / R).toFixed(1)}%        ` +
        `${r.slips.length - r.belowMinStake}/${r.slips.length}`,
      )
      rows.push({ n, slips: r.slips.length, win: r.winRate })
    }
    // Pattern: fewer games → higher win rate AND fewer slips.
    expect(rows[0].win).toBeGreaterThan(rows[rows.length - 1].win)
    expect(rows[0].slips).toBeLessThan(rows[rows.length - 1].slips)
  })

  it('REPORT: Win Boost raises the break-even-on-win ceiling to (1+boost)/R', () => {
    // Boost slips are all ≥1.20, so the whole slip is eligible. Break-even WITH boost
    // allows covering up to cost = (1+boost), lifting the max win rate.
    const boostPct: Record<number, number> = { 4: 0.05, 5: 0.08, 6: 0.10, 7: 0.12, 8: 0.14 }
    const axes: GameAxis[] = SLATE.map((g, i) => {
      const d = dists[i]
      return makeAxis(
        g.name,
        pMarket(d, 'UNDER_2_5'), bookOdds(d, 'UNDER_2_5'), 'Under 2.5',
        pMarket(d, 'OVER_2_5'), bookOdds(d, 'OVER_2_5'), 'Over 2.5',
      )
    })
    const B = 10_000
    console.log('\n── BOOST ENGINE: coverage at costTarget = 1+boost ─────────────')
    console.log('  N   boost  slips  winRate  no-boost win  net-on-win(after boost)')
    for (const n of [4, 5, 6, 7, 8]) {
      const b = boostPct[n]
      const boosted = optimizeCoverage(axes.slice(0, n), { bankroll: B, costTarget: 1 + b })
      const plain = optimizeCoverage(axes.slice(0, n), { bankroll: B, costTarget: 1.0 })
      const netOnWin = boosted.returnPerHit * (1 + b) - B // returnPerHit×(1+boost) − stake
      console.log(
        `  ${n}   ${(b * 100).toFixed(0).padStart(2)}%   ${String(boosted.slips.length).padStart(4)}    ` +
        `${(boosted.winRate * 100).toFixed(1).padStart(5)}%     ${(plain.winRate * 100).toFixed(1).padStart(5)}%       ` +
        `${netOnWin >= 0 ? '+' : ''}₦${netOnWin.toFixed(0)}`,
      )
      // Boost lifts the achievable win rate at break-even.
      expect(boosted.winRate).toBeGreaterThan(plain.winRate)
    }
  })
})
