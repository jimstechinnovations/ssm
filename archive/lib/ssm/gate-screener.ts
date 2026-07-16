/**
 * lib/ssm/gate-screener.ts
 *
 * Adaptive fixture profiler for SSM v3.
 *
 * Replaces the hard G1–G4 gate rejection with a profile classifier.
 * Every fixture with odds data is accepted and assigned one of three
 * structural profiles:
 *
 *   GOAL_CERTAIN  — high-scoring signal, BTTS live, winner expected
 *                   (matches the original FK Sveikata template game)
 *   BALANCED      — typical competitive match, open markets
 *   DEFENSIVE     — low-scoring / draw-likely game
 *
 * The profile determines which dominant market is selected as State 0
 * and its counterpart as State 1 for the 42-slip matrix construction.
 *
 * Per-game state selection (not a session-wide market):
 *   Each game picks its own dominant/breakout pair from its actual odds
 *   using the highest implied probability across all available binary markets.
 *
 * No rejection. No gates. Structure from actual odds.
 *
 * Pure function — no I/O, no side effects, no thrown exceptions.
 */

import type {
  Fixture,
  GameProfile,
  GameSignals,
  MarketOutcome,
  ProfiledFixture,
} from './types'
import { MARKET_COUNTERPART } from './types'

// ─── Profile thresholds ───────────────────────────────────────────────────────
//
// These are used only for classification (display/context) — not for rejection.

const GOAL_CERTAIN_OVER05_MAX  = 1.20   // Over 0.5 < 1.20  → goal-certain signal
const GOAL_CERTAIN_UNDER05_MIN = 4.00   // Under 0.5 > 4.00 → 0-0 unlikely
const DEFENSIVE_UNDER25_MAX    = 1.50   // Under 2.5 < 1.50 → low-scoring expected

// ─── Odds extraction ─────────────────────────────────────────────────────────

/** Extract all gate-relevant odds from a fixture's odds array */
function extractSignals(odds: Fixture['odds']): GameSignals {
  const get = (label: string): number | null => {
    const o = odds.find(x => x.label === label)
    return o ? o.value : null
  }
  return {
    over05:   get('Over 0.5'),
    under05:  get('Under 0.5'),
    bttsYes:  get('BTTS Yes'),
    bttsNo:   get('BTTS No'),
    over25:   get('Over 2.5'),
    under25:  get('Under 2.5'),
    dc12:     get('DC 12'),
    dc1x:     get('DC 1X'),
    odd:      get('Odd'),
    even:     get('Even'),
  }
}

// ─── Profile classification ───────────────────────────────────────────────────

function classifyProfile(signals: GameSignals): GameProfile {
  const { over05, under05, under25 } = signals

  // GOAL_CERTAIN: strong goal signal AND 0-0 eliminated
  if (
    over05  !== null && over05  < GOAL_CERTAIN_OVER05_MAX &&
    under05 !== null && under05 > GOAL_CERTAIN_UNDER05_MIN
  ) {
    return 'GOAL_CERTAIN'
  }

  // DEFENSIVE: low-scoring market signal dominant
  if (under25 !== null && under25 < DEFENSIVE_UNDER25_MAX) {
    return 'DEFENSIVE'
  }

  // Everything else is BALANCED
  return 'BALANCED'
}

// ─── Per-game dominant market selection ──────────────────────────────────────
//
// For each game, pick the binary outcome with the highest implied probability
// from the available odds. This is the per-game dominant state (State 0).
// Its MARKET_COUNTERPART is State 1.
//
// Candidate outcomes are ordered by preference within each profile to ensure
// the most structurally meaningful market is chosen when odds are similar.

const CANDIDATE_OUTCOMES: MarketOutcome[] = [
  'BTTS_YES', 'BTTS_NO',
  'OVER_2_5', 'UNDER_2_5',
  'DC12',     'DC1X',
  'ODD',      'EVEN',
]

const OUTCOME_TO_ODDS_LABEL: Record<MarketOutcome, string> = {
  BTTS_YES:  'BTTS Yes',
  BTTS_NO:   'BTTS No',
  OVER_2_5:  'Over 2.5',
  UNDER_2_5: 'Under 2.5',
  ODD:       'Odd',
  EVEN:      'Even',
  DC12:      'DC 12',
  DC1X:      'DC 1X',
}

