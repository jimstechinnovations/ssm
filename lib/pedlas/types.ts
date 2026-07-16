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

  /**
   * Which literal side is the DOMINANT (anchor / state-0) side for this line.
   * Defaults to 'Under' when absent (back-compat: high lines anchor on Under). For low lines
   * (e.g. Over 1.5) the dominant side is 'Over'. state 0 = dominant, state 1 = breakout.
   */
  dominantSide?: 'Over' | 'Under'

  /** ADVISORY ONLY (from team match-history). Never used in odds/EV math — backtested no edge. */
  advisory?: AxisAdvisory

  /** Why this axis was selected/anchored — composite quality + human reasons (for the UI summary). */
  decision?: AxisDecision

  margin:     number    // two-way overround = 1/underOdds + 1/overOdds − 1
  volatility: number    // [0,1] — axis closeness (1 = coin-flip, 0 = lopsided); a ranking feature
}

/** The selection rationale for an axis — a confident, clean, form-corroborated pick (not an edge claim). */
export interface AxisDecision {
  pick:       string    // the anchored outcome, e.g. "Under 4.5"
  confidence: number    // 0–100 composite quality (book confidence − vig − volatility ± form)
  reasons:    string[]  // human bullets shown in the UI decision summary
}

/** History-model view of an axis. Advisory: shown + fed to NIM, but does NOT change odds/EV. */
export interface AxisAdvisory {
  pHat: number                          // model p̂ of the DOMINANT side from recent form
  edge: number                          // p̂_dominant / p_book_dominant  (>1 = model likes the anchor)
  lean: 'back' | 'fade' | 'neutral'     // back = model agrees with the dominant pick
  note: string                          // short human note (e.g. "form λ 1.8–1.1")
}

/** The opposite total-goals side. */
export function otherSide(s: 'Over' | 'Under'): 'Over' | 'Under' { return s === 'Over' ? 'Under' : 'Over' }
/** Odds / prob for a literal side of an axis. */
export function sideOdds(a: BinaryAxis, side: 'Over' | 'Under'): number { return side === 'Over' ? a.overOdds : a.underOdds }
export function sideProb(a: BinaryAxis, side: 'Over' | 'Under'): number { return side === 'Over' ? a.overProb : a.underProb }
/** The literal side a state bit maps to: 0 = dominant (default Under), 1 = breakout. */
export function stateSide(a: BinaryAxis, bit: 0 | 1): 'Over' | 'Under' {
  const dom = a.dominantSide ?? 'Under'
  return bit === 0 ? dom : otherSide(dom)
}

/**
 * The PEDLA structural parameters (D, A). P and L are derived from the pool.
 * S (slip separation) and E (identical-run elimination) were REMOVED (pedla_v1.md §2): both
 * pruned the highest-probability region of the outcome space. Fill is now top-K by rank.
 */
export interface PedlasParams {
  /** A — Anchor distance: minimum Over-flips per slip (Hamming distance from the all-Under anchor). */
  minAnchorDistance: number
  /** D — Diversity: maximum legs from any one competition within a single slip. */
  maxPerLeague: number
  /**
   * Coverage scatter: fraction of the MOST-CONFIDENT legs to PIN at the anchor (never varied), so
   * variation is spent only on the UNCERTAIN legs. 0 = pin none (measured better; default).
   */
  pinTopFrac: number
}

export const DEFAULT_PARAMS: PedlasParams = {
  minAnchorDistance: 2,
  maxPerLeague:      3,
  pinTopFrac:        0,
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

/** Moonshot = rare big payout (payout-ranked, separated). Coverage = frequent small win (probability-ranked, neighbours kept). */
export type PedlasObjective = 'moonshot' | 'coverage'

export interface PedlasBook {
  mode:             'pedlas'
  /** Bookmaker this book targets (lib/books adapter id). Absent on legacy saved books = betway_nigeria. */
  bookId?:          string
  objective:        PedlasObjective
  params:           PedlasParams
  legCount:         number     // L
  budget:           number
  stakePerSlip:     number
  K:                number     // floor(budget / stakePerSlip)
  totalStake:       number     // Σ slip stakes actually placed
  guaranteedFloor:  boolean    // every placed slip's payout ≥ totalStake (one hit ≥ stake back)
  minPayout:        number     // smallest placed-slip payout (the worst hit)
  compressionRatio: number     // 2^L / candidateCount
  pool:             BinaryAxis[] // the axes used (both Under/Over sides) — enables editing/flipping legs
  slips:            PedlasSlip[]
  verdict:          PedlasVerdict
  meta: {
    candidateCount: number
    pAnyHit:        number     // disjoint exact: Σ trueProb over placed slips = P(≥1 slip hits)
    ranked:         'nim' | 'deterministic'
  }
}

export interface PedlasConfig {
  axes:        BinaryAxis[]
  budget:      number
  objective?:  PedlasObjective                      // default 'moonshot' (preserves prior behaviour)
  minStake?:   number                              // default 100 (Nigerian bookmaker minimum)
  maxPayout?:  number                              // book max-win cap (default ₦50,000,000)
  params?:     Partial<PedlasParams>
  rank?:       'nim' | 'deterministic' | 'auto'    // 'auto' = nim if NVIDIA_API_KEY present, else deterministic (moonshot only)
  /** The book's Win Boost table (from its lib/books adapter). Default: Betway Nigeria's. */
  boostFor?:   (legCount: number) => number
  /** Which bookmaker this book is built for (lib/books adapter id). Default 'betway_nigeria'. */
  bookId?:     string
}

// ---------------------------------------------------------------------------
// Bookmaker feed types (formerly lib/ssm/types.ts) — the shape the Betway
// scraper emits and market-select consumes.
// ---------------------------------------------------------------------------

export type MarketType =
  | '1X2'
  | 'BTTS'
  | 'OVER_UNDER_0.5'
  | 'OVER_UNDER_1.5'
  | 'OVER_UNDER_2.5'
  | 'OVER_UNDER_3.5'
  | 'OVER_UNDER_4.5'
  | 'OVER_UNDER_5.5'
  | 'OVER_UNDER_6.5'
  | 'ASIAN_HANDICAP'

/** One bookmaker market outcome (e.g. Home Win @ 2.10) */
export interface OddsValue {
  bookmaker: string
  market: MarketType
  label: string       // "Home" | "Draw" | "Away" | "Yes" | "No" | "Over 2.5" …
  value: number       // decimal odds
}

/** A fixture as scraped from the bookmaker feed */
export interface Fixture {
  id: number
  homeTeam: string
  awayTeam: string
  league: string
  leagueId: number
  kickoff: string     // ISO 8601
  venue?: string
  odds: OddsValue[]
}
