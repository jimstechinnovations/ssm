// lib/pedlas/vectors.ts
// Enumerate the 2^L binary outcome vectors over the axis pool and attach per-vector
// odds, true probability, honest EV, and ranking features. Pure, no I/O.
//
// Every PEDLAS slip uses ALL L games (a binary string of length L), so the boost tier
// (= L) is constant across slips; only the Under/Over pattern (and thus odds/prob) varies.

import type { BinaryAxis, PedlasVector, VectorFeatures } from './types'
import { honestEvMultiple } from './boost'

/** Hard cap on full enumeration: 2^18 = 262,144 vectors. Larger pools need sampling (future work). */
export const MAX_ENUMERATE_LEGS = 18

export function combinedOddsOf(vector: (0 | 1)[], axes: BinaryAxis[]): number {
  let o = 1
  for (let i = 0; i < axes.length; i++) o *= vector[i] === 0 ? axes[i].underOdds : axes[i].overOdds
  return o
}

export function trueProbOf(vector: (0 | 1)[], axes: BinaryAxis[]): number {
  let p = 1
  for (let i = 0; i < axes.length; i++) p *= vector[i] === 0 ? axes[i].underProb : axes[i].overProb
  return p
}

export function overFlipsOf(vector: (0 | 1)[]): number {
  let f = 0
  for (const b of vector) f += b
  return f
}

// ── Pool-level constants (same for every vector of one pool) ─────────────────────
interface PoolStats {
  legCount: number
  avgMargin: number
  avgVolatility: number
  avgLineHeight: number
  distinctLeagues: number
  maxLeagueConcentration: number
  kickoffSpreadHours: number
}

export function poolStats(axes: BinaryAxis[]): PoolStats {
  const L = axes.length
  const byLeague = new Map<number, number>()
  let mSum = 0, vSum = 0, lineSum = 0
  let minKick = Infinity, maxKick = -Infinity
  for (const a of axes) {
    mSum += a.margin
    vSum += a.volatility
    lineSum += a.line
    byLeague.set(a.leagueId, (byLeague.get(a.leagueId) ?? 0) + 1)
    const t = Date.parse(a.kickoff)
    if (!Number.isNaN(t)) { if (t < minKick) minKick = t; if (t > maxKick) maxKick = t }
  }
  const maxLeague = byLeague.size ? Math.max(...byLeague.values()) : 0
  const spreadH = (minKick === Infinity || maxKick === -Infinity) ? 0 : (maxKick - minKick) / 3_600_000
  return {
    legCount: L,
    avgMargin: L ? mSum / L : 0,
    avgVolatility: L ? vSum / L : 0,
    avgLineHeight: L ? lineSum / L : 0,
    distinctLeagues: byLeague.size,
    maxLeagueConcentration: L ? maxLeague / L : 0,
    kickoffSpreadHours: spreadH,
  }
}

function featuresOf(
  vector: (0 | 1)[],
  axes: BinaryAxis[],
  combinedOdds: number,
  trueProb: number,
  evMultiple: number,
  pool: PoolStats,
): VectorFeatures {
  let flips = 0, fVol = 0, fOdds = 0
  const fLeagues = new Set<number>()
  for (let i = 0; i < axes.length; i++) {
    if (vector[i] === 1) {
      flips++
      fVol += axes[i].volatility
      fOdds += axes[i].overOdds
      fLeagues.add(axes[i].leagueId)
    }
  }
  return {
    overFlips: flips,
    combinedOdds,
    trueProb,
    evMultiple,
    flippedAvgVolatility: flips ? fVol / flips : 0,
    flippedAvgOverOdds: flips ? fOdds / flips : 0,
    flippedLeagues: fLeagues.size,
    legCount: pool.legCount,
    avgMargin: pool.avgMargin,
    avgVolatility: pool.avgVolatility,
    avgLineHeight: pool.avgLineHeight,
    distinctLeagues: pool.distinctLeagues,
    maxLeagueConcentration: pool.maxLeagueConcentration,
    kickoffSpreadHours: pool.kickoffSpreadHours,
  }
}

/** Build the full PedlasVector for a single bit pattern. */
export function makeVector(vector: (0 | 1)[], axes: BinaryAxis[], pool = poolStats(axes)): PedlasVector {
  const combinedOdds = combinedOddsOf(vector, axes)
  const trueProb = trueProbOf(vector, axes)
  const evMultiple = honestEvMultiple(trueProb, combinedOdds, axes.length)
  return {
    vector,
    combinedOdds,
    trueProb,
    evMultiple,
    overFlips: overFlipsOf(vector),
    features: featuresOf(vector, axes, combinedOdds, trueProb, evMultiple, pool),
  }
}

/** Enumerate all 2^L vectors (L ≤ MAX_ENUMERATE_LEGS). */
export function enumerateVectors(axes: BinaryAxis[]): PedlasVector[] {
  const L = axes.length
  if (L === 0) return []
  if (L > MAX_ENUMERATE_LEGS) {
    throw new Error(`enumerateVectors: ${L} legs exceeds the enumeration cap (2^${MAX_ENUMERATE_LEGS}); sample instead`)
  }
  const pool = poolStats(axes)
  const out: PedlasVector[] = []
  for (let mask = 0; mask < (1 << L); mask++) {
    const vector: (0 | 1)[] = new Array(L)
    for (let i = 0; i < L; i++) vector[i] = ((mask >> i) & 1) as 0 | 1
    out.push(makeVector(vector, axes, pool))
  }
  return out
}
