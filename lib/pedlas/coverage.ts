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

/** How likely this leg is to finish Over 4.5 = book P(Over), nudged by the history advisory lean. */
function overLikelihood(a: BinaryAxis): number {
  let p = cutProb(a)
  const lean = a.advisory?.lean
  if (lean === 'fade') p = Math.min(0.95, p * 1.15)        // history leans Over → flip it more
  else if (lean === 'back') p = Math.max(0.02, p * 0.90)   // history backs Under → flip it less
  return p
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

/**
 * The K MOST-PROBABLE flip sets (which legs to turn Over), most-likely first, including the empty set
 * (all-Under). Flipping leg i costs logPen[i] = log P(Over_i) − log P(Under_i) ≤ 0, so the highest-
 * probability vectors flip only the least-confident legs. This is best-first over subsets (Lawler/
 * Eppstein k-best): it AUTOMATICALLY covers the most-uncertain games exhaustively (e.g. 8 coin-flips →
 * their 256 patterns) while committing the confident games to Under. Optimal for P(≥1 exact match).
 */
function topKFlipSets(logPen: number[], K: number): number[][] {
  const n = logPen.length
  const order = logPen.map((_, i) => i).sort((a, b) => logPen[b] - logPen[a]) // least-negative (least confident) first
  const d = order.map(i => logPen[i])
  const results: number[][] = [[]] // empty set = all Under (the single most-probable vector)
  if (n === 0) return results

  interface Node { score: number; subset: number[]; last: number }
  const heap: Node[] = [{ score: d[0], subset: [0], last: 0 }]
  const up = () => { let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].score >= heap[i].score) break;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
  const pop = () => {
    const top = heap[0]; const last = heap.pop()!
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = 2 * i + 2; let m = i; if (l < heap.length && heap[l].score > heap[m].score) m = l; if (r < heap.length && heap[r].score > heap[m].score) m = r; if (m === i) break;[heap[m], heap[i]] = [heap[i], heap[m]]; i = m } }
    return top
  }
  while (results.length < K && heap.length) {
    const node = pop()
    results.push(node.subset.map(j => order[j])) // d-index → original leg index
    const nx = node.last + 1
    if (nx < n) {
      heap.push({ score: node.score + d[nx], subset: [...node.subset, nx], last: nx }); up()                      // add nx
      heap.push({ score: node.score - d[node.last] + d[nx], subset: [...node.subset.slice(0, -1), nx], last: nx }); up() // swap last→nx
    }
  }
  return results
}

export interface FlipScatter {
  slips: PedlasSlip[]
  vectors: (0 | 1)[][]
  base: BinaryAxis[]         // the N base legs, kickoff-sorted
  N: number
  reachedTarget: boolean
}

/**
 * Build the K flip-variant slips. base = the N legs (kickoff-sorted). Flips are drawn from the
 * `flipTop` legs most likely to go Over, in increasing flip-count, "similar to previous going forward".
 */
export function buildFlipScatter(axes: BinaryAxis[], opts: { target: number; stake: number; K: number; maxPayout: number; boost?: BoostFn; flipTop?: number }): FlipScatter {
  const boost = opts.boost ?? boostFor
  const { legs, reached } = chooseBaseLegs(axes, opts.stake, opts.target, boost)
  const base = [...legs].sort((a, b) => a.kickoff.localeCompare(b.kickoff)) // scatter order = kickoff
  const N = base.length

  // Choose the K most-probable outcome vectors: flip only the least-confident legs (penalty =
  // P(Over)/P(Under)). This exhaustively covers the most-uncertain games and commits the rest to Under.
  const logPen = base.map(a => { const o = overLikelihood(a); return Math.log(Math.max(1e-6, o)) - Math.log(Math.max(1e-6, 1 - o)) })
  const flipSets = topKFlipSets(logPen, opts.K)
  const zero = () => new Array(N).fill(0) as (0 | 1)[]
  const vectors: (0 | 1)[][] = flipSets.map(set => { const v = zero(); for (const i of set) v[i] = 1; return v })

  const slips: PedlasSlip[] = vectors.slice(0, opts.K).map((v, k) => {
    const slipLegs = base.map((ax, i) => legFromAxis(ax, v[i] === 1 ? 'Over' : 'Under'))
    const skeleton: PedlasSlip = {
      slipId: k + 1, vector: v, legs: slipLegs, legCount: N, combinedOdds: 0, trueProb: 0,
      boostPct: 0, stake: opts.stake, payout: 0, uncappedPayout: 0, capped: false, evMultiple: 0, rankScore: 0,
    }
    return recomputeSlip(skeleton, base, opts.stake, opts.maxPayout, boost)
  })
  return { slips, vectors: vectors.slice(0, opts.K), base, N, reachedTarget: reached }
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
  const N0 = pool.length
  const K = Math.max(1, Math.floor(opts.budget / opts.stake))
  const boost = opts.boost ?? boostFor
  const beta = opts.beta ?? calibrateBeta(pool)
  const target = opts.targetWin ?? opts.stake * 1000

  // Flip-scatter: base = N legs whose Under parlay × boost ≥ target; variants flip likely-Over legs.
  const scatter = buildFlipScatter(pool, { target, stake: opts.stake, K, maxPayout: opts.maxPayout, boost })
  const pAnyWin = simulateFlipScatter(scatter, { beta, trials: opts.trials ?? 3000 })

  const distinct = new Set(scatter.vectors.map(v => v.join(''))).size
  const note = !scatter.reachedTarget
    ? `only ${N0} qualifying games — base parlay reaches ~₦${Math.round(opts.stake * scatter.slips[0].combinedOdds * (1 + boost(scatter.N))).toLocaleString()}, short of the ₦${target.toLocaleString()} target. Add days / games.`
    : distinct < K ? `pool of ${N0} games yields ${distinct} distinct variants < ${K} slips — add games for a fuller scatter.` : ''
  return {
    slips: scatter.slips, L: scatter.N, K, poolSize: N0, beta,
    pAnyWin, expWinners: pAnyWin, meanCutters: scatter.base.reduce((s, a) => s + cutProb(a), 0),
    medianPayout: median(scatter.slips.map(s => s.payout)),
    medianOdds: median(scatter.slips.map(s => s.combinedOdds)),
    net: 0, note,
  }
}
