// lib/pedlas/boost.ts
// Betway Nigeria Win Boost — PEDLAS reuses the single source of truth in
// lib/spm/leg-stacker.ts (boostFor), which encodes the confirmed schedule:
//   3 legs → +3%  …  50 legs → +1000%  (only legs with odds ≥ 1.20 count).
//
// IMPORTANT: Betway boosts WINNINGS (profit), not the whole return. The accurate
// payout is therefore stake·(1 + (O−1)·(1+b)), which equals stake·O·(1+b) only in
// the O ≫ 1 limit. PEDLAS uses the exact form so low-odds slips aren't overstated.

import { boostFor } from '../spm/leg-stacker'

/** Win Boost as a fraction for a slip of `legCount` qualifying (≥1.20) legs. 0 below 3 legs. */
export function boostFraction(legCount: number): number {
  return boostFor(legCount)
}

/** Win Boost as a percentage (e.g. 0.20 → 20). */
export function boostPercent(legCount: number): number {
  return boostFor(legCount) * 100
}

/**
 * Accurate Betway payout: the boost is applied to WINNINGS (profit), not total return.
 *   winnings        = stake·(O − 1)
 *   boostedWinnings = winnings·(1 + b)
 *   payout          = stake + boostedWinnings = stake·(1 + (O − 1)·(1 + b))
 */
export function boostedPayout(stake: number, combinedOdds: number, legCount: number): number {
  const b = boostFor(legCount)
  return stake * (1 + (combinedOdds - 1) * (1 + b))
}

/**
 * Honest EV multiple per ₦1 staked for a single slip with NO edge (p̂ = p_book).
 * EV = trueProb · payout / stake. With de-vig (pᵢ·oᵢ = 1/(1+mᵢ)) this is ≈ (1+b)/∏(1+mᵢ);
 * the exact winnings-boost form is used here. Structure/boost can never push this above 1 —
 * only a calibrated p̂ > p_book can (see spm_v2.md / leg-stacker.slipEVWithEdge).
 */
export function honestEvMultiple(trueProb: number, combinedOdds: number, legCount: number): number {
  return (trueProb * boostedPayout(1, combinedOdds, legCount)) / 1
}
