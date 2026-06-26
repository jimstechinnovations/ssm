// lib/pedlas/types.ts
// PEDLAS v1 — total-goals odds builder (small stake → big hit).
// Binary axis per game: state 0 = Under (dominant, cheap), state 1 = Over (breakout, dear, BIG).
// See pedlas_v1.md for the full spec, worked maths, and the honest-EV section.

/** Total-goals line for the Under/Over axis (PEDLAS focuses on 4.5 / 5.5 / 6.5). */
export type GoalLine = number

/**
 * One game expressed as a binary total-goals axis.
 *   state 0 = Under (the dominant, higher-probability, lower-odds side)
 *   state 1 = Over  (the breakout, lower-probability, higher-odds side)
 * Probabilities are de-vigged from the two-way price so within-axis they sum to 1.
 */
export interface BinaryAxis {
  fixtureId:  number
  game:       string   // "Home vs Away"
  league:     string   // competition name (drives the D constraint)
  leagueId:   number
  kickoff:    string    // ISO 8601 (drives E ordering + kickoff-spread feature)
  line:       GoalLine

  underOdds:  number
  underProb:  number    // de-vigged P(Under)
  overOdds:   number
  overProb:   number    // de-vigged P(Over)

  margin:     number    // two-way overround = 1/underOdds + 1/overOdds − 1
  volatility: number    // [0,1] — axis closeness (1 = coin-flip, 0 = lopsided); a ranking feature
}

/** The PEDLAS structural parameters (E, D, A, S). P and L are derived from the pool. */
export interface PedlasParams {
  /** A — Anchor distance: minimum Over-flips per slip (Hamming distance from the all-Under anchor). */
  minAnchorDistance: number
  /** S — Slip separation: minimum pairwise Hamming distance between any two kept slips. */
  minSlipSeparation: number
  /** E — Elimination: maximum run of identical consecutive selections after kickoff ordering. */
  maxIdenticalRun: number
  /** D — Diversity: maximum legs from any one competition within a single slip. */
  maxPerLeague: number
}

export const DEFAULT_PARAMS: PedlasParams = {
  minAnchorDistance: 2,
  minSlipSeparation: 3,
  maxIdenticalRun:   4,
  maxPerLeague:      3,
}

/** Per-vector features — the ONLY inputs the NIM ranker is allowed to see. */
export interface VectorFeatures {
  // ── vary per vector ──
  overFlips:              number
  combinedOdds:           number
  trueProb:               number
  evMultiple:             number
  flippedAvgVolatility:   number  // avg volatility of the games put in Over state (0 if none)
  flippedAvgOverOdds:     number  // avg Over odds of the flipped games (0 if none)
  flippedLeagues:         number  // distinct leagues among flipped games
  // ── pool-level context (constant across vectors of one pool) ──
  legCount:               number
  avgMargin:              number
  avgVolatility:          number
  avgLineHeight:          number
  distinctLeagues:        number
  maxLeagueConcentration: number  // most legs sharing one league / legCount
  kickoffSpreadHours:     number
}

/** A candidate outcome vector (before budget/ranking). */
export interface PedlasVector {
  vector:       (0 | 1)[]  // 0 = Under, 1 = Over, aligned to the axis order
  combinedOdds: number
  trueProb:     number     // P(this exact vector occurs) = ∏ axis prob
  evMultiple:   number     // honest EV per ₦1 staked (winnings-boost, no edge)
  overFlips:    number
  features:     VectorFeatures
}

/** A candidate vector with its ranking metadata attached (output of rank.ts). */
export interface RankedVector extends PedlasVector {
  rankScore:  number       // 0–100
  reasoning?: string       // NIM explanation (advisory only)
  hiddenRisk?: string      // NIM-surfaced risk (advisory only)
}

export interface PedlasLeg {
  fixtureId: number
  game:      string
  league:    string
  kickoff:   string
  line:      GoalLine
  side:      'Under' | 'Over'
  market:    string         // e.g. "OVER_UNDER_4.5"
  outcome:   string         // "Under 4.5" | "Over 4.5"
  odds:      number
}

/** A final, budget-allocated, ranked slip ready to place. */
export interface PedlasSlip {
  slipId:       number
  vector:       (0 | 1)[]
  legs:         PedlasLeg[]
  legCount:     number
  combinedOdds: number
  trueProb:     number      // P(this exact slip hits)
  boostPct:     number      // b(L) as a percentage (e.g. 20 = +20%)
  stake:          number
  payout:         number    // effective winnings-boosted payout, clamped to maxPayout
  uncappedPayout: number    // payout before the max-win cap (stake·(1 + (O−1)(1+b)))
  capped:         boolean    // true when uncappedPayout exceeded the cap (upside forfeited)
  evMultiple:     number    // honest EV per ₦1 (reflects the cap; never +EV from structure)
  rankScore:    number      // 0–100 (NIM, or deterministic fallback)
  reasoning?:   string      // NIM explanation (advisory only)
  hiddenRisk?:  string      // NIM-surfaced risk note (advisory only)
}

export interface PedlasVerdict {
  evMultiple:  number       // book-level representative EV multiple (no edge)
  positiveEV:  boolean      // true only if a calibrated edge were supplied (never from structure/boost)
  avgMargin:   number
  honestLabel: string       // MANDATORY disclosure string (see budget.ts)
}

export interface PedlasBook {
  mode:             'pedlas'
  params:           PedlasParams
  legCount:         number     // L
  budget:           number
  stakePerSlip:     number
  K:                number     // floor(budget / stakePerSlip)
  compressionRatio: number     // 2^L / candidateCount
  slips:            PedlasSlip[]
  verdict:          PedlasVerdict
  meta: {
    candidateCount: number
    pAnyHit:        number     // disjoint approximation: Σ trueProb over kept slips
    ranked:         'nim' | 'deterministic'
  }
}

export interface PedlasConfig {
  axes:        BinaryAxis[]
  budget:      number
  minStake?:   number                              // default 100 (Nigerian bookmaker minimum)
  maxPayout?:  number                              // Betway max-win cap (default ₦50,000,000)
  params?:     Partial<PedlasParams>
  rank?:       'nim' | 'deterministic' | 'auto'    // 'auto' = nim if NVIDIA_API_KEY present, else deterministic
}
