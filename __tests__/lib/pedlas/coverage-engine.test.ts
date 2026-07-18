import { describe, it, expect } from 'vitest'
import type { BinaryAxis } from '@/lib/pedlas/types'
import { buildDiverseUnderSlips, simulateFamily, calibrateBeta, planCoverage, cutProb, buildFlipScatter } from '@/lib/pedlas/coverage'
import { noBoost } from '@/lib/pedlas/boost'

/** Synthetic pool: Under odds ~1.2 with a spread of cut (Over) probabilities. */
function makePool(n: number, overProbs?: number[]): BinaryAxis[] {
  return Array.from({ length: n }, (_, i) => {
    const overP = overProbs?.[i] ?? 0.12 + 0.2 * (i / n) // 12%..32% cut prob
    const underP = 1 - overP
    return {
      fixtureId: 1000 + i, game: `H${i} vs A${i}`, league: `L${i % 5}`, leagueId: i % 5,
      kickoff: new Date(Date.now() + (i + 3) * 3600_000).toISOString(), line: 4.5 as const,
      underOdds: +(1 / underP * 0.97).toFixed(2), underProb: underP,
      overOdds: +(1 / overP * 0.97).toFixed(2), overProb: overP,
      margin: 0.03, volatility: 2 * Math.min(underP, overP),
    }
  })
}

describe('coverage engine: construction invariants', () => {
  it('builds K all-Under slips of L legs, keeping the safest game in every slip', () => {
    const pool = makePool(20)
    const fam = buildDiverseUnderSlips(pool, { L: 12, K: 50, stake: 10, maxPayout: 1e9, boost: noBoost })
    expect(fam.slips).toHaveLength(50)
    for (const s of fam.slips) {
      expect(s.legs).toHaveLength(12)
      expect(s.legs.every(l => l.side === 'Under')).toBe(true)
    }
    // risk-aware: the safest game is KEPT more often than the riskiest is (but neither never/always)
    const byRisk = pool.map((_, i) => i).sort((a, b) => cutProb(pool[a]) - cutProb(pool[b]))
    const keepRate = (idx: number) => fam.legIndexSets.filter(set => set.includes(idx)).length / fam.slips.length
    const keptSafest = keepRate(byRisk[0]), keptRiskiest = keepRate(byRisk[byRisk.length - 1])
    expect(keptSafest).toBeGreaterThan(keptRiskiest)
    expect(keptSafest).toBeLessThan(1)          // safest can still drop → not a single point of failure
    expect(fam.distinctOmissions).toBeGreaterThan(1)
  })

  it('L >= N collapses to a single all-in combo (no diversity possible)', () => {
    const pool = makePool(8)
    const fam = buildDiverseUnderSlips(pool, { L: 8, K: 10, stake: 10, maxPayout: 1e9, boost: noBoost })
    expect(fam.slips[0].legs).toHaveLength(8)
    expect(fam.distinctOmissions).toBe(1)
  })
})

