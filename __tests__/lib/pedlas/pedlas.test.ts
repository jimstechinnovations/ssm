// __tests__/lib/pedlas/pedlas.test.ts
// Deterministic PEDLAS engine tests (no NIM key required — rank: 'deterministic').

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import type { BinaryAxis } from '../../../lib/pedlas/types'
import type { Fixture } from '../../../lib/ssm/types'
import { selectAxes } from '../../../lib/pedlas/market-select'
import { boostedPayout, boostPercent, honestEvMultiple } from '../../../lib/pedlas/boost'
import { boostFor } from '../../../lib/spm/leg-stacker'
import { enumerateVectors, makeVector, combinedOddsOf, trueProbOf } from '../../../lib/pedlas/vectors'
import {
  maxIdenticalRunOf, applyAnchorDistance, applyElimination, capPoolByLeague,
} from '../../../lib/pedlas/constraints'
import { hammingDistance, applySeparation } from '../../../lib/pedlas/separation'
import { buildPedlasBook } from '../../../lib/pedlas/build'

// ── helpers ──────────────────────────────────────────────────────────────────────
function devigAxis(
  fixtureId: number, league: string, leagueId: number, kickoff: string,
  line: number, underOdds: number, overOdds: number,
): BinaryAxis {
  const iU = 1 / underOdds, iO = 1 / overOdds, sum = iU + iO
  const underProb = iU / sum, overProb = iO / sum
  return {
    fixtureId, game: `T${fixtureId}H vs T${fixtureId}A`, league, leagueId, kickoff, line,
    underOdds, underProb, overOdds, overProb, margin: sum - 1,
    volatility: 2 * Math.min(underProb, overProb),
  }
}

function pool(n: number): BinaryAxis[] {
  // n axes spread across 3 leagues, staggered kickoffs, all Under ≥ 1.20.
  const base = Date.UTC(2026, 5, 27, 12, 0, 0)
  return Array.from({ length: n }, (_, i) =>
    devigAxis(
      100 + i,
      `League ${i % 3}`, i % 3,
      new Date(base + i * 3_600_000).toISOString(),
      4.5,
      1.26 + (i % 4) * 0.03,   // under 1.26–1.35
      3.4 + (i % 5) * 0.25,    // over 3.4–4.4
    ),
  )
}

// ── boost ──────────────────────────────────────────────────────────────────────
describe('PEDLAS boost (Betway displayed-return boost, real Betway schedule)', () => {
  it('reuses leg-stacker boostFor as the single source of truth', () => {
    expect(boostPercent(11)).toBe(20)   // 11 legs → +20%
    expect(boostPercent(50)).toBe(1000) // 50 legs → +1000%
    expect(boostPercent(2)).toBe(0)     // below tier
  })

  it('matches Betway Nigeria betslip display: stake * odds * (1 + boost)', () => {
    // stake 100, odds 15.1, 11 legs, b=0.20: payout = 100·(1 + 14.1·1.2) = 100·17.92 = 1792
    const stake = 100, O = 15.1, L = 11
    const expected = stake * O * (1 + boostFor(L))
    expect(boostedPayout(stake, O, L)).toBeCloseTo(expected, 6)
    // strictly less than the naive stake·O·(1+b) convention
  })
})

