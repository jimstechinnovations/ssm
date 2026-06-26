// lib/pedlas/boost.ts
// Betway Nigeria Win Boost.
//
// The live Betway Nigeria betslip applies boost to the displayed raw return:
//   raw return = stake * combinedOdds
//   boost      = raw return * boostFraction
//   payout     = stake * combinedOdds * (1 + boostFraction)

import { boostFor } from '../spm/leg-stacker'

/** Win Boost as a fraction for a slip of `legCount` qualifying legs. */
export function boostFraction(legCount: number): number {
  return boostFor(legCount)
}

/** Win Boost as a percentage, e.g. 0.20 -> 20. */
export function boostPercent(legCount: number): number {
  return boostFor(legCount) * 100
}

/** Payout matching Betway Nigeria's displayed boosted return. */
export function boostedPayout(stake: number, combinedOdds: number, legCount: number): number {
  return stake * combinedOdds * (1 + boostFor(legCount))
}

/** Honest EV multiple per 1 unit staked for a single slip with no edge. */
export function honestEvMultiple(trueProb: number, combinedOdds: number, legCount: number): number {
  return trueProb * boostedPayout(1, combinedOdds, legCount)
}
