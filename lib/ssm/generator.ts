// lib/ssm/generator.ts
// Pure 42-slip SSM matrix generator. No I/O, no side effects.
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 10.4, 10.5

import type { MatchSelection, SessionConfig, Slip, SlipLeg } from './types'

// ---------------------------------------------------------------------------
// buildLegs
// ---------------------------------------------------------------------------

/**
 * Constructs 8 SlipLeg objects for a given state vector.
 *
 * Preconditions:
 *   - selections.length === 8
 *   - stateVector.length === 8
 *   - All selections[i].state0 and selections[i].state1 are non-null
 *
 * Postconditions:
 *   - Returns exactly 8 SlipLeg objects
 *   - result[i].state === stateVector[i]
 *   - result[i].odds === (stateVector[i] === 0 ? state0.value : state1.value)
 *   - No mutations to input arrays
 */
export function buildLegs(
  selections: MatchSelection[],
  stateVector: (0 | 1)[],
): SlipLeg[] {
  if (selections.length !== 8) {
    throw new Error(`buildLegs: expected 8 selections, got ${selections.length}`)
  }
  if (stateVector.length !== 8) {
    throw new Error(`buildLegs: expected state vector of length 8, got ${stateVector.length}`)
  }

  return selections.map((sel, i) => {
    const s = stateVector[i]
    const oddsVal = s === 0 ? sel.state0 : sel.state1
    const leg: SlipLeg = {
      matchIndex: i,
      fixtureId:  sel.fixture.id,
      homeTeam:   sel.fixture.homeTeam,
      awayTeam:   sel.fixture.awayTeam,
      market:     oddsVal.market,
      outcome:    oddsVal.label,
      odds:       oddsVal.value,
      state:      s,
    }
    return leg
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Multiply all leg odds together to get combinedOdds. */
function productOfLegs(legs: SlipLeg[]): number {
  return legs.reduce((acc, leg) => acc * leg.odds, 1)
}

// ---------------------------------------------------------------------------
// generateCoreSlips — 30 slips (Tier 1)
// ---------------------------------------------------------------------------

/**
 * Generates the 30 CORE slips.
 *
 * Strategy:
 *   1 all-zeros vector
 *   + 8 single-flip vectors
 *   + 21 lowest-volatility two-flip pairs (from 28 candidates sorted ascending)
 *   = 30 slips total
 *
 * slipId 1–30, tier 'CORE'
 *
 * Requirements: 1.1, 1.2, 1.3
 */
export function generateCoreSlips(
  selections: MatchSelection[],
  stakePerSlip: number,
): Slip[] {
  // --- 1. All-zeros vector ---
  const vectors: (0 | 1)[][] = []
  vectors.push([0, 0, 0, 0, 0, 0, 0, 0])

  // --- 2. Eight single-flip vectors ---
  for (let i = 0; i < 8; i++) {
    const v: (0 | 1)[] = [0, 0, 0, 0, 0, 0, 0, 0]
    v[i] = 1
    vectors.push(v)
  }

  // --- 3. 28 two-flip candidates, sorted ascending by volatility sum ---
  interface TwoFlipCandidate {
    v: (0 | 1)[]
    score: number
  }
  const twoFlipCandidates: TwoFlipCandidate[] = []

  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 8; j++) {
      const v: (0 | 1)[] = [0, 0, 0, 0, 0, 0, 0, 0]
      v[i] = 1
      v[j] = 1
      const score = selections[i].volatility + selections[j].volatility
      twoFlipCandidates.push({ v, score })
    }
  }

  // Sort ascending by volatility score (lowest first = least disruptive)
  twoFlipCandidates.sort((a, b) => a.score - b.score)

  // Take the 21 lowest-volatility pairs (1 + 8 + 21 = 30)
  const top21 = twoFlipCandidates.slice(0, 21)
  for (const candidate of top21) {
    vectors.push(candidate.v)
  }

  if (vectors.length !== 30) {
    throw new Error(`generateCoreSlips: expected 30 vectors, got ${vectors.length}`)
  }

  // --- Build slips ---
  return vectors.map((stateVector, idx) => {
    const legs = buildLegs(selections, stateVector)
    const combinedOdds = productOfLegs(legs)
    const slip: Slip = {
      slipId:         idx + 1,
      tier:           'CORE',
      tierIndex:      idx + 1,
      legs,
      combinedOdds,
      stake:          stakePerSlip,
      potentialPayout: combinedOdds * stakePerSlip,
      sessionHash:    '', // assigned later by the generate route handler
    }
    return slip
  })
}

// ---------------------------------------------------------------------------
// generatePivotSlips — 8 slips (Tier 2)
// ---------------------------------------------------------------------------

/**
 * Generates the 8 PIVOT slips.
 *
 * Each pivot slip i: all legs state 0 except leg i which is state 1.
 *
 * slipId 31–38, tier 'PIVOT'
 *
 * Requirements: 1.4, 1.5
 */
export function generatePivotSlips(
  selections: MatchSelection[],
  stakePerSlip: number,
  startId = 31,
): Slip[] {
  const slips: Slip[] = []

  for (let i = 0; i < 8; i++) {
    const stateVector: (0 | 1)[] = [0, 0, 0, 0, 0, 0, 0, 0]
    stateVector[i] = 1

    const legs = buildLegs(selections, stateVector)
    const combinedOdds = productOfLegs(legs)

    slips.push({
      slipId:         startId + i,
      tier:           'PIVOT',
      tierIndex:      i + 1,
      legs,
      combinedOdds,
      stake:          stakePerSlip,
      potentialPayout: combinedOdds * stakePerSlip,
      sessionHash:    '',
    })
  }

  return slips
}

// ---------------------------------------------------------------------------
// generateChaosSlips — 4 slips (Tier 3)
// ---------------------------------------------------------------------------

/**
 * Generates the 4 CHAOS slips.
 *
 * Chaos slip 39 (idx 0): all 8 legs state 1 (full contrarian)
 * Chaos slip 40 (idx 1): top 4 volatile legs → OVER_UNDER_1.5 market if available
 *                         (fallback to state 1); rest → state 1
 * Chaos slip 41 (idx 2): even parity — positions 0,2,4,6 use state 1; odd use state 0
 * Chaos slip 42 (idx 3): top 4 volatile → state 1; bottom 4 → state 0
 *
 * slipId 39–42, tier 'CHAOS'
 *
 * Requirements: 1.6, 1.7, 10.4, 10.5
 */
export function generateChaosSlips(
  selections: MatchSelection[],
  stakePerSlip: number,
  startId = 39,
): Slip[] {
  // Sort indices descending by volatility to identify top 4
  const sortedIndices = selections
    .map((sel, i) => ({ i, volatility: sel.volatility }))
    .sort((a, b) => b.volatility - a.volatility)

  const top4Indices = new Set(sortedIndices.slice(0, 4).map(x => x.i))

  // --- Slip 39: all state 1 ---
  const vector39: (0 | 1)[] = [1, 1, 1, 1, 1, 1, 1, 1]

  // --- Slip 40: top 4 volatile → OVER_UNDER_1.5 if available; else state 1; rest → state 1 ---
  // Build legs manually because chaos slip 40 may override the market for top-4 legs.
  const legs40: SlipLeg[] = selections.map((sel, i) => {
    if (top4Indices.has(i)) {
      // Try to use OVER_UNDER_1.5 from the fixture's odds array
      const ou15 = sel.fixture.odds.find(o => o.market === 'OVER_UNDER_1.5')
      if (ou15) {
        return {
          matchIndex: i,
          fixtureId:  sel.fixture.id,
          homeTeam:   sel.fixture.homeTeam,
          awayTeam:   sel.fixture.awayTeam,
          market:     ou15.market,
          outcome:    ou15.label,
          odds:       ou15.value,
          state:      1 as const,
        }
      }
    }
    // Fallback: state 1
    return {
      matchIndex: i,
      fixtureId:  sel.fixture.id,
      homeTeam:   sel.fixture.homeTeam,
      awayTeam:   sel.fixture.awayTeam,
      market:     sel.state1.market,
      outcome:    sel.state1.label,
      odds:       sel.state1.value,
      state:      1 as const,
    }
  })

  // --- Slip 41: even parity — even indices (0,2,4,6) → state 1; odd → state 0 ---
  const vector41: (0 | 1)[] = [1, 0, 1, 0, 1, 0, 1, 0]

  // --- Slip 42: top 4 volatile → state 1; bottom 4 → state 0 ---
  const vector42: (0 | 1)[] = selections.map((_, i) =>
    top4Indices.has(i) ? 1 : 0
  ) as (0 | 1)[]

  const chaosDefinitions: { legs: SlipLeg[] }[] = [
    { legs: buildLegs(selections, vector39) },
    { legs: legs40 },
    { legs: buildLegs(selections, vector41) },
    { legs: buildLegs(selections, vector42) },
  ]

  return chaosDefinitions.map((def, idx) => {
    const combinedOdds = productOfLegs(def.legs)
    return {
      slipId:         startId + idx,
      tier:           'CHAOS' as const,
      tierIndex:      idx + 1,
      legs:           def.legs,
      combinedOdds,
      stake:          stakePerSlip,
      potentialPayout: combinedOdds * stakePerSlip,
      sessionHash:    '',
    }
  })
}

// ---------------------------------------------------------------------------
// generateMatrix — master orchestrator
// ---------------------------------------------------------------------------

/**
 * Generates the complete 42-slip SSM matrix.
 *
 * Assertions:
 *   - selections.length === 8
 *   - All selections have state0 and state1
 *   - config.stakePerSlip > 0
 *   - config.numAccounts in {6, 7}
 *
 * Note: slips are returned with sessionHash = '' — the generate route handler
 * assigns sessionHash after account distribution.
 *
 * Requirements: 1.1–1.7, 10.4, 10.5
 */
export function generateMatrix(
  selections: MatchSelection[],
  config: SessionConfig,
): Slip[] {
  // --- Precondition assertions ---
  if (selections.length !== 8) {
    throw new Error(`generateMatrix: expected 8 selections, got ${selections.length}`)
  }
  for (let i = 0; i < 8; i++) {
    if (!selections[i].state0 || !selections[i].state1) {
      throw new Error(
        `generateMatrix: selection[${i}] is missing state0 or state1`,
      )
    }
  }
  if (config.stakePerSlip <= 0) {
    throw new Error(
      `generateMatrix: stakePerSlip must be > 0, got ${config.stakePerSlip}`,
    )
  }
  if (config.numAccounts !== 6 && config.numAccounts !== 7) {
    throw new Error(
      `generateMatrix: numAccounts must be 6 or 7, got ${config.numAccounts}`,
    )
  }

  // --- Generate each tier ---
  const coreSlips  = generateCoreSlips(selections, config.stakePerSlip)         // 30
  const pivotSlips = generatePivotSlips(selections, config.stakePerSlip, 31)    //  8
  const chaosSlips = generateChaosSlips(selections, config.stakePerSlip, 39)    //  4

  const allSlips = [...coreSlips, ...pivotSlips, ...chaosSlips]

  // --- Postcondition assertion ---
  if (allSlips.length !== 42) {
    throw new Error(
      `generateMatrix: expected 42 slips, got ${allSlips.length}`,
    )
  }

  return allSlips
}
