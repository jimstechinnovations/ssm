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

// ── placement-time estimate → selection window ──────────────────────────────────
// Measured ~20s per slip: the SUBMIT is serialized (SportyBet rejects concurrent submits on one
// account), so extra workers don't cut it much. The selection window must exceed the whole run so no
// game kicks off mid-placement — window = run + a fixed safety BUFFER (not a big multiplier, which
// over-provisions long runs). Tune these two constants as placement speed changes.
export const PLACE_SECONDS_PER_SLIP = 20
export const WINDOW_BUFFER_MINUTES = 75   // ~1h15m headroom on top of the run (500 slips ⇒ ~4h window)

export function estimatePlacement(slipCount: number, secPerSlip = PLACE_SECONDS_PER_SLIP, bufferMinutes = WINDOW_BUFFER_MINUTES): { runMinutes: number; windowMinutes: number; secPerSlip: number; bufferMinutes: number } {
  const runMinutes = Math.ceil((slipCount * secPerSlip) / 60)
  const windowMinutes = Math.max(60, runMinutes + bufferMinutes)
  return { runMinutes, windowMinutes, secPerSlip, bufferMinutes }
}

// ── FLIP-SCATTER: the real PEDLA model (base all-Under, variants flip legs to Over) ──────
//
// N legs are chosen so the base Under parlay × boost ≥ target (each slip keeps all N legs → full
// boosted payout). Slip 1 is the base (all Under, kickoff-sorted). Slips 2..K flip legs Under→Over,
// preferring the legs most likely to ACTUALLY go Over (book P(Over) nudged by team history), in
// increasing flip-count. A slip wins iff its U/O vector exactly matches the real results — a moonshot
// by nature (probability is low, honestly reported), but every winning slip pays the full target.

/** How likely this leg is to finish Over 4.5, for flip ordering. When enrichSignals ran, advisory.pHat
 *  is the combined book×form×H2H P(Over) — use it directly so the least-safe games flip first. No
 *  advisory (form missing) → book price only. */
function overLikelihood(a: BinaryAxis): number {
  const combined = a.advisory?.pHat
  if (combined != null) return Math.min(0.95, Math.max(0.02, combined))
  return cutProb(a)
}

/** Fewest legs (highest Under odds first) whose base parlay × boost clears the target. */
function chooseBaseLegs(axes: BinaryAxis[], stake: number, target: number, boost: BoostFn): { legs: BinaryAxis[]; reached: boolean } {
  const byOdds = [...axes].sort((a, b) => b.underOdds - a.underOdds)
  const legs: BinaryAxis[] = []
  let prod = 1
  for (const a of byOdds) {
    legs.push(a); prod *= a.underOdds
    if (stake * prod * (1 + boost(legs.length)) >= target) return { legs, reached: true }
  }
  return { legs, reached: false } // used every available game and still short of target
}

/** n-choose-k (exact for the small n,k we use). */
function nCk(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  k = Math.min(k, n - k)
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return Math.round(r)
}

