/**
 * Fingerprint-based analysis of the v3 56-slip matrix.
 *
 * Builds a realistic 8-game set (each game defined by Poisson scoring rates,
 * which become the "ground truth" scoreline distribution), prices book odds off
 * those rates, runs the actual v3 generateMatrix, then scores every slip's real
 * win probability via the fingerprint — exposing duplicates and dead-weight slips.
 *
 * This test doubles as an executable report: run it and read the console output.
 */

import { describe, it, expect } from 'vitest'
import { generateMatrix } from '../../../lib/ssm/generator'
import { profileFixture } from '../../../lib/ssm/gate-screener'
import { computeVolatility } from '../../../lib/ssm/volatility'
import { OUTCOME_TO_LABEL } from '../../../lib/ssm/types'
import type { Fixture, MatchSelection, OddsValue, SessionConfig } from '../../../lib/ssm/types'
import { allScorelines, labelToMarket, resolveMarket } from '../../../lib/ssm/fingerprint'
import type { FpMarket } from '../../../lib/ssm/fingerprint'
import { poissonDist, pMarket } from '../../../lib/ssm/scoreline-model'
import type { ScorelineDist } from '../../../lib/ssm/scoreline-model'
import { findDuplicateGroups, scoreMatrix, slipWinProb } from '../../../lib/ssm/slip-analysis'
import { makeAxis, optimizeCoverage } from '../../../lib/ssm/coverage-optimizer'
import type { GameAxis } from '../../../lib/ssm/coverage-optimizer'

const MARGIN = 0.05
const round2 = (x: number) => Math.round(x * 100) / 100

// Each game: home/away Poisson rates → ground-truth scoreline distribution.
const GAMES: { name: string; lh: number; la: number }[] = [
  { name: 'G1 goal-heavy home',  lh: 1.8, la: 1.2 },
  { name: 'G2 defensive',        lh: 0.9, la: 0.7 },
  { name: 'G3 goal-heavy',       lh: 1.6, la: 1.3 },
  { name: 'G4 balanced',         lh: 1.3, la: 1.1 },
  { name: 'G5 home fortress',    lh: 2.0, la: 0.6 },
  { name: 'G6 low-scoring',      lh: 0.8, la: 0.8 },
  { name: 'G7 open',             lh: 1.5, la: 1.5 },
  { name: 'G8 away strong',      lh: 0.9, la: 1.6 },
]

function bookOdds(dist: ScorelineDist, m: FpMarket): number {
  const p = pMarket(dist, m)
  return round2(1 / (p * (1 + MARGIN)))
}

function buildFixture(id: number, dist: ScorelineDist): Fixture {
  const mk = (label: string, m: FpMarket, market: OddsValue['market']): OddsValue => ({
    bookmaker: 'Proto', market, label, value: bookOdds(dist, m),
  })
  // 'Under 1.5' before 'Over 1.5' so the chaos OVER_UNDER_1.5 lookup grabs the defensive side.
  const odds: OddsValue[] = [
    mk('BTTS Yes', 'BTTS_YES', 'BTTS'),  mk('BTTS No', 'BTTS_NO', 'BTTS'),
    mk('Over 2.5', 'OVER_2_5', 'OVER_UNDER_2.5'), mk('Under 2.5', 'UNDER_2_5', 'OVER_UNDER_2.5'),
    mk('Under 1.5', 'UNDER_1_5', 'OVER_UNDER_1.5'), mk('Over 1.5', 'OVER_1_5', 'OVER_UNDER_1.5'),
    mk('Odd', 'ODD', '1X2'), mk('Even', 'EVEN', '1X2'),
    mk('DC 12', 'DC12', '1X2'), mk('DC 1X', 'DC1X', '1X2'),
  ]
  return { id, homeTeam: `H${id}`, awayTeam: `A${id}`, league: 'Proto', leagueId: 1, kickoff: '2026-06-19T15:00:00Z', odds }
}

function buildSelections(fixtures: Fixture[]): MatchSelection[] {
  return fixtures.map(fx => {
    const prof = profileFixture(fx)
    const s0 = fx.odds.find(o => o.label === OUTCOME_TO_LABEL[prof.dominantOutcome])!
    const s1 = fx.odds.find(o => o.label === OUTCOME_TO_LABEL[prof.breakoutOutcome])!
    return { fixture: fx, state0: s0, state1: s1, volatility: computeVolatility(s0, s1) }
  })
}

