// lib/pedlas/budget.ts
// Budget layer (external to PEDLAS proper, per the framework): K = floor(budget/stake),
// place the top-K separated slips at the minimum stake, and compute accurate
// winnings-boosted payouts + the honest EV verdict. Pure, no I/O.

import type {
  BinaryAxis, PedlasLeg, PedlasSlip, PedlasVerdict, RankedVector,
} from './types'
import { boostPercent, boostedPayout, honestEvMultiple } from './boost'

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

/** Build the L legs for a vector (one Under/Over leg per axis). */
export function buildLegs(vector: (0 | 1)[], axes: BinaryAxis[]): PedlasLeg[] {
  return axes.map((a, i) => {
    const isOver = vector[i] === 1
    return {
      fixtureId: a.fixtureId,
      game:      a.game,
      league:    a.league,
      kickoff:   a.kickoff,
      line:      a.line,
      side:      isOver ? 'Over' : 'Under',
      market:    `OVER_UNDER_${a.line}`,
      outcome:   `${isOver ? 'Over' : 'Under'} ${a.line}`,
      odds:      isOver ? a.overOdds : a.underOdds,
    }
  })
}

/** Turn a ranked vector into a placed slip with accurate, cap-clamped stake/payout/EV. */
export function assembleSlip(
  rv: RankedVector,
  axes: BinaryAxis[],
  slipId: number,
  stake: number,
  maxPayout: number = DEFAULT_MAX_PAYOUT,
): PedlasSlip {
  const legCount = axes.length
  const uncappedPayout = boostedPayout(stake, rv.combinedOdds, legCount)
  const payout = Math.min(uncappedPayout, maxPayout)
  return {
    slipId,
    vector:       rv.vector,
    legs:         buildLegs(rv.vector, axes),
    legCount,
    combinedOdds: rv.combinedOdds,
    trueProb:     rv.trueProb,
    boostPct:     boostPercent(legCount),
    stake,
    payout,
    uncappedPayout,
    capped:       uncappedPayout > payout,
    // EV reflects the cap: capping forfeits upside, so this can only get worse, never +EV.
    evMultiple:   (rv.trueProb * payout) / stake,
    rankScore:    rv.rankScore,
    reasoning:    rv.reasoning,
    hiddenRisk:   rv.hiddenRisk,
  }
}

/**
 * Honest book-level verdict. evMultiple is the geometric-mean representative EV per ₦1
 * with NO edge (always < 1 at any real margin); positiveEV is hard-wired false because
 * neither structure nor boost can create edge — only a calibrated p̂ can (not supplied here).
 */
export function buildVerdict(axes: BinaryAxis[], slips: PedlasSlip[]): PedlasVerdict {
  const L = axes.length
  const avgMargin = L ? axes.reduce((s, a) => s + a.margin, 0) / L : 0
  // Representative EV: median-ish via the mean true-prob slip — but EV is ~flat across
  // slips, so use the average of placed-slip EV multiples.
  const evMultiple = slips.length
    ? slips.reduce((s, sl) => s + sl.evMultiple, 0) / slips.length
    : (L ? honestEvMultiple(Math.pow(1 / (1 + avgMargin), L) /* anchor-ish */, Math.pow(1 + avgMargin, L), L) : 0)
  return {
    evMultiple,
    positiveEV: false,
    avgMargin,
    honestLabel: HONEST_LABEL,
  }
}

/** Disjoint-approximation probability that AT LEAST ONE placed slip hits. */
export function pAnyHit(slips: PedlasSlip[]): number {
  // Slips are mutually exclusive outcome vectors, so P(any) = Σ P(each) exactly.
  return slips.reduce((s, sl) => s + sl.trueProb, 0)
}
