// lib/pedlas/budget.ts
// Budget layer (external to PEDLAS proper, per the framework): K = floor(budget/stake),
// place the top-K separated slips at the minimum stake, and compute accurate
// winnings-boosted payouts + the honest EV verdict. Pure, no I/O.

import type { BinaryAxis, PedlasLeg, PedlasSlip } from './types'
import { sideOdds, stateSide } from './types'

/** Nigerian bookmaker minimum stake per slip. */
export const DEFAULT_MIN_STAKE = 100

/** Betway Nigeria maximum winnings cap (default). Payouts above this are forfeited. */
export const DEFAULT_MAX_PAYOUT = 50_000_000

/** The mandatory honest disclosure shown wherever a PEDLAS book is surfaced. */
export const HONEST_LABEL =
  'Structured −vig lottery. PEDLAS diversifies a small stake across high-payout slips; ' +
  'it does NOT beat the bookmaker margin or create edge. The Win Boost is a subsidy, not edge. ' +
  '+EV requires a calibrated p̂ > p_book (sharp-book reference). All-or-nothing per slip.'

/** K — how many slips the budget affords at the given stake. */
export function budgetSlots(budget: number, minStake: number = DEFAULT_MIN_STAKE): number {
  if (minStake <= 0) throw new Error('budgetSlots: minStake must be > 0')
  return Math.floor(budget / minStake)
}

/** Build the L legs for a vector. state 0 = dominant side, state 1 = breakout (per axis). */
export function buildLegs(vector: (0 | 1)[], axes: BinaryAxis[]): PedlasLeg[] {
  return axes.map((a, i) => {
    const side = stateSide(a, vector[i])
    return {
      fixtureId: a.fixtureId,
      game:      a.game,
      league:    a.league,
      kickoff:   a.kickoff,
      line:      a.line,
      side,
      market:    `OVER_UNDER_${a.line}`,
      outcome:   `${side} ${a.line}`,
      odds:      sideOdds(a, side),
    }
  })
}

/** Disjoint-approximation probability that AT LEAST ONE placed slip hits. */
export function pAnyHit(slips: PedlasSlip[]): number {
  // Slips are mutually exclusive outcome vectors, so P(any) = Σ P(each) exactly.
  return slips.reduce((s, sl) => s + sl.trueProb, 0)
}
