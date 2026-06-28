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
 * Diversity-preferring fill (the spec-faithful S — "reduce redundancy / maximize diversity" then
 * "select top K within budget"). Walks `ranked` (best first) and prefers slips that differ from
 * those already kept by ≥ minSep (genuine scatter, no near-duplicates). Crucially it then
 * BACKFILLS from the skipped near-duplicates so it ALWAYS reaches K when enough candidates exist —
 * it never under-fills the budget the way a rigid min-distance does.
 */
export function diverseFill<T extends { vector: (0 | 1)[] }>(ranked: T[], K: number, minSep = 2): T[] {
  if (ranked.length <= K) return ranked.slice(0, K)
  const kept: T[] = []
  const skipped: T[] = []
  for (const v of ranked) {
    if (kept.length >= K) break
    if (kept.every(k => hammingDistance(v.vector, k.vector) >= minSep)) kept.push(v)
    else skipped.push(v)
  }
  for (const v of skipped) { // backfill to K so the full budget is always used
    if (kept.length >= K) break
    kept.push(v)
  }
  return kept
}

/**
 * Greedy hard separation (legacy). Keeps each vector whose distance to all kept is ≥ minSeparation;
 * may return FEWER than `limit` (under-fills). Retained for tests/analysis; the builder uses
 * diverseFill instead so the budget is always filled.
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
