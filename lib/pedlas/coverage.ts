// lib/pedlas/coverage.ts
// PEDLA v3 strategy engine: turn a budget (K = budget/stake slips) into the slip family with the
// best HONEST chance that ≥1 slip wins — then TELL THE TRUTH about that chance (pedlas_v3.md §4–5,
// pedlas-cutter-backtest). No edge is created; every slip is −vig. We only choose leg-count and
// which games each slip drops so the family covers the likely cutter patterns.
//
// Two honest facts drive the design:
//   1. A slip (all-Under) wins iff none of its legs "cuts" (goes Over 4.5). The book's own de-vigged
//      P(Over) = axis.overProb is our cut probability p_i.
//   2. Cutters are CORRELATED (backtest: var/mean ≈ 1.7) — high-scoring matchdays lift many games at
//      once. So we simulate with a common-shock model, not independent coin flips, or we'd lie high.
//
// Strategy: keep the safe games in every slip (they anchor odds cheaply and rarely cut); DIVERSIFY
// which of the risky games each slip drops, so whichever risky games actually cut, some slip dropped
// them. Then sweep leg-count L to expose the payout↔hit-rate frontier and pick the best.

import 'server-only'
import type { BinaryAxis, PedlasSlip } from './types'
import { legFromAxis, recomputeSlip } from './edit'
import { boostFor, type BoostFn } from './boost'

/** Cut probability for a game = the book's de-vigged P(Over 4.5). */
export const cutProb = (a: BinaryAxis): number => Math.min(0.98, Math.max(0.02, a.overProb))

// ── deterministic RNG (reproducible plans) ──────────────────────────────────────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gaussian(rng: () => number): number {
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const logit = (p: number) => Math.log(p / (1 - p))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

// ── slip construction ───────────────────────────────────────────────────────────

export interface BuildSlipsOptions {
  L: number                 // legs per slip
  K: number                 // number of slips
  stake: number
  maxPayout: number
  boost?: BoostFn
  seed?: number
}

export interface SlipFamily {
  slips: PedlasSlip[]
  legIndexSets: number[][]  // per slip: the pool indices of its legs (for the simulator)
  L: number
  distinctOmissions: number // how many distinct drop-sets we achieved (diversity)
}

/**
 * Build K all-Under slips of L legs from `pool`. Safe games are always in; each slip drops D = N−L
 * games chosen (risk-weighted) from the riskiest region, diversified so drop-sets rarely repeat.
 */
export function buildDiverseUnderSlips(pool: BinaryAxis[], opts: BuildSlipsOptions): SlipFamily {
  const N = pool.length
  const L = Math.max(3, Math.min(opts.L, N))
  const D = N - L
  const boost = opts.boost ?? boostFor
  const rng = mulberry32(opts.seed ?? 0x9E3779B9)

  // Drops are risk-WEIGHTED over ALL games (not a fixed risky subset): the safest games are dropped
  // only rarely, but never NEVER — a game no slip ever drops is a guaranteed loss whenever it cuts.
  const allIdx = pool.map((_, i) => i)

  const buildLegs = (dropSet: Set<number>) => {
    const legs = []
    const legIdx: number[] = []
    for (let i = 0; i < N; i++) if (!dropSet.has(i)) { legs.push(legFromAxis(pool[i], 'Under')); legIdx.push(i) }
    return { legs, legIdx }
  }

  const slips: PedlasSlip[] = []
  const legIndexSets: number[][] = []
  const seen = new Set<string>()

  for (let k = 0; k < opts.K; k++) {
    let dropSet = new Set<number>()
    if (D > 0) {
      // up to a few tries to get a fresh drop-set (weighted-without-replacement over riskyRegion)
      for (let attempt = 0; attempt < 6; attempt++) {
        const cand = weightedSampleWithoutReplacement(allIdx, D, i => cutProb(pool[i]), rng)
        const key = [...cand].sort((a, b) => a - b).join(',')
        dropSet = new Set(cand)
        if (!seen.has(key)) { seen.add(key); break }
      }
    }
    const { legs, legIdx } = buildLegs(dropSet)
    const skeleton: PedlasSlip = {
      slipId: k + 1, vector: [], legs, legCount: legs.length, combinedOdds: 0, trueProb: 0,
      boostPct: 0, stake: opts.stake, payout: 0, uncappedPayout: 0, capped: false, evMultiple: 0, rankScore: 0,
    }
    slips.push(recomputeSlip(skeleton, pool, opts.stake, opts.maxPayout, boost))
    legIndexSets.push(legIdx)
  }
  return { slips, legIndexSets, L, distinctOmissions: D > 0 ? seen.size : 1 }
}

