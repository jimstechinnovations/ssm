// lib/ssm/types.ts
// All shared TypeScript interfaces for the Score Structure Model (SSM) Builder

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

export type TierLabel = 'CORE' | 'PIVOT' | 'BRIDGE' | 'CHAOS'

export type AccountProfile =
  | 'Balanced Aggressive'   // Accounts 1-4: 4 Core + 1 Pivot + 1 Chaos
  | 'Standard Accumulator'  // Account 5: 4 Core + 2 Pivot
  | 'Heavy Core'            // Accounts 6-7: 5 Core + 1 Pivot

/** One bookmaker market outcome (e.g. Home Win @ 2.10) */
export interface OddsValue {
  bookmaker: string
  market: MarketType
  label: string       // "Home" | "Draw" | "Away" | "Yes" | "No" | "Over 2.5" …
  value: number       // decimal odds
}

/** A fixture fetched from API-Football */
export interface Fixture {
  id: number
  homeTeam: string
  awayTeam: string
  league: string
  leagueId: number
  kickoff: string     // ISO 8601
  venue?: string
  odds: OddsValue[]   // populated after /api/odds call
}

/** State assignment for one fixture in the session */
export interface MatchSelection {
  fixture: Fixture
  state0: OddsValue   // dominant/favourite outcome
  state1: OddsValue   // breakout/underdog outcome
  volatility: number  // normalised [0,1] (used for Chaos Anchor targeting)
}

/** A single leg within a betting slip */
export interface SlipLeg {
  matchIndex: number  // 0-7 (position in the 8-match selection)
  fixtureId: number
  homeTeam: string
  awayTeam: string
  market: MarketType
  outcome: string     // "Home" | "Over 2.5" | etc.
  odds: number
  state: 0 | 1        // which state this leg uses
}

/** One of the 56 generated betting slips */
export interface Slip {
  slipId: number      // 1-56
  tier: TierLabel
  tierIndex: number   // position within the tier (1-30, 1-8, 1-14, 1-4)
  legs: SlipLeg[]     // always exactly 8 legs
  combinedOdds: number
  stake: number
  potentialPayout: number
  sessionHash: string // e.g. "SESS-20260614-A03-S05"
}

/** Configuration for a session */
export interface SessionConfig {
  date: string        // YYYY-MM-DD
  stakePerSlip: number
  numAccounts: 6 | 7
  sessionPrefix: string // "SESS-{DATE}"
}

/** Which slips go to which account */
export interface AccountAllocation {
  accountNumber: number // 1-7
  profile: AccountProfile
  slips: Slip[]
  totalStake: number
  sessionHashes: string[]
}

/** A complete SSM session */
export interface Session {
  id: string          // UUID (Supabase PK)
  sessionPrefix: string
  date: string
  config: SessionConfig
  selections: MatchSelection[]
  slips: Slip[]
  accountDistribution: AccountAllocation[]
  createdAt: string
  cachedApiData: Record<number, OddsValue[]> // fixtureId → odds cache
  // ── v2 additions ──────────────────────────────────────────────────
  groupId?: string
  dominantMarket?: DominantMarketResult
  breakoutMarket?: MarketOutcome
  bankroll?: number
}

// ── v2 additions ─────────────────────────────────────────────────────────────

export type BookmakerPlatform =
  | 'betway_nigeria'
  | 'sportybet'
  | 'stake'
  | '1xbet'
  | 'other'

export const BOOKMAKER_IDS: Record<BookmakerPlatform, number | null> = {
  betway_nigeria: 45,
  sportybet:      11,
  stake:          167,
  '1xbet':        5,
  other:          null,
}

export type MarketOutcome =
  | 'BTTS_YES'
  | 'BTTS_NO'
  | 'OVER_2_5'
  | 'UNDER_2_5'
  | 'ODD'
  | 'EVEN'
  | 'DC12'
  | 'DC1X'