// ── market selection ─────────────────────────────────────────────────────────────
describe('PEDLAS market selection', () => {
  const fx = (id: number, odds: { line: number; under: number; over: number }[]): Fixture => ({
    id, homeTeam: `H${id}`, awayTeam: `A${id}`, league: 'EPL', leagueId: 1,
    kickoff: '2026-06-27T12:00:00Z', odds: odds.flatMap(o => ([
      { bookmaker: 'b', market: `OVER_UNDER_${o.line}` as Fixture['odds'][number]['market'], label: `Under ${o.line}`, value: o.under },
      { bookmaker: 'b', market: `OVER_UNDER_${o.line}` as Fixture['odds'][number]['market'], label: `Over ${o.line}`, value: o.over },
    ])),
  })

  it('keeps only Under ≥ 1.20 and picks the most-dominant qualifying line', () => {
    // Under 3.5 @ 1.50, Under 4.5 @ 1.28, Under 5.5 @ 1.10 (disqualified).
    const axes = selectAxes([fx(1, [
      { line: 3.5, under: 1.50, over: 2.60 },
      { line: 4.5, under: 1.28, over: 3.55 },
      { line: 5.5, under: 1.10, over: 6.00 },
    ])])
    expect(axes).toHaveLength(1)
    expect(axes[0].line).toBe(4.5)            // lowest qualifying Under odds = most dominant
    expect(axes[0].underOdds).toBe(1.28)
  })

  it('drops fixtures with no qualifying line', () => {
    const axes = selectAxes([fx(2, [{ line: 5.5, under: 1.08, over: 7.0 }])])
    expect(axes).toHaveLength(0)
  })

  it('de-vigs to probabilities that sum to 1', () => {
    const axes = selectAxes([fx(3, [{ line: 4.5, under: 1.28, over: 3.55 }])])
    expect(axes[0].underProb + axes[0].overProb).toBeCloseTo(1, 10)
    expect(axes[0].margin).toBeGreaterThan(0)
  })
})

// ── vectors + the EV identity ────────────────────────────────────────────────────
describe('PEDLAS vectors', () => {
  it('enumerates exactly 2^L vectors', () => {
    expect(enumerateVectors(pool(6))).toHaveLength(64)
    expect(enumerateVectors(pool(8))).toHaveLength(256)
  })

  it('EV IDENTITY: trueProb × combinedOdds is identical for every vector (= ∏ 1/(1+mᵢ))', () => {
    const axes = pool(7)
    const expected = axes.reduce((acc, a) => acc * (1 / (1 + a.margin)), 1)
    for (const v of enumerateVectors(axes)) {
      expect(v.trueProb * v.combinedOdds).toBeCloseTo(expected, 9)
    }
  })

  it('odds/prob match a hand-computed vector', () => {
    const axes = pool(3)
    const vec: (0 | 1)[] = [0, 1, 0]
    const v = makeVector(vec, axes)
    expect(v.combinedOdds).toBeCloseTo(axes[0].underOdds * axes[1].overOdds * axes[2].underOdds, 9)
    expect(v.trueProb).toBeCloseTo(axes[0].underProb * axes[1].overProb * axes[2].underProb, 9)
    expect(v.overFlips).toBe(1)
    expect(combinedOddsOf(vec, axes)).toBe(v.combinedOdds)
    expect(trueProbOf(vec, axes)).toBe(v.trueProb)
  })

  it('honest EV multiple is below 1 at any real margin (boost cannot create edge)', () => {
    const axes = pool(11)
    for (const v of enumerateVectors(axes).slice(0, 200)) {
      const ev = honestEvMultiple(v.trueProb, v.combinedOdds, axes.length)
      expect(ev).toBeLessThan(1)
    }
  })
})

// ── constraints ──────────────────────────────────────────────────────────────────
describe('PEDLAS constraints (E/D/A)', () => {
  it('maxIdenticalRunOf counts the longest run', () => {
    expect(maxIdenticalRunOf([0, 0, 0, 1, 1])).toBe(3)
    expect(maxIdenticalRunOf([1, 0, 1, 0])).toBe(1)
    expect(maxIdenticalRunOf([1, 1, 1, 1])).toBe(4)
  })

  it('A — anchor distance keeps only vectors with enough Over-flips', () => {
    const vs = enumerateVectors(pool(6))
    const kept = applyAnchorDistance(vs, 2)
    expect(kept.every(v => v.overFlips >= 2)).toBe(true)
    expect(kept.some(v => v.overFlips === 2)).toBe(true)
  })

  it('E — elimination removes long identical runs (and is off when maxRun ≥ L)', () => {
    const vs = enumerateVectors(pool(6))
    const kept = applyElimination(vs, 3, 6)
    expect(kept.every(v => maxIdenticalRunOf(v.vector) <= 3)).toBe(true)
    expect(applyElimination(vs, 6, 6)).toHaveLength(vs.length) // disabled
  })

  it('D — capPoolByLeague limits axes per competition', () => {
    const capped = capPoolByLeague(pool(9), 2) // 3 leagues × up to 2
    const counts = new Map<number, number>()
    for (const a of capped) counts.set(a.leagueId, (counts.get(a.leagueId) ?? 0) + 1)
    expect([...counts.values()].every(c => c <= 2)).toBe(true)
  })
})