describe('coverage engine: honest simulation', () => {
  it('shorter slips win more often than longer ones', () => {
    const pool = makePool(24)
    const short = buildDiverseUnderSlips(pool, { L: 6, K: 200, stake: 10, maxPayout: 1e9, boost: noBoost })
    const long = buildDiverseUnderSlips(pool, { L: 18, K: 200, stake: 10, maxPayout: 1e9, boost: noBoost })
    const ps = simulateFamily(short, pool, { trials: 800, beta: 0 }).pAnyWin
    const pl = simulateFamily(long, pool, { trials: 800, beta: 0 }).pAnyWin
    expect(ps).toBeGreaterThan(pl)
    expect(ps).toBeGreaterThan(0.9)
  })

  it('an all-safe pool wins ~always; an all-risky pool rarely wins', () => {
    const safe = makePool(15, Array(15).fill(0.03))
    const risky = makePool(15, Array(15).fill(0.5))
    const fSafe = buildDiverseUnderSlips(safe, { L: 10, K: 100, stake: 10, maxPayout: 1e9, boost: noBoost })
    const fRisky = buildDiverseUnderSlips(risky, { L: 10, K: 100, stake: 10, maxPayout: 1e9, boost: noBoost })
    expect(simulateFamily(fSafe, safe, { trials: 500, beta: 0 }).pAnyWin).toBeGreaterThan(0.95)
    expect(simulateFamily(fRisky, risky, { trials: 500, beta: 0 }).pAnyWin).toBeLessThan(0.25)
  })

  it('correlation (beta>0) raises modeled E[return] vs independent — the correlated-parlay effect', () => {
    // With marginals preserved, positive cutter-correlation makes SURVIVALS co-occur, lifting parlay
    // E[return] above the −vig-independent baseline. This is a MODEL effect, not a proven edge.
    const pool = makePool(24)
    const fam = buildDiverseUnderSlips(pool, { L: 14, K: 300, stake: 10, maxPayout: 1e9, boost: noBoost })
    const indep = simulateFamily(fam, pool, { trials: 800, beta: 0 }).evReturn
    const corr = simulateFamily(fam, pool, { trials: 800, beta: 1.2 }).evReturn
    expect(corr).toBeGreaterThan(indep)
  })

  it('with NO correlation, long parlays keep negative net EV (−vig compounds)', () => {
    const pool = makePool(24)
    const fam = buildDiverseUnderSlips(pool, { L: 16, K: 300, stake: 10, maxPayout: 1e9, boost: noBoost })
    const r = simulateFamily(fam, pool, { trials: 400, beta: 0 })
    expect(r.net).toBeLessThan(0) // no free lunch from structure alone
  })

  it('calibrateBeta returns a positive beta that raises over-dispersion', () => {
    const pool = makePool(30)
    const beta = calibrateBeta(pool, 1.7, 800)
    expect(beta).toBeGreaterThan(0)
    const empty = { slips: [], legIndexSets: [], L: 0, distinctOmissions: 0 }
    const r0 = simulateFamily(empty, pool, { trials: 800, beta: 0 })
    const rb = simulateFamily(empty, pool, { trials: 800, beta })
    expect(rb.varCutters / rb.meanCutters).toBeGreaterThan(r0.varCutters / r0.meanCutters)
  })
})

describe('coverage engine: layered covering design', () => {
  // 6 flip-eligible games (overP ≥ 0.20) + 4 locked games the signal says are near-certain Under (0.04)
  const coveringPool = () => makePool(10, [0.30, 0.28, 0.26, 0.24, 0.22, 0.20, 0.04, 0.04, 0.04, 0.04])

  it('splits into a signal-eligible set + locked games that are NEVER flipped', () => {
    const fam = buildFlipScatter(coveringPool(), { target: 100000, stake: 10, K: 500, maxPayout: 1e9, boost: noBoost, overThreshold: 0.12 })
    expect(fam.eligible.length).toBe(6)     // the 6 games with P(Over) ≥ 0.12
    expect(fam.lockedCount).toBe(4)
    // base present
    expect(fam.vectors.some(v => v.every(b => b === 0))).toBe(true)
    // every ELIGIBLE game has a single-Over slip (complete layer 1)
    for (const i of fam.eligible) expect(fam.vectors.some(v => v[i] === 1 && v.reduce((a: number, b) => a + b, 0) === 1)).toBe(true)
    // locked games (indices 6..9) are never turned Over in ANY slip
    for (let i = 6; i < 10; i++) expect(fam.vectors.every(v => v[i] === 0)).toBe(true)
    // distinct
    expect(new Set(fam.vectors.map(v => v.join(''))).size).toBe(fam.vectors.length)
  })

  it('completes flip-layers in order — ALL C(|E|,k) patterns present for every k ≤ completeDepth', () => {
    const fam = buildFlipScatter(coveringPool(), { target: 100000, stake: 10, K: 500, maxPayout: 1e9, boost: noBoost, overThreshold: 0.12 })
    // 6 eligible ⇒ full 2^6 = 64 patterns fit within 500 ⇒ the whole cluster is covered
    expect(fam.completeDepth).toBe(6)
    expect(fam.vectors.length).toBe(64)
    const present = new Set(fam.vectors.map(v => v.join('')))
    for (let mask = 0; mask < (1 << fam.eligible.length); mask++) {
      const v = new Array(fam.N).fill(0)
      for (let b = 0; b < fam.eligible.length; b++) if (mask & (1 << b)) v[fam.eligible[b]] = 1
      expect(present.has(v.join(''))).toBe(true)   // every outcome of the 6 eligible games is covered
    }
  })

  it('scatter mode: spreads flips deep but obeys ≤maxFlipFrac Overs and no run of ≥maxRun', () => {
    const overProbs = Array.from({ length: 20 }, () => 0.20) // 20 flip-eligible games
    const fam = buildFlipScatter(makePool(20, overProbs), { target: 100000, stake: 10, K: 500, maxPayout: 1e9, boost: noBoost, overThreshold: 0.12, maxFlipFrac: 0.5, maxRun: 3 })
    const runLen = (v: (0 | 1)[]) => { let m = 0, r = 0; for (const b of v) { r = b ? r + 1 : 0; if (r > m) m = r } return m }
    for (const v of fam.vectors) {
      expect(v.reduce((a: number, b) => a + b, 0)).toBeLessThanOrEqual(Math.floor(0.5 * fam.N)) // ≤ 50% Over
      expect(runLen(v)).toBeLessThan(3)                                                          // no 3 consecutive Overs
    }
    expect(fam.maxFlipReached).toBeGreaterThan(2)   // it really does go deeper than the shallow default
  })

  it('when the cluster is too big for the budget, completes low layers then partially fills the next', () => {
    const overProbs = Array.from({ length: 12 }, (_, i) => 0.30 - i * 0.014) // 12 eligible (all ≥ 0.13)
    const fam = buildFlipScatter(makePool(12, overProbs), { target: 100000, stake: 10, K: 200, maxPayout: 1e9, boost: noBoost, overThreshold: 0.12 })
    expect(fam.eligible.length).toBe(12)
    // base(1) + singles C(12,1)=12 + doubles C(12,2)=66 = 79 ≤ 200; triples C(12,3)=220 overflow ⇒ partial
    expect(fam.completeDepth).toBe(2)
    expect(fam.partialDepth).toBe(3)
    expect(fam.vectors.length).toBe(200)
    // all singles and all doubles over E are present (the complete guarantee)
    for (const [i, j] of fam.eligible.flatMap((a, x) => fam.eligible.slice(x + 1).map(b => [a, b] as const))) {
      const v = new Array(fam.N).fill(0); v[i] = 1; v[j] = 1
      expect(fam.vectors.some(w => w.join('') === v.join(''))).toBe(true)
    }
  })
})