export const MARKET_COUNTERPART: Record<MarketOutcome, MarketOutcome> = {
  BTTS_YES:  'BTTS_NO',
  BTTS_NO:   'BTTS_YES',
  OVER_2_5:  'UNDER_2_5',
  UNDER_2_5: 'OVER_2_5',
  ODD:       'EVEN',
  EVEN:      'ODD',
  DC12:      'DC1X',
  DC1X:      'DC12',
}

// Maps MarketOutcome to the exact odds label string used in API-Football responses
export const OUTCOME_TO_LABEL: Record<MarketOutcome, string> = {
  BTTS_YES:  'BTTS Yes',
  BTTS_NO:   'BTTS No',
  OVER_2_5:  'Over 2.5',
  UNDER_2_5: 'Under 2.5',
  ODD:       'Odd',
  EVEN:      'Even',
  DC12:      'DC 12',
  DC1X:      'DC 1X',
}

export interface GateEvaluation {
  gate:      'G1' | 'G2' | 'G3' | 'G4'
  passed:    boolean
  evaluated: number | { yes: number; no: number }
  threshold: string
}

export interface GateResult {
  fixtureId:     number
  qualified:     boolean
  gates:         GateEvaluation[]
  rejectReason?: 'GATE_FAILURE' | 'ODDS_UNAVAILABLE'
}

export interface FixtureWithGates {
  fixture:    Fixture
  gateResult: GateResult
}

// ── v3: Profile-based classification (replaces hard gate rejection) ────────────

/**
 * Each fixture gets classified into one of three structural profiles
 * based on its actual odds — no rejection, just routing to the correct
 * slip matrix calibration.
 *
 * Goal-Certain  — high-scoring signal, BTTS-live, winner expected
 * Balanced      — typical competitive match, open markets
 * Defensive     — low-scoring signal, draw/cautious game
 */
export type GameProfile = 'GOAL_CERTAIN' | 'BALANCED' | 'DEFENSIVE'

export interface ProfiledFixture {
  fixture:          Fixture
  profile:          GameProfile
  /** The dominant binary outcome for this specific game (State 0) */
  dominantOutcome:  MarketOutcome
  /** The breakout binary outcome for this specific game (State 1) */
  breakoutOutcome:  MarketOutcome
  /** Implied probability of the dominant outcome (1 / dominant odds) */
  dominantProb:     number
  /** Signals available for this fixture — for UI display */
  signals:          GameSignals
}

export interface GameSignals {
  over05:    number | null
  under05:   number | null
  bttsYes:   number | null
  bttsNo:    number | null
  over25:    number | null
  under25:   number | null
  dc12:      number | null
  dc1x:      number | null
  odd:       number | null
  even:      number | null
}

export interface ScreeningResult {
  groupId:             string
  allFixtures:         ProfiledFixture[]
  qualifyingFixtures:  ProfiledFixture[]
  excludedFixtureIds:  number[]
  screenedCount:       number
  qualifyingCount:     number
  unclaimedQualifying: number
}

export interface OutcomeProbability {
  outcome:        MarketOutcome
  avgImpliedProb: number
  variance:       number
  coverageCount:  number
}

export interface DominantMarketResult {
  dominantOutcome:  MarketOutcome
  avgImpliedProb:   number
  breakoutOutcome:  MarketOutcome
  tieBroken:        boolean
  tieBreakDetail?:  string
  allOutcomes:      OutcomeProbability[]
}

export interface TierAllocation {
  bankroll:            number
  coreStakePerSlip:    number
  pivotStakePerSlip:   number
  bridgeStakePerSlip:  number   // three-flip + four-flip coverage (new in v3.1)
  chaosStakePerSlip:   number
  buffer:              number
  total:               number
}

export type SessionGroupStatus = 'screening' | 'generated' | 'printed'

export interface SessionGroup {
  id:                 string
  status:             SessionGroupStatus
  bookmaker:          BookmakerPlatform
  dateFrom:           string
  dateTo:             string
  claimedFixtureIds:  number[]
  screeningResults:   ScreeningResult | null
  dominantMarket:     DominantMarketResult | null
  bankroll:           number
  numAccounts:        6 | 7
  sessionId:          string | null
  createdAt:          string
  updatedAt:          string
}