/** Weighted sampling of `m` distinct items from `items` with weight(i); simple sequential draw. */
function weightedSampleWithoutReplacement(items: number[], m: number, weight: (i: number) => number, rng: () => number): number[] {
  const pool = items.slice()
  const w = pool.map(weight)
  const out: number[] = []
  for (let pick = 0; pick < m && pool.length > 0; pick++) {
    let total = 0; for (const x of w) total += x
    let t = rng() * total, idx = 0
    while (idx < pool.length - 1 && (t -= w[idx]) > 0) idx++
    out.push(pool[idx]); pool.splice(idx, 1); w.splice(idx, 1)
  }
  return out
}

// ── honest simulation (correlated cutters) ──────────────────────────────────────

export interface SimResult {
  pAnyWin: number       // P(≥1 slip wins) — the number the user asked about
  evReturn: number      // E[total return across all winning slips] (₦)
  net: number           // evReturn − K·stake (honest, ≤0 in expectation)
  expWinners: number    // E[# winning slips]
  meanCutters: number
  varCutters: number
}

export interface SimOptions { trials?: number; beta?: number; seed?: number }

// Normal-weighted quadrature nodes for integrating over the shock z ~ N(0,1).
const QUAD = (() => {
  const J = 41, nodes: number[] = [], weights: number[] = []
  let wsum = 0
  for (let j = 0; j < J; j++) {
    const z = -4.5 + (9 * j) / (J - 1)
    const w = Math.exp(-0.5 * z * z)
    nodes.push(z); weights.push(w); wsum += w
  }
  for (let j = 0; j < J; j++) weights[j] /= wsum
  return { nodes, weights }
})()

/**
 * Re-centred intercept a_i for each game so that E_z[sigmoid(a_i + beta·z)] = p_i EXACTLY. Without
 * this, adding correlation (beta) would drag the marginal cut rate off the book's number — inflating
 * cutters and faking EV. The marginal must always stay the book's de-vigged P(Over).
 */
function recentredIntercepts(cutProbs: number[], beta: number): number[] {
  const { nodes, weights } = QUAD
  return cutProbs.map(p => {
    if (beta === 0) return logit(p)
    let lo = -14, hi = 14
    for (let it = 0; it < 40; it++) {
      const a = (lo + hi) / 2
      let m = 0; for (let j = 0; j < nodes.length; j++) m += weights[j] * sigmoid(a + beta * nodes[j])
      if (m < p) lo = a; else hi = a
    }
    return (lo + hi) / 2
  })
}

/**
 * P(≥1 win) + honest EV under a common-shock cutter model that PRESERVES marginals: each trial draws
 * z~N(0,1); game i cuts w.p. sigmoid(a_i + beta·z) with a_i re-centred so the marginal is exactly p_i.
 * beta>0 makes cutters move together (backtest correlation, via calibrateBeta). EV is computed by
 * quadrature (Σ payout·P(slip wins)) — far lower variance than summing heavy-tailed returns, and it
 * shows the honest −vig baseline rather than Monte-Carlo noise.
 */
