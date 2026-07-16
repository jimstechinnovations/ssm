// lib/ssm/generator.ts
// Pure 56-slip SSM matrix generator. No I/O, no side effects.
//
// v3.1: Added BRIDGE tier (14 slips) covering three-flip and four-flip
// midpoint combinations — fills the statistical gap between PIVOT (single-flip)
// and CHAOS (all-flip) that was the primary loss scenario in v3.
//
// Slip structure:
//   CORE   slips  1–30  (30) — all-dominant + single-flip + two-flip
//   PIVOT  slips 31–38  ( 8) — N-1 error-correcting single-flips
//   BRIDGE slips 39–52  (14) — 12 three-flip + 2 four-flip midpoints (NEW)
//   CHAOS  slips 53–56  ( 4) — extreme anchors

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
// generateBridgeSlips — 14 slips (Tier 3 — NEW in v3.1)
// ---------------------------------------------------------------------------

/**
 * Generates the 14 BRIDGE slips covering the statistical gap between
 * single-flip (PIVOT) and all-flip (CHAOS).
 *
 * Three-flip coverage (12 slips):
 *   All C(8,3)=56 three-flip combinations ranked by sum of volatility of the
 *   three flipped positions (ascending). Take the 12 lowest — these are the
 *   most probable three-flip patterns for the specific game set.
 *
 * Four-flip midpoint coverage (2 slips):
 *   The two lowest-volatility four-flip combinations (from C(8,4)=70 candidates).
 *   These cover the most likely 4/4 split sessions.
 *
 * slipId 39–52, tier 'BRIDGE'
 *
 * Why 14: 12 three-flip + 2 four-flip = 14. At ₦10,000 bankroll this gives
 * exactly ₦100/slip (the Nigerian bookmaker minimum) via the 14% allocation.
 */
export function generateBridgeSlips(
  selections: MatchSelection[],
  stakePerSlip: number,
  startId = 39,
): Slip[] {
  interface FlipCandidate {
    v: (0 | 1)[]
    score: number
  }

  // ── Three-flip candidates: C(8,3) = 56 combinations ──────────────────────
  const threeFlipCandidates: FlipCandidate[] = []

  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 7; j++) {
      for (let k = j + 1; k < 8; k++) {
        const v: (0 | 1)[] = [0, 0, 0, 0, 0, 0, 0, 0]
        v[i] = 1
        v[j] = 1
        v[k] = 1
        const score = selections[i].volatility + selections[j].volatility + selections[k].volatility
        threeFlipCandidates.push({ v, score })
      }
    }
  }

  // Sort ascending — lowest volatility sum = most probable three-flip pattern
  threeFlipCandidates.sort((a, b) => a.score - b.score)
  const top12ThreeFlip = threeFlipCandidates.slice(0, 12)

  // ── Four-flip candidates: C(8,4) = 70 combinations ───────────────────────
  const fourFlipCandidates: FlipCandidate[] = []

  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 6; j++) {
      for (let k = j + 1; k < 7; k++) {
        for (let l = k + 1; l < 8; l++) {
          const v: (0 | 1)[] = [0, 0, 0, 0, 0, 0, 0, 0]
          v[i] = 1
          v[j] = 1
          v[k] = 1
          v[l] = 1
          const score =
            selections[i].volatility + selections[j].volatility +
            selections[k].volatility + selections[l].volatility
          fourFlipCandidates.push({ v, score })
        }
      }
    }
  }

  fourFlipCandidates.sort((a, b) => a.score - b.score)
  const top2FourFlip = fourFlipCandidates.slice(0, 2)

  // ── Combine and build slips ───────────────────────────────────────────────
  const allVectors = [...top12ThreeFlip, ...top2FourFlip]

  if (allVectors.length !== 14) {
    throw new Error(`generateBridgeSlips: expected 14 vectors, got ${allVectors.length}`)
  }

  return allVectors.map((candidate, idx) => {
    const legs = buildLegs(selections, candidate.v)
    const combinedOdds = productOfLegs(legs)
    return {
      slipId:          startId + idx,
      tier:            'BRIDGE' as const,
      tierIndex:       idx + 1,
      legs,
      combinedOdds,
      stake:           stakePerSlip,
      potentialPayout: combinedOdds * stakePerSlip,
      sessionHash:     '',
    }
  })
}



/**
 * Generates the 4 CHAOS slips.
 *
 * Chaos slip 53 (idx 0): all 8 legs state 1 (full contrarian)
 * Chaos slip 54 (idx 1): top 4 volatile legs → OVER_UNDER_1.5 if available; else state 1
 * Chaos slip 55 (idx 2): even parity — positions 0,2,4,6 use state 1; odd use state 0
 * Chaos slip 56 (idx 3): top 4 volatile → state 1; bottom 4 → state 0
 *
 * slipId 53–56, tier 'CHAOS'
 */
export function generateChaosSlips(
  selections: MatchSelection[],
  stakePerSlip: number,
  startId = 53,
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
 * Generates the complete 56-slip SSM matrix (v3.1).
 *
 * Slip structure:
 *   CORE   1–30  (30 slips) — dominant coverage + two-flip pairs
 *   PIVOT  31–38 ( 8 slips) — N-1 single-flip error-correcting
 *   BRIDGE 39–52 (14 slips) — three-flip + four-flip midpoint coverage (NEW)
 *   CHAOS  53–56 ( 4 slips) — extreme/all-breakout anchors
 *
 * Total: 56 slips
 *
 * Note: slips are returned with sessionHash = '' — the generate route handler
 * assigns sessionHash after account distribution.
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
  const coreSlips   = generateCoreSlips(selections, config.stakePerSlip)          // 30, ids  1–30
  const pivotSlips  = generatePivotSlips(selections, config.stakePerSlip, 31)     //  8, ids 31–38
  const bridgeSlips = generateBridgeSlips(selections, config.stakePerSlip, 39)    // 14, ids 39–52
  const chaosSlips  = generateChaosSlips(selections, config.stakePerSlip, 53)     //  4, ids 53–56

  const allSlips = [...coreSlips, ...pivotSlips, ...bridgeSlips, ...chaosSlips]

  // --- Postcondition assertion ---
  if (allSlips.length !== 56) {
    throw new Error(
      `generateMatrix: expected 56 slips, got ${allSlips.length}`,
    )
  }

  return allSlips
}