/** All k-subsets of `items` (each a subset of the item VALUES), lexicographic order; optional cap. */
function kSubsets(items: number[], k: number, cap = Infinity): number[][] {
  const out: number[][] = []
  const n = items.length
  if (k < 0 || k > n) return out
  if (k === 0) return [[]]
  const idx = Array.from({ length: k }, (_, i) => i)
  for (;;) {
    out.push(idx.map(i => items[i]))
    if (out.length >= cap) break
    let p = k - 1
    while (p >= 0 && idx[p] === n - k + p) p--
    if (p < 0) break
    idx[p]++
    for (let j = p + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
  return out
}

/** The `count` most-probable d-subsets of E (E ordered most-likely-Over first), ranked by Σ logit(P Over).
 *  Bounded: only combines the top (d + pad) most-likely games and caps the candidate pool, so it stays
 *  cheap even for deep d where C(|E|,d) is astronomical. */
function topSubsetsAtDepth(E: number[], d: number, count: number, logitOf: (i: number) => number): number[][] {
  if (count <= 0 || d <= 0 || d > E.length) return []
  const T = Math.min(E.length, d + 14)
  const pool = E.slice(0, T)                                        // top-T most-likely-Over games
  const cand = kSubsets(pool, d, Math.min(nCk(T, d), Math.max(count * 20, 500)))
  cand.sort((a, b) => b.reduce((s, i) => s + logitOf(i), 0) - a.reduce((s, i) => s + logitOf(i), 0))
  return cand.slice(0, count)
}

export interface FlipScatter {
  slips: PedlasSlip[]
  vectors: (0 | 1)[][]
  base: BinaryAxis[]         // the N base legs, kickoff-sorted
  N: number
  reachedTarget: boolean
  // ── covering-design guarantee ──
  eligible: number[]         // base indices in the flip-eligible set E (signal ≥ threshold), most-likely first
  completeDepth: number      // survives ANY ≤ this many simultaneous Overs among E (fully-covered layers)
  partialDepth: number       // the next layer, only partially covered (0 = none)
  partialCovered: number     // how many of that partial layer's C(|E|,d) patterns are covered
  lockedCount: number        // N − |E| games locked Under in EVERY slip
  threshold: number
  maxFlipReached: number     // deepest flip-count present in any slip (how many legs the deepest slip turns Over)
}

/**
 * Build the K slips as a LAYERED COVERING DESIGN over a signal-pruned eligible set (pedlas_v3 §cover).
 *
 * The base is N legs whose all-Under parlay × boost ≥ target. The signal (book × form × H2H, via
 * overLikelihood) splits them:
 *   • E = flip-eligible games with P(Over) ≥ threshold — the games that can realistically swing.
 *   • the rest are LOCKED to Under in every slip (the signal says they're near-certain; we don't
 *     spend coverage on them, which is what lets the budget buy real depth).
 *
 * We then emit slips layer by layer — all 0-flip (base), all 1-flip over E, all 2-flip, … — completing
 * each layer while the budget lasts. Completing layers 0..m gives a hard guarantee: if AT MOST m of the
 * eligible games go Over (and the locked games all stay Under), exactly one slip matches every result.
 * The first layer that doesn't fit is filled with its most-probable patterns first (Σ logit(P Over)).
 *
 * Honest limits: still −vig, no edge (pedlas-no-model-edge). The guarantee is CONDITIONAL on the locked
 * games holding Under; a single locked upset kills every slip. The signal only earns the right to lock.
 */
export function buildFlipScatter(axes: BinaryAxis[], opts: { target: number; stake: number; K: number; maxPayout: number; boost?: BoostFn; overThreshold?: number; maxFlipFrac?: number; maxRun?: number }): FlipScatter {
  const boost = opts.boost ?? boostFor
  const K = opts.K
  const threshold = opts.overThreshold ?? 0.12
  const { legs, reached } = chooseBaseLegs(axes, opts.stake, opts.target, boost)
  const base = [...legs].sort((a, b) => a.kickoff.localeCompare(b.kickoff)) // kickoff order (index i = i-th to kick off)
  const N = base.length

  // Eligible set E: games the signal gives a real Over chance (≥ threshold), most-likely first. If E is
  // so small its full 2^|E| coverage wouldn't even fill the budget, extend down the ranking so we do.
  const rankedByOver = base.map((_, i) => i).sort((a, b) => overLikelihood(base[b]) - overLikelihood(base[a]))
  let E = rankedByOver.filter(i => overLikelihood(base[i]) >= threshold)
  if (E.length < 1) E = rankedByOver.slice(0, Math.min(3, N))   // degenerate pool: cover the top few
  const logitOf = (i: number) => { const o = Math.min(0.98, Math.max(0.02, overLikelihood(base[i]))); return Math.log(o / (1 - o)) }

  const zero = () => new Array(N).fill(0) as (0 | 1)[]
  const vectors: (0 | 1)[][] = []
  const seen = new Set<string>()
  const pushFlips = (flips: number[]): boolean => {
    if (vectors.length >= K) return false
    const v = zero(); for (const i of flips) v[i] = 1
    const key = v.join(''); if (seen.has(key)) return false
    seen.add(key); vectors.push(v); return true
  }

  pushFlips([])                                    // layer 0: base (all Under)
  let completeDepth = 0, partialDepth = 0, partialCovered = 0

  if (opts.maxFlipFrac && opts.maxFlipFrac > 0) {
    // CONSTRAINED SCATTER: spread slips across flip-counts 0..maxFlip (≤ maxFlipFrac of the legs), but
    // only over REALISTIC patterns — no more than maxFlipFrac Overs, and no run of ≥ maxRun consecutive
    // Overs (kickoff order), so Overs stay scattered through the day. Slots per depth ∝ P(#Overs = d);
    // most-probable combos first (signal). Trades hit-chance for reach vs. the layered default.
    const maxFlip = Math.max(2, Math.min(E.length, Math.floor(opts.maxFlipFrac * N)))
    const maxRun = opts.maxRun ?? 3
    const runOK = (flips: number[]): boolean => {   // no maxRun consecutive kickoff positions all Over
      if (!maxRun || maxRun <= 0) return true
      const s = [...flips].sort((a, b) => a - b)
      let run = 1
      for (let i = 1; i < s.length; i++) { if (s[i] === s[i - 1] + 1) { if (++run >= maxRun) return false } else run = 1 }
      return true
    }
    // Poisson-binomial pmf of #Overs among E (independence approx — used only to weight the allocation).
    let pmf = [1]
    for (const i of E) { const o = Math.min(0.98, Math.max(0.02, overLikelihood(base[i]))); const nx = new Array(pmf.length + 1).fill(0); for (let d = 0; d < pmf.length; d++) { nx[d] += pmf[d] * (1 - o); nx[d + 1] += pmf[d] * o } pmf = nx }
    const w = (d: number) => pmf[d] ?? 0
    const wsum = Array.from({ length: maxFlip }, (_, k) => w(k + 1)).reduce((s, x) => s + x, 0) || 1
    const slots = new Array(maxFlip + 1).fill(0)
    for (let d = 1; d <= maxFlip; d++) slots[d] = Math.min(nCk(E.length, d), Math.max(1, Math.round((K - 1) * w(d) / wsum)))
    const budget = K - 1
    let tot = slots.reduce((s, x) => s + x, 0)
    while (tot > budget) { let dm = -1; for (let d = maxFlip; d >= 1; d--) if (slots[d] > 1 && (dm < 0 || w(d) < w(dm))) dm = d; if (dm < 0) { for (let d = maxFlip; d >= 1 && tot > budget; d--) while (slots[d] > 0 && tot > budget) { slots[d]--; tot-- } break } slots[dm]--; tot-- }
    while (tot < budget) { let dx = -1; for (let d = 1; d <= maxFlip; d++) if (slots[d] < nCk(E.length, d) && (dx < 0 || w(d) > w(dx))) dx = d; if (dx < 0) break; slots[dx]++; tot++ }
    for (let d = 1; d <= maxFlip; d++) {
      let got = 0
      for (const s of topSubsetsAtDepth(E, d, slots[d] * 3 + 30, logitOf)) { if (vectors.length >= K || got >= slots[d]) break; if (!runOK(s)) continue; if (pushFlips(s)) got++ }
    }
    // top up to K with the next-most-probable VALID patterns (best-first across depths)
    for (let d = 1; d <= maxFlip && vectors.length < K; d++) for (const s of topSubsetsAtDepth(E, d, K, logitOf)) { if (vectors.length >= K) break; if (runOK(s)) pushFlips(s) }
    partialDepth = maxFlip; partialCovered = vectors.length - 1
  } else {
    // LAYERED covering design (default): complete flip-layers 0,1,2,… while the budget lasts.
    for (let k = 1; k <= E.length; k++) {
      if (vectors.length >= K) break
      const remaining = K - vectors.length
      const total = nCk(E.length, k)
      if (total <= remaining) {
        for (const s of kSubsets(E, k)) pushFlips(s)  // COMPLETE this layer (order irrelevant to coverage)
        completeDepth = k
      } else {
        // PARTIAL layer: the most-probable k-Over patterns first (Σ logit). Exact-sort when the layer is
        // small; otherwise take lexicographic-first over the likelihood-sorted E (already most-likely).
        const subs = total <= 20000 ? kSubsets(E, k) : kSubsets(E, k, remaining)
        if (total <= 20000) subs.sort((a, b) => b.reduce((s, i) => s + logitOf(i), 0) - a.reduce((s, i) => s + logitOf(i), 0))
        for (const s of subs) { if (vectors.length >= K) break; if (pushFlips(s)) partialCovered++ }
        partialDepth = k
        break
      }
    }
  }
  const maxFlipReached = vectors.reduce((m, v) => Math.max(m, v.reduce((a: number, b) => a + b, 0)), 0)

  const slips: PedlasSlip[] = vectors.slice(0, K).map((v, k) => {
    const slipLegs = base.map((ax, i) => legFromAxis(ax, v[i] === 1 ? 'Over' : 'Under'))
    const skeleton: PedlasSlip = {
      slipId: k + 1, vector: v, legs: slipLegs, legCount: N, combinedOdds: 0, trueProb: 0,
      boostPct: 0, stake: opts.stake, payout: 0, uncappedPayout: 0, capped: false, evMultiple: 0, rankScore: 0,
    }
    return recomputeSlip(skeleton, base, opts.stake, opts.maxPayout, boost)
  })
  return {
    slips, vectors: vectors.slice(0, K), base, N, reachedTarget: reached,
    eligible: E, completeDepth, partialDepth, partialCovered, lockedCount: N - E.length, threshold, maxFlipReached,
  }
}

/**
 * REALIZER (optimum-plan §10) — a correlated SIMULATION engine that builds the slips.
 *
 * It plays the whole day `trials` times under the common-shock model: each game i resolves Over w.p.
 * `sigmoid(a_i + β·z)` (marginal = the book-only de-vigged P(Over), games moving together via z), keeps
 * only the REALISTIC paths (≤ P·N Overs and no run of ≥ E consecutive-by-kickoff Overs), tallies how
 * often each exact vector occurs, and shapes the K slips from the **most-frequent realistic paths**
 * (ties broken by Σ logit — the more-probable pattern). That IS "cover the K most-probable realistic
 * vectors under the true correlated law" (§2 Change B), built the way it's intuited: survivors down
 * each branch ∝ that branch's simulated frequency, so the survival curve is the model's own and no
 * single game concentrates a cliff. Ranking uses the BOOK price only (§2 Change A). Same honest
 * ceiling — it shapes the curve and covers optimally; it does not beat the funnel or create EV.
 */
export function buildRealizer(axes: BinaryAxis[], opts: { target: number; stake: number; K: number; maxPayout: number; boost?: BoostFn; maxFlipFrac?: number; maxRun?: number; beta?: number; trials?: number; seed?: number }): FlipScatter {
  const boost = opts.boost ?? boostFor
  const K = opts.K
  const { legs, reached } = chooseBaseLegs(axes, opts.stake, opts.target, boost)
  const base = [...legs].sort((a, b) => a.kickoff.localeCompare(b.kickoff)) // kickoff order
  const N = base.length
  const P = opts.maxFlipFrac ?? 0.5
  const E = opts.maxRun ?? 3
  const maxOvers = Math.max(1, Math.floor(P * N))
  const overP = base.map(a => Math.min(0.98, Math.max(0.02, a.overProb)))   // BOOK-only marginals (Change A)
  const beta = opts.beta ?? calibrateBeta(base)
  const aI = recentredIntercepts(overP, beta)
  const logitOf = (i: number) => Math.log(overP[i] / (1 - overP[i]))
  const trials = opts.trials ?? 40000
  const rng = mulberry32(opts.seed ?? 0xC0FFEE)

  // Simulate the correlated day; tally realistic exact vectors (layers enforced during the walk).
  const freq = new Map<string, { count: number; flips: number[] }>()
  const bits = new Array<0 | 1>(N).fill(0)
  for (let t = 0; t < trials; t++) {
    const z = gaussian(rng)
    let overs = 0, run = 0, ok = true
    const flips: number[] = []
    for (let i = 0; i < N; i++) {
      const over = rng() < sigmoid(aI[i] + beta * z)
      bits[i] = over ? 1 : 0
      if (over) { overs++; flips.push(i); run++; if (run >= E || overs > maxOvers) { ok = false; break } }
      else run = 0
    }
    if (!ok) continue                                   // an unrealistic day (pruned by the layers)
    const key = bits.join('')
    const e = freq.get(key)
    if (e) e.count++; else freq.set(key, { count: 1, flips: flips.slice() })
  }
  // Shape the slips: most-frequent realistic paths first; ties → higher Σ logit (more-probable pattern).
  const ranked = [...freq.values()].sort((x, y) => (y.count - x.count) || (y.flips.reduce((s, i) => s + logitOf(i), 0) - x.flips.reduce((s, i) => s + logitOf(i), 0)))
  const chosen: number[][] = []
  const seen = new Set<string>()
  const add = (flips: number[]) => { const k = flips.slice().sort((a, b) => a - b).join(','); if (!seen.has(k) && chosen.length < K) { seen.add(k); chosen.push(flips) } }
  add([])                                               // the all-Under base (the most-probable day)
  for (const r of ranked) { if (chosen.length >= K) break; add(r.flips) }

  const eligibleSet = new Set<number>(); for (const f of chosen) for (const i of f) eligibleSet.add(i)
  const maxFlipReached = chosen.reduce((m, f) => Math.max(m, f.length), 0)
  const slips: PedlasSlip[] = chosen.map((flips, k) => {
    const v = new Array(N).fill(0) as (0 | 1)[]; for (const i of flips) v[i] = 1
    const slipLegs = base.map((ax, i) => legFromAxis(ax, v[i] === 1 ? 'Over' : 'Under'))
    const skeleton: PedlasSlip = {
      slipId: k + 1, vector: v, legs: slipLegs, legCount: N, combinedOdds: 0, trueProb: 0,
      boostPct: 0, stake: opts.stake, payout: 0, uncappedPayout: 0, capped: false, evMultiple: 0, rankScore: 0,
    }
    return recomputeSlip(skeleton, base, opts.stake, opts.maxPayout, boost)
  })
  const vectors = slips.map(s => s.vector as (0 | 1)[])
  return {
    slips, vectors, base, N, reachedTarget: reached,
    eligible: [...eligibleSet], completeDepth: 0, partialDepth: maxFlipReached, partialCovered: chosen.length - 1,
    lockedCount: N - eligibleSet.size, threshold: 0, maxFlipReached,
  }
}

/** P(≥1 flip-slip wins) = P(the real U/O outcome exactly matches one of our vectors), correlated. */
export function simulateFlipScatter(scatter: FlipScatter, opts: { trials?: number; beta?: number; seed?: number } = {}): number {
  const trials = opts.trials ?? 3000
  const beta = opts.beta ?? 0
  const rng = mulberry32(opts.seed ?? 0xBEEF)
  const N = scatter.N
  const a = recentredIntercepts(scatter.base.map(cutProb), beta)
  const keys = new Set(scatter.vectors.map(v => v.join('')))
  const outcome = new Array<number>(N)
  let hit = 0
  for (let t = 0; t < trials; t++) {
    const z = gaussian(rng)
    for (let i = 0; i < N; i++) outcome[i] = rng() < sigmoid(a[i] + beta * z) ? 1 : 0
    if (keys.has(outcome.join(''))) hit++
  }
  return hit / trials
}

// ── build a ready-to-place coverage book at a chosen leg-count ────────────────────

export interface CoverageBookOptions {
  budget: number
  stake: number
  maxPayout: number
  boost?: BoostFn
  legPref?: number          // desired legs per slip (e.g. 33). If unset, derive from targetWin.
  targetWin?: number
  overThreshold?: number    // flip-eligible if P(Over) ≥ this (default 0.12 — the "balanced" gate)
  maxFlipFrac?: number      // if set, SCATTER flips across depths up to this fraction of eligible legs
  maxRun?: number           // in scatter mode: reject slips with ≥ this many consecutive Overs (default 3)
  realizer?: boolean        // use the correlated SIMULATION engine (optimum-plan §10) instead of scatter
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
  // ── covering-design guarantee (see buildFlipScatter) ──
  eligibleCount: number     // |E| — flip-eligible games
  completeDepth: number     // survives ANY ≤ this many Overs among E
  partialDepth: number      // next layer, partially covered
  partialCovered: number    // patterns covered in that partial layer
  lockedCount: number       // games locked Under in every slip
}

/**
 * Build the actual 500-slip (K = budget/stake) coverage book at the requested leg-count, using the
 * WHOLE qualifying pool so slips scatter widely (each drops N−L risky games differently). Reports the
 * honest P(≥1 win) so the operator sees the real chance before placing — no guarantee is implied.
 */
export function buildCoverageBook(pool: BinaryAxis[], opts: CoverageBookOptions): CoverageBook {
  const N0 = pool.length
  const K = Math.max(1, Math.floor(opts.budget / opts.stake))
  const boost = opts.boost ?? boostFor
  const beta = opts.beta ?? calibrateBeta(pool)
  const target = opts.targetWin ?? opts.stake * 1000

  // Layered covering design: base = N legs whose Under parlay × boost ≥ target; the signal picks the
  // flip-eligible set E and we cover its flip-layers as deep as the budget allows.
  // DEFAULT = the realizer (optimum-plan §10): the shipping "moonshot at its best coverage". The scatter
  // and layered paths are legacy, reached only by explicitly passing realizer:false.
  const useRealizer = opts.realizer !== false
  const scatter = useRealizer
    ? buildRealizer(pool, { target, stake: opts.stake, K, maxPayout: opts.maxPayout, boost, maxFlipFrac: opts.maxFlipFrac, maxRun: opts.maxRun, beta })
    : buildFlipScatter(pool, { target, stake: opts.stake, K, maxPayout: opts.maxPayout, boost, overThreshold: opts.overThreshold, maxFlipFrac: opts.maxFlipFrac, maxRun: opts.maxRun })
  const pAnyWin = simulateFlipScatter(scatter, { beta, trials: opts.trials ?? 3000 })

  const distinct = new Set(scatter.vectors.map(v => v.join(''))).size
  const guarantee = useRealizer
    ? `realizer: ${distinct} most-frequent realistic paths (flips 0..${scatter.maxFlipReached}, ≤${Math.round((opts.maxFlipFrac ?? 0.5) * 100)}% Over, no ${opts.maxRun ?? 3}-run) from a correlated simulation.`
    : opts.maxFlipFrac
    ? `scatters flips 0..${scatter.maxFlipReached} of ${scatter.eligible.length} eligible legs across ${distinct} slips (fully covers ≤${scatter.completeDepth} Overs); ${scatter.lockedCount} locked.`
    : `covers ANY ≤${scatter.completeDepth} of ${scatter.eligible.length} flip-eligible games going Over` +
      (scatter.partialDepth ? ` (+${scatter.partialCovered} of the ${scatter.partialDepth}-Over patterns)` : '') +
      `; ${scatter.lockedCount} games locked Under.`
  const note = !scatter.reachedTarget
    ? `only ${N0} qualifying games — base parlay reaches ~₦${Math.round(opts.stake * scatter.slips[0].combinedOdds * (1 + boost(scatter.N))).toLocaleString()}, short of the ₦${target.toLocaleString()} target. Add days / games.`
    : (distinct < K ? `pool of ${N0} games yields ${distinct} distinct variants < ${K} slips — add games for a fuller scatter. ` : '') + guarantee
  return {
    slips: scatter.slips, L: scatter.N, K, poolSize: N0, beta,
    pAnyWin, expWinners: pAnyWin, meanCutters: scatter.base.reduce((s, a) => s + cutProb(a), 0),
    medianPayout: median(scatter.slips.map(s => s.payout)),
    medianOdds: median(scatter.slips.map(s => s.combinedOdds)),
    net: 0, note,
    eligibleCount: scatter.eligible.length, completeDepth: scatter.completeDepth,
    partialDepth: scatter.partialDepth, partialCovered: scatter.partialCovered, lockedCount: scatter.lockedCount,
  }
}