export function simulateFamily(family: SlipFamily, pool: BinaryAxis[], opts: SimOptions = {}): SimResult {
  const trials = opts.trials ?? 2000
  const beta = opts.beta ?? 0
  const rng = mulberry32(opts.seed ?? 0x1234567)
  const N = pool.length
  const cutPs = pool.map(cutProb)
  const a = recentredIntercepts(cutPs, beta)
  const payouts = family.slips.map(s => s.payout)
  const stake = family.slips[0]?.stake ?? 0
  const cutters = new Uint8Array(N)

  // ── EV by quadrature: survival prob per game at each node, then Σ payout·P(slip survives) ──
  const { nodes, weights } = QUAD
  const surv: number[][] = a.map(ai => nodes.map(z => 1 - sigmoid(ai + beta * z)))
  let evReturn = 0
  for (let s = 0; s < family.legIndexSets.length; s++) {
    const legs = family.legIndexSets[s]
    let pWin = 0
    for (let j = 0; j < nodes.length; j++) {
      let prod = weights[j]
      for (let k = 0; k < legs.length; k++) prod *= surv[legs[k]][j]
      pWin += prod
    }
    evReturn += payouts[s] * pWin
  }

  // ── P(≥1 win) + cutter stats by Monte-Carlo (the joint, which quadrature can't give cheaply) ──
  let anyWin = 0, sumWinners = 0, sumC = 0, sumC2 = 0
  for (let t = 0; t < trials; t++) {
    const z = gaussian(rng)
    let c = 0
    for (let i = 0; i < N; i++) { const cut = rng() < sigmoid(a[i] + beta * z) ? 1 : 0; cutters[i] = cut; c += cut }
    sumC += c; sumC2 += c * c
    let winners = 0
    for (let s = 0; s < family.legIndexSets.length; s++) {
      const legs = family.legIndexSets[s]
      let won = 1
      for (let j = 0; j < legs.length; j++) if (cutters[legs[j]]) { won = 0; break }
      if (won) winners++
    }
    if (winners > 0) anyWin++
    sumWinners += winners
  }
  const meanC = sumC / trials
  return {
    pAnyWin: anyWin / trials,
    evReturn,
    net: evReturn - family.slips.length * stake,
    expWinners: sumWinners / trials,
    meanCutters: meanC,
    varCutters: sumC2 / trials - meanC * meanC,
  }
}

/** Find beta so the simulated cutter var/mean ratio matches `targetRatio` (backtest ≈ 1.7). */
export function calibrateBeta(pool: BinaryAxis[], targetRatio = 1.7, trials = 1500): number {
  const dummy: SlipFamily = { slips: [], legIndexSets: [], L: 0, distinctOmissions: 0 }
  const ratioAt = (beta: number) => {
    const r = simulateFamily(dummy, pool, { trials, beta, seed: 42 })
    return r.meanCutters > 0 ? r.varCutters / r.meanCutters : 1
  }
  let lo = 0, hi = 2.5
  if (ratioAt(hi) < targetRatio) return hi
  for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (ratioAt(mid) < targetRatio) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

// ── the planner: sweep L, report the frontier, pick the best ─────────────────────

export interface PlanCandidate {
  L: number
  medianPayout: number
  medianOdds: number
  pAnyWin: number
  evReturn: number
  net: number
  expWinners: number
  distinctOmissions: number
}

export interface CoveragePlan {
  best: PlanCandidate
  family: SlipFamily
  candidates: PlanCandidate[]
  poolSize: number
  K: number
  beta: number
  meanCutters: number
}

export interface PlanOptions {
  budget: number
  stake: number
  maxPayout: number
  boost?: BoostFn
  beta?: number             // correlation; if omitted, calibrated to the backtest ratio
  targetFloor?: number      // only consider plans whose median payout ≥ this (else max EV)
  trials?: number
  seed?: number
}

const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0 }

/**
 * Plan the best slip family for a budget. Sweeps leg-count L across the pool, builds + honestly
 * simulates each, and returns the frontier plus the recommended plan (highest P(≥1 win) among plans
 * that clear targetFloor; if none clear it, the highest-EV plan).
 */