describe('coverage engine: planner', () => {
  it('returns a frontier and a best plan for a ₦5000/₦10 budget', () => {
    const pool = makePool(28)
    const plan = planCoverage(pool, { budget: 5000, stake: 10, maxPayout: 1e9, boost: noBoost, trials: 500 })
    expect(plan.K).toBe(500)
    expect(plan.candidates.length).toBeGreaterThan(3)
    expect(plan.best.pAnyWin).toBeGreaterThan(0)
    expect(plan.beta).toBeGreaterThan(0)
  })

  it('REPORT: ₦5000/500-slip frontier on a backtest-calibrated pool (N=40, mean cut ~22%)', () => {
    // Honest pool: Under-4.5 @ odds ≥1.20 selects LESS-safe Unders ⇒ cutProb ≥ ~0.17. Mean ~0.22.
    const rng = (() => { let s = 20260716; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff } })()
    const pool = makePool(40, Array.from({ length: 40 }, () => 0.16 + 0.20 * rng())) // 0.16..0.36
    const plan = planCoverage(pool, { budget: 5000, stake: 10, maxPayout: 50_000_000, boost: noBoost, trials: 1500 })
    // eslint-disable-next-line no-console
    console.log(`\n  ₦5000 · ₦10 stake · K=${plan.K} slips · N=${plan.poolSize} · β=${plan.beta.toFixed(2)} · mean cutters=${plan.meanCutters.toFixed(1)}`)
    // eslint-disable-next-line no-console
    console.log('  L   medianOdds  medianPayout   P(≥1 win)   E[return]     net EV')
    for (const c of plan.candidates) {
      // eslint-disable-next-line no-console
      console.log(`  ${String(c.L).padStart(2)}   ${c.medianOdds.toFixed(1).padStart(9)}   ₦${Math.round(c.medianPayout).toLocaleString().padStart(11)}   ${(100 * c.pAnyWin).toFixed(1).padStart(6)}%   ₦${Math.round(c.evReturn).toLocaleString().padStart(8)}   ₦${Math.round(c.net).toLocaleString().padStart(8)}`)
    }
    // eslint-disable-next-line no-console
    console.log(`  → best P(≥1 win): L=${plan.best.L}, payout ₦${Math.round(plan.best.medianPayout).toLocaleString()}, P=${(100 * plan.best.pAnyWin).toFixed(1)}%\n`)
    expect(plan.candidates[0].pAnyWin).toBeGreaterThan(plan.candidates[plan.candidates.length - 1].pAnyWin)
  })
})
