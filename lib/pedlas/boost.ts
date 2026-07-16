// lib/pedlas/boost.ts
// Win Boost maths. The default table is Betway Nigeria's (measured); other books supply
// their own via BoostFn (lib/books adapters) — unverified books use ZERO boost so payouts
// are never overstated.
//
// The live Betway Nigeria betslip applies boost to the displayed raw return:
//   raw return = stake * combinedOdds
//   boost      = raw return * boostFraction
//   payout     = stake * combinedOdds * (1 + boostFraction)

/** A book's Win Boost fraction by qualifying leg count. */
export type BoostFn = (legCount: number) => number

/** Betway Nigeria Win Boost table (fraction of raw return added), by qualifying leg count. */
const BOOST_TABLE: Record<number, number> = {
  3: 0.03, 4: 0.05, 5: 0.08, 6: 0.10, 7: 0.12, 8: 0.14, 9: 0.16, 10: 0.18, 11: 0.20, 12: 0.22,
  13: 0.25, 14: 0.30, 15: 0.35, 16: 0.40, 17: 0.45, 18: 0.50, 19: 0.55, 20: 0.60, 21: 0.65,
  22: 0.70, 23: 0.75, 24: 0.80, 25: 0.90, 26: 0.95, 27: 1.00, 28: 1.20, 29: 1.40, 30: 1.60,
  31: 1.80, 32: 2.00, 33: 2.20, 34: 2.40, 35: 2.60, 36: 2.80, 37: 3.00, 38: 3.25, 39: 3.50,
  40: 3.75, 41: 4.00, 42: 4.25, 43: 4.50, 44: 4.75, 45: 5.00, 46: 6.00, 47: 7.00, 48: 8.00,
  49: 9.00, 50: 10.00,
}

/** Win Boost fraction for a slip of `n` qualifying legs (formerly lib/spm/leg-stacker.ts). */
export function boostFor(n: number): number {
  if (n < 3) return 0
  if (n >= 50) return 10.0
  return BOOST_TABLE[n] ?? 0
}

/** A book with no (or unverified) multibet bonus: never overstate payouts. */
export const noBoost: BoostFn = () => 0

/**
 * Build a BoostFn from a stored [{legs, fraction}] table (book_configs.boost_json). Interpolates by
 * flooring to the highest table entry ≤ n (like BOOST_TABLE lookup). Only use a table VERIFIED
 * against a live betslip — an unverified/empty table falls back to zero (never overstate).
 */
export function boostFromTable(table: unknown): BoostFn {
  if (!Array.isArray(table) || table.length === 0) return noBoost
  const rows = table
    .map((r) => (r && typeof r === 'object' ? r as { legs?: unknown; fraction?: unknown } : {}))
    .map((r) => ({ legs: Number(r.legs), fraction: Number(r.fraction) }))
    .filter((r) => Number.isFinite(r.legs) && Number.isFinite(r.fraction) && r.legs >= 0 && r.fraction >= 0)
    .sort((a, b) => a.legs - b.legs)
  if (rows.length === 0) return noBoost
  return (n: number) => {
    let f = 0
    for (const r of rows) { if (r.legs <= n) f = r.fraction; else break }
    return f
  }
}

/** Win Boost as a fraction for a slip of `legCount` qualifying legs. */
export function boostFraction(legCount: number, boost: BoostFn = boostFor): number {
  return boost(legCount)
}

/** Win Boost as a percentage, e.g. 0.20 -> 20. */
export function boostPercent(legCount: number, boost: BoostFn = boostFor): number {
  return boost(legCount) * 100
}

/** Payout matching the book's displayed boosted return. */
export function boostedPayout(stake: number, combinedOdds: number, legCount: number, boost: BoostFn = boostFor): number {
  return stake * combinedOdds * (1 + boost(legCount))
}

/** Honest EV multiple per 1 unit staked for a single slip with no edge. */
export function honestEvMultiple(trueProb: number, combinedOdds: number, legCount: number, boost: BoostFn = boostFor): number {
  return trueProb * boostedPayout(1, combinedOdds, legCount, boost)
}