export function planCoverage(pool: BinaryAxis[], opts: PlanOptions): CoveragePlan {
  const N = pool.length
  const K = Math.max(1, Math.floor(opts.budget / opts.stake))
  const boost = opts.boost ?? boostFor
  const beta = opts.beta ?? calibrateBeta(pool)
  const trials = opts.trials ?? 1500

  const candidates: PlanCandidate[] = []
  const families = new Map<number, SlipFamily>()
  // sweep L from short (safe, small payout) to long (risky, big payout); step keeps it fast on big N
  const Ls: number[] = []
  for (let L = 3; L <= N - 1; L += (N > 24 ? 2 : 1)) Ls.push(L)
  if (!Ls.includes(N - 1) && N - 1 >= 3) Ls.push(N - 1)

  let meanCutters = 0
  for (const L of Ls) {
    const family = buildDiverseUnderSlips(pool, { L, K, stake: opts.stake, maxPayout: opts.maxPayout, boost, seed: opts.seed ?? 7 })
    const sim = simulateFamily(family, pool, { trials, beta, seed: (opts.seed ?? 7) + L })
    meanCutters = sim.meanCutters
    families.set(L, family)
    candidates.push({
      L,
      medianPayout: median(family.slips.map(s => s.payout)),
      medianOdds: median(family.slips.map(s => s.combinedOdds)),
      pAnyWin: sim.pAnyWin,
      evReturn: sim.evReturn,
      net: sim.net,
      expWinners: sim.expWinners,
      distinctOmissions: family.distinctOmissions,
    })
  }

  const floor = opts.targetFloor ?? 0
  const clearing = candidates.filter(c => c.medianPayout >= floor)
  // Recommend: highest P(≥1 win) among plans meeting the payout floor; tie-break by higher net EV.
  const pick = (clearing.length ? clearing : candidates)
    .slice().sort((a, b) => (b.pAnyWin - a.pAnyWin) || (b.net - a.net))[0]

  return { best: pick, family: families.get(pick.L)!, candidates, poolSize: N, K, beta, meanCutters }
}

// ── build a ready-to-place coverage book at a chosen leg-count ────────────────────

export interface CoverageBookOptions {
  budget: number
  stake: number
  maxPayout: number
  boost?: BoostFn
  legPref?: number          // desired legs per slip (e.g. 33). If unset, derive from targetWin.
  targetWin?: number
  beta?: number
  trials?: number
  seed?: number
}

export interface CoverageBook {
  slips: PedlasSlip[]
  L: number
  K: number
  poolSize: number
  beta: number
  pAnyWin: number           // honest P(≥1 slip wins) under the correlated model
  expWinners: number
  meanCutters: number
  medianPayout: number
  medianOdds: number
  net: number
  note: string
}

/**
 * Build the actual 500-slip (K = budget/stake) coverage book at the requested leg-count, using the
 * WHOLE qualifying pool so slips scatter widely (each drops N−L risky games differently). Reports the
 * honest P(≥1 win) so the operator sees the real chance before placing — no guarantee is implied.
 */
export function buildCoverageBook(pool: BinaryAxis[], opts: CoverageBookOptions): CoverageBook {
  const N = pool.length
  const K = Math.max(1, Math.floor(opts.budget / opts.stake))
  const boost = opts.boost ?? boostFor
  const beta = opts.beta ?? calibrateBeta(pool)

  // pick L: explicit preference, else stack legs (median odds + REAL boost) until payout ≥ target —
  // exactly the book's own math: stake·odds^L·(1+boost(L)) ≥ targetWin.
  let L = opts.legPref ?? 0
  if (!L && opts.targetWin && opts.targetWin > opts.stake) {
    const medOdds = Math.max(1.05, median(pool.map(a => a.underOdds)))
    for (let l = 3; l <= 60; l++) {
      if (opts.stake * Math.pow(medOdds, l) * (1 + boost(l)) >= opts.targetWin) { L = l; break }
    }
    if (!L) L = 60
  }
  // need N > L so there is room to scatter (drop different games per slip)
  const wantedL = L || 12
  L = Math.max(3, Math.min(wantedL, N - 1))

  const family = buildDiverseUnderSlips(pool, { L, K, stake: opts.stake, maxPayout: opts.maxPayout, boost, seed: opts.seed ?? 7 })
  const sim = simulateFamily(family, pool, { beta, trials: opts.trials ?? 1500 })

  const note = wantedL > L
    ? `pool has only ${N} games — legs capped at ${L} (wanted ${wantedL}). More games ⇒ wider scatter ⇒ higher P(≥1 win).`
    : ''
  return {
    slips: family.slips, L, K, poolSize: N, beta,
    pAnyWin: sim.pAnyWin, expWinners: sim.expWinners, meanCutters: sim.meanCutters,
    medianPayout: median(family.slips.map(s => s.payout)),
    medianOdds: median(family.slips.map(s => s.combinedOdds)),
    net: sim.net, note,
  }
}