interface OutcomeEntry {
  outcome:     MarketOutcome
  odds:        number
  impliedProb: number
}

function selectDominantOutcome(
  signals: GameSignals,
  profile: GameProfile,
  odds: Fixture['odds'],
): { dominantOutcome: MarketOutcome; breakoutOutcome: MarketOutcome; dominantProb: number } {
  // Collect all outcomes that have odds available
  const entries: OutcomeEntry[] = []

  for (const outcome of CANDIDATE_OUTCOMES) {
    const label = OUTCOME_TO_ODDS_LABEL[outcome]
    const oddsValue = odds.find(o => o.label === label)
    if (oddsValue && oddsValue.value > 0) {
      entries.push({
        outcome,
        odds:        oddsValue.value,
        impliedProb: 1.0 / oddsValue.value,
      })
    }
  }

  if (entries.length === 0) {
    // Absolute fallback — no binary markets available at all
    // Use DC12 / DC1X with placeholder odds
    return {
      dominantOutcome: 'DC12',
      breakoutOutcome: 'DC1X',
      dominantProb:    0.5,
    }
  }

  // Profile-weighted selection:
  // For GOAL_CERTAIN, prefer BTTS Yes if it has a reasonable implied prob
  // For DEFENSIVE, prefer Under 2.5 or Under 0.5 signal markets
  // For BALANCED, purely highest implied prob wins

  let dominant: OutcomeEntry

  if (profile === 'GOAL_CERTAIN') {
    // Prefer BTTS_YES if available and has ≥50% implied prob
    const bttsYesEntry = entries.find(e => e.outcome === 'BTTS_YES')
    if (bttsYesEntry && bttsYesEntry.impliedProb >= 0.50) {
      dominant = bttsYesEntry
    } else {
      // Fall back to highest implied prob
      dominant = entries.reduce((best, e) => e.impliedProb > best.impliedProb ? e : best)
    }
  } else if (profile === 'DEFENSIVE') {
    // Prefer Under 2.5 if available and dominant
    const under25Entry = entries.find(e => e.outcome === 'UNDER_2_5')
    if (under25Entry && under25Entry.impliedProb >= 0.50) {
      dominant = under25Entry
    } else {
      dominant = entries.reduce((best, e) => e.impliedProb > best.impliedProb ? e : best)
    }
  } else {
    // BALANCED — highest implied prob, no preference
    dominant = entries.reduce((best, e) => e.impliedProb > best.impliedProb ? e : best)
  }

  return {
    dominantOutcome: dominant.outcome,
    breakoutOutcome: MARKET_COUNTERPART[dominant.outcome],
    dominantProb:    dominant.impliedProb,
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Profiles a fixture from its actual odds.
 *
 * Every fixture with any odds data returns a ProfiledFixture.
 * No rejection — if odds are completely unavailable, a BALANCED profile
 * with DC12/DC1X defaults is used so the fixture can still enter the matrix.
 *
 * @param fixture  A Fixture object with odds array populated
 * @returns        ProfiledFixture with profile, dominant/breakout outcomes, signals
 */
export function profileFixture(fixture: Fixture): ProfiledFixture {
  const signals  = extractSignals(fixture.odds)
  const profile  = classifyProfile(signals)
  const { dominantOutcome, breakoutOutcome, dominantProb } = selectDominantOutcome(
    signals,
    profile,
    fixture.odds,
  )

  return {
    fixture,
    profile,
    dominantOutcome,
    breakoutOutcome,
    dominantProb,
    signals,
  }
}

/**
 * Profiles an array of fixtures, returning all as ProfiledFixtures.
 * Never rejects — every fixture gets a profile and enters the pool.
 */
export function profileFixtures(fixtures: Fixture[]): ProfiledFixture[] {
  return fixtures.map(profileFixture)
}

// ─── Backward-compatibility shim ─────────────────────────────────────────────
//
// The old runGateScreener is preserved as a no-op pass-through so any
// remaining references don't break during the transition. It always returns
// qualified=true with an empty gates array.
// TODO: Remove after all call sites are migrated to profileFixture.

import type { GateResult } from './types'

export function runGateScreener(
  fixtureId: number,
  _oddsMap: Map<string, number>,
): GateResult {
  return { fixtureId, qualified: true, gates: [] }
}
