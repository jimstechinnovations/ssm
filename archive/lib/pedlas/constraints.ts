// lib/pedlas/constraints.ts
// PEDLA structural filters D, A. Pure, no I/O.
//
//   A — Anchor distance:  per-vector min (and optional max) Over-flips. This is the
//                         primary "hit big" lever — it pushes every slip away from the
//                         low-payout all-Under anchor and into the high-odds region.
//   D — Diversity:        max legs from one competition. Because every slip uses ALL L
//                         games, D is enforced at the POOL level (capPoolByLeague): cap
//                         the pool per league and every slip inherits the cap.
//
// E (max identical run) and S (slip separation) were removed — pedla_v1.md §2: independent
// legs at p≈0.83 make long same-side runs the NORM, and both filters pruned exactly the
// highest-probability vectors.

import type { BinaryAxis, PedlasVector } from './types'

/** A — keep vectors whose Over-flips ∈ [minFlips, maxFlips]. */
export function applyAnchorDistance(
  vectors: PedlasVector[],
  minFlips: number,
  maxFlips?: number,
): PedlasVector[] {
  const hi = maxFlips ?? Infinity
  return vectors.filter(v => v.overFlips >= minFlips && v.overFlips <= hi)
}

/**
 * D — cap the pool to at most `maxPerLeague` axes per competition, keeping the
 * cleanest-priced (lowest-margin) axes in each league. Returns the trimmed pool.
 */
export function capPoolByLeague(axes: BinaryAxis[], maxPerLeague: number): BinaryAxis[] {
  if (maxPerLeague <= 0) return axes
  const byLeague = new Map<number, BinaryAxis[]>()
  for (const a of axes) {
    const arr = byLeague.get(a.leagueId)
    if (arr) arr.push(a)
    else byLeague.set(a.leagueId, [a])
  }
  const kept: BinaryAxis[] = []
  for (const arr of byLeague.values()) {
    arr.sort((x, y) => x.margin - y.margin) // cleanest pricing first
    for (const a of arr.slice(0, maxPerLeague)) kept.push(a)
  }
  return kept
}
