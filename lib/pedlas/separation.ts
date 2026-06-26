// lib/pedlas/separation.ts
// S — Slip separation. Given vectors already in PREFERENCE order (highest-ranked
// first), greedily keep a vector only if it differs from every already-kept slip by
// at least `minSeparation` legs (Hamming distance). This guarantees the K placed
// slips cover K genuinely different outcome regions — so one upset kills a subset of
// slips, not all of them. Pure, no I/O.

/** Number of positions at which two equal-length vectors differ. */
export function hammingDistance(a: (0 | 1)[], b: (0 | 1)[]): number {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++
  return d + Math.abs(a.length - b.length)
}

/**
 * Greedy separation. Walks `ranked` (best first), keeping each vector whose distance
 * to all kept vectors is ≥ minSeparation. Stops once `limit` slips are kept (if given).
 * Generic over any item that exposes a `.vector` so ranking metadata rides along.
 */
export function applySeparation<T extends { vector: (0 | 1)[] }>(
  ranked: T[],
  minSeparation: number,
  limit?: number,
): T[] {
  const kept: T[] = []
  for (const v of ranked) {
    if (limit != null && kept.length >= limit) break
    let ok = true
    for (const k of kept) {
      if (hammingDistance(v.vector, k.vector) < minSeparation) { ok = false; break }
    }
    if (ok) kept.push(v)
  }
  return kept
}
