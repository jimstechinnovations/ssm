/**
 * lib/ssm/market-detector.ts
 *
 * Pure dominant-market detection for SSM Builder v2.
 * Takes 8 qualifying fixtures with their odds arrays and identifies
 * the Dominant_Market (State 0) and Breakout_Market (State 1) by
 * computing average implied probability across the fixture set.
 *
 * No I/O, no side effects. Safe to import in client-side components.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import type {
  DominantMarketResult,
  Fixture,
  MarketOutcome,
  OddsValue,
  OutcomeProbability,
} from './types'
import { MARKET_COUNTERPART, OUTCOME_TO_LABEL } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum number of fixtures that must carry a market for it to be eligible.
 *  Lowered from 6 to 1 — with free game selection there is no guarantee all
 *  8 games carry every market. We use any market with at least 1 fixture and
 *  rely on per-game profiling to fill gaps. */
const MIN_COVERAGE = 1

/** Ordered list of all candidate single-sided binary outcomes */
const ALL_OUTCOMES: MarketOutcome[] = [
  'BTTS_YES',
  'BTTS_NO',
  'OVER_2_5',
  'UNDER_2_5',
  'ODD',
  'EVEN',
  'DC12',
  'DC1X',
]

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Finds the decimal odds for a given label in an OddsValue array.
 * Returns null if not found.
 */
export function findOddsByLabel(odds: OddsValue[], label: string): number | null {
  for (const o of odds) {
    if (o.label === label) return o.value
  }
  return null
}

/**
 * Computes the arithmetic mean of a non-empty array of numbers.
 */
export function mean(values: number[]): number {
  if (values.length === 0) throw new Error('mean: empty array')
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * Computes the population variance of a non-empty array of numbers.
 */
export function populationVariance(values: number[]): number {
  if (values.length === 0) throw new Error('populationVariance: empty array')
  const m = mean(values)
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Detects the dominant and breakout markets from 8 qualifying fixtures.
 *
 * Algorithm:
 *  1. For each MarketOutcome, collect implied probabilities (1/odds) from
 *     fixtures that carry the market. Skip outcomes with < MIN_COVERAGE fixtures.
 *  2. Select the outcome with the highest avgImpliedProb as dominant (State 0).
 *  3. Break ties by lowest variance of individual implied probabilities.
 *  4. Breakout = MARKET_COUNTERPART[dominant].
 *
 * @param fixtures  Array of exactly 8 Fixture objects with `odds` populated.
 * @throws Error if fewer than 2 eligible outcomes are found.
 */
export function detectDominantMarket(fixtures: Fixture[]): DominantMarketResult {
  if (fixtures.length !== 8) {
    throw new Error(`detectDominantMarket: expected 8 fixtures, got ${fixtures.length}`)
  }

  // Step 1: Compute average implied probability per outcome
  const outcomeProbabilities: OutcomeProbability[] = []

  for (const outcome of ALL_OUTCOMES) {
    const label = OUTCOME_TO_LABEL[outcome]
    const impliedProbs: number[] = []

    for (const fixture of fixtures) {
      const oddsValue = findOddsByLabel(fixture.odds, label)
      if (oddsValue !== null && oddsValue > 0) {
        impliedProbs.push(1.0 / oddsValue)
      }
    }

    // Require at least MIN_COVERAGE fixtures to carry this market
    if (impliedProbs.length < MIN_COVERAGE) continue

    outcomeProbabilities.push({
      outcome,
      avgImpliedProb: mean(impliedProbs),
      variance:       populationVariance(impliedProbs),
      coverageCount:  impliedProbs.length,
    })
  }

  if (outcomeProbabilities.length < 1) {
    throw new Error(
      `detectDominantMarket: no eligible outcomes found across the 8 fixtures. ` +
      `Ensure fixtures contain at least one binary market (BTTS Yes/No, Over/Under 2.5, or DC 12).`,
    )
  }

  // Step 2: Find the maximum average implied probability
  const maxProb = Math.max(...outcomeProbabilities.map(o => o.avgImpliedProb))

  // Step 3: Collect ties
  const ties = outcomeProbabilities.filter(o => o.avgImpliedProb === maxProb)

  let dominant: OutcomeProbability
  let tieBroken = false
  let tieBreakDetail: string | undefined

  if (ties.length === 1) {
    dominant = ties[0]
  } else {
    // Tie-break: select outcome with the lowest variance
    dominant = ties.reduce((best, current) =>
      current.variance < best.variance ? current : best,
    )
    tieBroken = true
    tieBreakDetail =
      `Tied outcomes: ${ties.map(t => t.outcome).join(', ')}. ` +
      `Tiebreaker: lowest variance → ${dominant.outcome}`
  }

  // Step 4: Resolve breakout
  const breakoutOutcome = MARKET_COUNTERPART[dominant.outcome]

  return {
    dominantOutcome:  dominant.outcome,
    avgImpliedProb:   dominant.avgImpliedProb,
    breakoutOutcome,
    tieBroken,
    tieBreakDetail,
    allOutcomes:      outcomeProbabilities,
  }
}
