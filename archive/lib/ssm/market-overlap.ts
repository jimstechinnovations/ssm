// lib/ssm/market-overlap.ts
// Generalises duplicate detection from EXACT duplicates (v3.2) to PARTIAL
// fingerprint overlap: two markets are redundant coverage if most of one's
// probability mass also resolves the other. Used to prune redundant legs so the
// optimizer never spends two slip-slots on the same scoreline region.

import type { FpMarket } from './fingerprint'
import { resolveMarket } from './fingerprint'
import type { ScorelineDist } from './scoreline-model'
import { pMarket } from './scoreline-model'

export interface OverlapResult {
  a: FpMarket
  b: FpMarket
  jointProb: number  // P(A ∧ B)
  pA: number
  pB: number
  sharedOfA: number  // P(A∧B)/P(A) — fraction of A's mass that also resolves B
  sharedOfB: number  // P(A∧B)/P(B)
  maxShared: number
  redundant: boolean // maxShared ≥ threshold
}

export function marketOverlap(
  dist: ScorelineDist,
  a: FpMarket,
  b: FpMarket,
  threshold = 0.7,
): OverlapResult {
  let joint = 0
  for (const e of dist) if (resolveMarket(a, e.s) && resolveMarket(b, e.s)) joint += e.p
  const pA = pMarket(dist, a)
  const pB = pMarket(dist, b)
  const sharedOfA = pA > 0 ? joint / pA : 0
  const sharedOfB = pB > 0 ? joint / pB : 0
  const maxShared = Math.max(sharedOfA, sharedOfB)
  return { a, b, jointProb: joint, pA, pB, sharedOfA, sharedOfB, maxShared, redundant: maxShared >= threshold }
}

export function overlapMatrix(dist: ScorelineDist, markets: FpMarket[], threshold = 0.7): OverlapResult[] {
  const out: OverlapResult[] = []
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      out.push(marketOverlap(dist, markets[i], markets[j], threshold))
    }
  }
  return out
}

export interface PruneResult {
  kept: FpMarket[]
  dropped: { market: FpMarket; coveredBy: FpMarket; shared: number }[]
}

/**
 * Greedy prune: keep markets by probability (broadest first); drop any market
 * whose mass is ≥ threshold contained in an already-kept market (it adds no new
 * coverage). Complements (overlap 0) and orthogonal axes (parity) always survive.
 */
export function pruneRedundant(dist: ScorelineDist, markets: FpMarket[], threshold = 0.7): PruneResult {
  const sorted = [...markets].sort((a, b) => pMarket(dist, b) - pMarket(dist, a))
  const kept: FpMarket[] = []
  const dropped: PruneResult['dropped'] = []
  for (const m of sorted) {
    let red: PruneResult['dropped'][number] | null = null
    for (const k of kept) {
      const o = marketOverlap(dist, m, k, threshold) // a=m, b=k → sharedOfA = m inside k
      if (o.sharedOfA >= threshold) { red = { market: m, coveredBy: k, shared: o.sharedOfA }; break }
    }
    if (red) dropped.push(red)
    else kept.push(m)
  }
  return { kept, dropped }
}