// The proposed fix: force every game onto the total-goals axis (Over/Under 2.5),
// a TRUE binary partition. state0 = dominant (lower odds) side, state1 = the other.
function buildSelectionsForcedTotals(fixtures: Fixture[]): MatchSelection[] {
  return fixtures.map(fx => {
    const over = fx.odds.find(o => o.label === 'Over 2.5')!
    const under = fx.odds.find(o => o.label === 'Under 2.5')!
    const [s0, s1] = under.value <= over.value ? [under, over] : [over, under]
    return { fixture: fx, state0: s0, state1: s1, volatility: computeVolatility(s0, s1) }
  })
}

// Win-region overlap of a game's two states: P(both state0 AND state1 resolve).
// 0 for a true complement; large for an overlapping axis like DC12/DC1X.
function stateOverlap(dist: ScorelineDist, m0: FpMarket, m1: FpMarket): number {
  let p = 0
  for (const e of dist) if (resolveMarket(m0, e.s) && resolveMarket(m1, e.s)) p += e.p
  return p
}

describe('Fingerprint analysis of the v3 matrix', () => {
  // ── ground truth + matrix ────────────────────────────────────────────────
  const dists = GAMES.map(g => poissonDist(g.lh, g.la))
  const fixtures = dists.map((d, i) => buildFixture(i + 1, d))
  const selections = buildSelections(fixtures)
  const config: SessionConfig = { date: '2026-06-19', stakePerSlip: 200, numAccounts: 6, sessionPrefix: 'PROTO' }
  const slips = generateMatrix(selections, config)

  it('fingerprint is internally consistent', () => {
    for (const s of allScorelines(6)) {
      expect(resolveMarket('ODD', s)).toBe(!resolveMarket('EVEN', s))
      const result = [resolveMarket('HOME', s), resolveMarket('DRAW', s), resolveMarket('AWAY', s)]
      expect(result.filter(Boolean)).toHaveLength(1)
      if (resolveMarket('OVER_2_5', s)) expect(resolveMarket('OVER_1_5', s)).toBe(true)
    }
  })

  it('DC12 and DC1X are NOT complements — they overlap on home wins', () => {
    const d = poissonDist(2.0, 0.6) // home fortress
    const sum = pMarket(d, 'DC12') + pMarket(d, 'DC1X')
    expect(sum).toBeGreaterThan(1) // overlap ⇒ flipping a DC-profiled game is a phantom flip
  })

  it('REPORT: duplicates + dead-weight in the 56-slip matrix', () => {
    // 1) per-game profiling + phantom-axis check
    console.log('\n── PER-GAME PROFILING (what axis v3 chose) ───────────────────────')
    selections.forEach((sel, i) => {
      const p0 = pMarket(dists[i], labelToMarket(sel.state0.label)!)
      const p1 = pMarket(dists[i], labelToMarket(sel.state1.label)!)
      const flag = p0 + p1 > 1.02 ? '  ⚠ OVERLAP (phantom flip)' : ''
      console.log(
        `${GAMES[i].name.padEnd(20)} state0=${sel.state0.label.padEnd(9)}(p=${p0.toFixed(2)}) ` +
        `state1=${sel.state1.label.padEnd(9)}(p=${p1.toFixed(2)}) sum=${(p0 + p1).toFixed(2)}${flag}`,
      )
    })

    // 2) duplicates
    const dups = findDuplicateGroups(slips)
    console.log(`\n── DUPLICATE SLIPS (identical bet, different tier/stake) ──────────`)
    console.log(`${dups.length} duplicate groups covering ${dups.reduce((n, g) => n + g.length, 0)} slips`)
    for (const g of dups.slice(0, 4)) {
      console.log(`  slipIds [${g.map(s => `${s.slipId}/${s.tier}`).join(', ')}]`)
    }
    expect(dups.length).toBeGreaterThanOrEqual(8) // PIVOT re-stakes CORE's 8 single-flips

    // 3) score every slip
    const scores = scoreMatrix(slips, dists)
    for (const s of scores) expect(Number.isFinite(s.winProb)).toBe(true)
    const sorted = [...scores].sort((a, b) => b.winProb - a.winProb)

    console.log('\n── TOP 6 SLIPS BY REAL WIN PROBABILITY ───────────────────────────')
    for (const s of sorted.slice(0, 6)) {
      console.log(`  S${String(s.slipId).padStart(2)} ${s.tier.padEnd(7)} odds=${s.combinedOdds.toFixed(1).padStart(7)}× win=${(s.winProb * 100).toFixed(2)}%  EV=${s.ev.toFixed(3)}`)
    }
    console.log('── BOTTOM 6 SLIPS (dead weight) ──────────────────────────────────')
    for (const s of sorted.slice(-6)) {
      console.log(`  S${String(s.slipId).padStart(2)} ${s.tier.padEnd(7)} odds=${s.combinedOdds.toFixed(1).padStart(9)}× win=${(s.winProb * 100).toFixed(4)}%  EV=${s.ev.toFixed(3)}`)
    }

    // 4) parity chaos phantom (slipId 55 = vector [1,0,1,0,1,0,1,0])
    const parity = scores.find(s => s.slipId === 55)!
    const median = sorted[Math.floor(sorted.length / 2)].winProb
    console.log(`\n── CHAOS parity slip S55: win=${(parity.winProb * 100).toFixed(4)}%  (matrix median ${(median * 100).toFixed(2)}%)`)

    // 5) prune summary
    const THRESHOLD = 0.005 // 0.5% real win probability
    const belowIds = new Set(scores.filter(s => s.winProb < THRESHOLD).map(s => s.slipId))
    const dupExtraIds = new Set(dups.flatMap(g => g.slice(1).map(s => s.slipId))) // keep 1 per group
    const removable = new Set([...belowIds, ...dupExtraIds])
    console.log(`\n── PRUNE SUMMARY ─────────────────────────────────────────────────`)
    console.log(`  ${dupExtraIds.size} redundant duplicate copies`)
    console.log(`  ${belowIds.size} slips below ${THRESHOLD * 100}% win probability`)
    console.log(`  → ${removable.size} of 56 slips removable without losing distinct coverage`)
  })

  it('REPORT: before/after forcing the total-goals axis', () => {
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length

    function axisMetrics(sels: MatchSelection[]) {
      const matrix = generateMatrix(sels, config)
      const scores = scoreMatrix(matrix, dists)
      const wins = scores.map(s => s.winProb).sort((a, b) => a - b)
      const evs = scores.map(s => s.ev)
      const overlaps = sels.map((sel, i) =>
        stateOverlap(dists[i], labelToMarket(sel.state0.label)!, labelToMarket(sel.state1.label)!),
      )
      // distinct real bets: how many unique win-probabilities (4 dp) the 56 slips collapse to
      const distinct = new Set(scores.map(s => s.winProb.toFixed(4))).size
      return {
        avgOverlap: mean(overlaps),
        phantomGames: overlaps.filter(o => o > 0.02).length,
        exactDupes: findDuplicateGroups(matrix).reduce((n, g) => n + g.length - 1, 0),
        distinctBets: distinct,
        winMin: wins[0],
        winMax: wins[wins.length - 1],
        live: wins.filter(p => p > 0.01).length,
        dead: wins.filter(p => p < 0.005).length,
        evMin: Math.min(...evs),
        evMax: Math.max(...evs),
      }
    }

    const before = axisMetrics(buildSelections(fixtures))            // v3 profiler (DC-grabbing)
    const after = axisMetrics(buildSelectionsForcedTotals(fixtures)) // forced total-goals axis

    const row = (k: string, b: string, a: string) => console.log(`  ${k.padEnd(26)}${b.padStart(12)}${a.padStart(14)}`)
    console.log('\n── BEFORE vs AFTER (force total-goals axis) ──────────────────────')
    console.log(`  ${''.padEnd(26)}${'v3 profiler'.padStart(12)}${'total-goals'.padStart(14)}`)
    row('avg state overlap', before.avgOverlap.toFixed(3), after.avgOverlap.toFixed(3))
    row('phantom-flip games /8', String(before.phantomGames), String(after.phantomGames))
    row('distinct real bets /56', String(before.distinctBets), String(after.distinctBets))
    row('win-prob min', (before.winMin * 100).toFixed(2) + '%', (after.winMin * 100).toFixed(2) + '%')
    row('win-prob max', (before.winMax * 100).toFixed(2) + '%', (after.winMax * 100).toFixed(2) + '%')
    row('live slips (>1%) /56', String(before.live), String(after.live))
    row('dead-weight (<0.5%)', String(before.dead), String(after.dead))
    row('exact dupes (PIVOT)', String(before.exactDupes), String(after.exactDupes))
    row('EV range', `${before.evMin.toFixed(2)}-${before.evMax.toFixed(2)}`, `${after.evMin.toFixed(2)}-${after.evMax.toFixed(2)}`)
    console.log('  NOTE: forcing a TRUE axis exposes that 8 coin-flip legs make most')
    console.log('        flip-vectors dead weight — DC short odds were hiding it. 8 legs is the real issue.')

    // What rigorously holds: the axis fix removes phantom flips; EV is untouched
    // (it is the 8-leg vig, not the axis). It does NOT make 56 flip-vectors "good" —
    // on a true axis most become dead weight, which is the case for short pools + anchors.
    expect(before.phantomGames).toBeGreaterThan(0)
    expect(after.avgOverlap).toBeLessThan(before.avgOverlap)
    expect(after.phantomGames).toBe(0)
    expect(Math.abs(after.evMax - before.evMax)).toBeLessThan(0.05)
  })

  it('REPORT: optimized coverage of the 256 space (win-rate vs break-even dial)', () => {
    // True axis per game: Over/Under 2.5, state0 = dominant (higher true prob).
    const axes: GameAxis[] = GAMES.map((g, i) => {
      const d = dists[i]
      return makeAxis(
        g.name,
        pMarket(d, 'UNDER_2_5'), bookOdds(d, 'UNDER_2_5'), 'Under 2.5',
        pMarket(d, 'OVER_2_5'), bookOdds(d, 'OVER_2_5'), 'Over 2.5',
      )
    })

    const B = 10_000
    const targets = [0.70, 0.85, 1.00, 1.20, 1.40]
    const results = targets.map(t => optimizeCoverage(axes, { bankroll: B, costTarget: t }))

    console.log('\n── OPTIMIZED COVERAGE of the 256 binary space  (B = ₦10,000) ─────')
    console.log('  costTgt  slips  winRate  return/hit  net/hit    EV      <₦100')
    results.forEach((r, k) => {
      console.log(
        `   ${targets[k].toFixed(2)}    ${String(r.slips.length).padStart(4)}    ` +
        `${(r.winRate * 100).toFixed(1).padStart(5)}%   ₦${r.returnPerHit.toFixed(0).padStart(6)}   ` +
        `${(r.netOnHit >= 0 ? '+' : '')}${(r.netOnHit / B * 100).toFixed(0).padStart(3)}%   ` +
        `₦${r.expectedValue.toFixed(0).padStart(5)}    ${r.slips.length - r.belowMinStake}/${r.slips.length}`,
      )
    })

    const be = results[2] // costTarget ≈ 1.0 → break-even on every win, max win rate
    console.log(`\n  ➤ BREAK-EVEN BUILD (target 1.0): ${be.slips.length} slips, win rate ${(be.winRate * 100).toFixed(1)}%,`)
    console.log(`    every covered session returns ₦${be.returnPerHit.toFixed(0)} (worst covered case = break-even),`)
    console.log(`    only the uncovered ${(be.uncoveredProb * 100).toFixed(1)}% of sessions lose the bankroll.`)
    console.log('    slip spread (flips / odds / stake → return):')
    const step = Math.max(1, Math.ceil(be.slips.length / 6))
    ;[...be.slips].sort((a, b) => a.combinedOdds - b.combinedOdds).filter((_, i) => i % step === 0).forEach(s => {
      console.log(`      ${s.flips} flips  odds=${s.combinedOdds.toFixed(1).padStart(8)}×  stake=₦${s.stake.toFixed(0).padStart(4)}  → ₦${s.returnIfHit.toFixed(0)}`)
    })

    // EV is invariant across the whole dial (it is the book overround). Win rate is the dial.
    const evs = results.map(r => r.expectedValue)
    for (const ev of evs) expect(Math.abs(ev - evs[0])).toBeLessThan(B * 0.02)
    // More coverage ⇒ higher win rate; break-even target returns ≥ bankroll on a win.
    expect(results[4].winRate).toBeGreaterThan(results[0].winRate)
    expect(be.returnPerHit).toBeGreaterThanOrEqual(B * 0.98)
    // Dutch staking spends exactly the bankroll.
    for (const r of results) {
      expect(Math.abs(r.slips.reduce((s, x) => s + x.stake, 0) - B)).toBeLessThan(1)
    }
  })
})