// ── separation ───────────────────────────────────────────────────────────────────
describe('PEDLAS separation (S)', () => {
  it('hammingDistance counts differing positions', () => {
    expect(hammingDistance([0, 0, 0], [0, 1, 1])).toBe(2)
    expect(hammingDistance([1, 1], [1, 1])).toBe(0)
  })

  it('every kept pair is at least minSeparation apart, capped at limit', () => {
    const ranked = enumerateVectors(pool(8))
    const kept = applySeparation(ranked, 3, 6)
    expect(kept.length).toBeLessThanOrEqual(6)
    for (let i = 0; i < kept.length; i++)
      for (let j = i + 1; j < kept.length; j++)
        expect(hammingDistance(kept[i].vector, kept[j].vector)).toBeGreaterThanOrEqual(3)
  })
})

// ── end-to-end book ──────────────────────────────────────────────────────────────
describe('buildPedlasBook (deterministic)', () => {
  it('produces a budget-FILLED, scattered, anchor-distant, honest book', async () => {
    const axes = pool(11)
    const book = await buildPedlasBook({
      axes, budget: 1000, minStake: 100, rank: 'deterministic',
      params: { minAnchorDistance: 3, maxIdenticalRun: 6, maxPerLeague: 4 },
    })

    expect(book.mode).toBe('pedlas')
    expect(book.legCount).toBe(11)
    expect(book.K).toBe(10)
    expect(book.meta.ranked).toBe('deterministic')
    expect(book.slips.length).toBe(book.K)   // budget fully filled (no rigid-S under-fill)
    expect(book.compressionRatio).toBeGreaterThan(1)

    // honesty: never advertise +EV from structure/boost
    expect(book.verdict.positiveEV).toBe(false)
    expect(book.verdict.evMultiple).toBeLessThan(1)
    expect(book.verdict.honestLabel).toMatch(/does NOT beat the bookmaker margin/i)

    for (const s of book.slips) {
      expect(s.legCount).toBe(11)
      expect(s.legs).toHaveLength(11)
      expect(s.vector.reduce((a: number, b) => a + b, 0)).toBeGreaterThanOrEqual(3) // A
      expect(s.boostPct).toBe(boostPercent(11))
      // accurate winnings-boosted payout, clamped to the default ₦50M cap
      expect(s.uncappedPayout).toBeCloseTo(boostedPayout(100, s.combinedOdds, 11), 4)
      expect(s.payout).toBeCloseTo(Math.min(s.uncappedPayout, 50_000_000), 4)
    }
    // scattered: every placed slip is a distinct variant
    const seen = new Set(book.slips.map(s => s.vector.join('')))
    expect(seen.size).toBe(book.slips.length)

    // slips are mutually exclusive outcomes → pAnyHit = Σ trueProb ≤ 1
    const sum = book.slips.reduce((a, s) => a + s.trueProb, 0)
    expect(book.meta.pAnyHit).toBeCloseTo(sum, 9)
    expect(book.meta.pAnyHit).toBeLessThanOrEqual(1)
  })

  it('caps payout at maxPayout, forfeits upside, and reflects it in EV', async () => {
    const book = await buildPedlasBook({
      axes: pool(11), budget: 1000, minStake: 100, rank: 'deterministic', maxPayout: 1_000_000,
      params: { minAnchorDistance: 5, minSlipSeparation: 2, maxIdenticalRun: 99, maxPerLeague: 5 },
    })
    const capped = book.slips.filter(s => s.capped)
    expect(capped.length).toBeGreaterThan(0)
    for (const s of capped) {
      expect(s.payout).toBeLessThanOrEqual(1_000_000)
      expect(s.uncappedPayout).toBeGreaterThan(s.payout)
      expect(s.evMultiple).toBeCloseTo((s.trueProb * s.payout) / s.stake, 9)
    }
  })

  it('REPORT: realistic 11-leg book — small stake → big payout, honest EV', async () => {
    // 11 total-goals games, Under ≥ 1.20, varied Over upside across 4 leagues.
    const base = Date.UTC(2026, 5, 27, 11, 0, 0)
    const cfg = [
      [1.24, 3.9], [1.28, 3.6], [1.31, 3.3], [1.22, 4.2], [1.27, 3.7], [1.33, 3.1],
      [1.26, 3.8], [1.30, 3.4], [1.23, 4.0], [1.29, 3.5], [1.25, 3.85],
    ]
    const axes = cfg.map(([u, o], i) =>
      devigAxis(200 + i, `League ${i % 4}`, i % 4, new Date(base + i * 2_700_000).toISOString(), 4.5, u, o))

    const book = await buildPedlasBook({
      axes, budget: 1000, minStake: 100, rank: 'deterministic',
      params: { minAnchorDistance: 3, minSlipSeparation: 4, maxIdenticalRun: 6, maxPerLeague: 4 },
    })

    const naira = (x: number) => '₦' + Math.round(x).toLocaleString('en-US')
    console.log('\n── PEDLAS BOOK (₦1,000 → 10×₦100, L=11, boost +' + book.slips[0]?.boostPct + '%) ──')
    console.log(`  candidates=${book.meta.candidateCount}  compressionRatio=${book.compressionRatio.toFixed(0)}×  ranked=${book.meta.ranked}`)
    console.log('  slip  overFlips  combinedOdds   payout(₦100)   hitProb   EVmult')
    for (const s of book.slips) {
      console.log(
        `   ${String(s.slipId).padStart(2)}      ${s.vector.reduce((a: number, b) => a + b, 0)}        ` +
        `${s.combinedOdds.toFixed(1).padStart(8)}    ${naira(s.payout).padStart(11)}   ` +
        `${(s.trueProb * 100).toFixed(3).padStart(6)}%   ${s.evMultiple.toFixed(3)}`,
      )
    }
    console.log(`  P(any slip hits) = ${(book.meta.pAnyHit * 100).toFixed(2)}%   ` +
      `book EV/₦1 = ${book.verdict.evMultiple.toFixed(3)} (−${((1 - book.verdict.evMultiple) * 100).toFixed(1)}%)  +EV=${book.verdict.positiveEV}`)
    console.log('  ' + book.verdict.honestLabel)
    expect(book.slips.length).toBeGreaterThan(0)
  })

  it('property: placed slips honour A, are distinct, and fill the budget for random pools', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 6, max: 12 }),
        async (n) => {
          const book = await buildPedlasBook({
            axes: pool(n), budget: 800, minStake: 100, rank: 'deterministic',
            params: { minAnchorDistance: 2, maxIdenticalRun: 99, maxPerLeague: 5 },
          })
          for (const s of book.slips) {
            expect(s.vector.reduce((a: number, b) => a + b, 0)).toBeGreaterThanOrEqual(2) // A
          }
          // distinct variants
          const seen = new Set(book.slips.map(s => s.vector.join('')))
          expect(seen.size).toBe(book.slips.length)
          // budget filled when candidates allow (n≥7 ⇒ ≥ K=8 candidates with A≥2)
          if (n >= 8) expect(book.slips.length).toBe(book.K)
        },
      ),
      { numRuns: 25 },
    )
  })
})
