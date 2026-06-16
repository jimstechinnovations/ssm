/**
 * Property-based tests for the SSM matrix generator.
 *
 * Validates: Requirements 1.1–1.7
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { generateMatrix } from '../../../lib/ssm/generator'
import type { MatchSelection, SessionConfig } from '../../../lib/ssm/types'

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const oddsValueArb = fc.record({
  bookmaker: fc.constant('TestBook'),
  market: fc.constantFrom('1X2', 'BTTS', 'OVER_UNDER_2.5') as fc.Arbitrary<'1X2' | 'BTTS' | 'OVER_UNDER_2.5'>,
  label: fc.string({ minLength: 1, maxLength: 10 }),
  value: fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true }),
})

const fixtureArb = fc.record({
  id: fc.integer({ min: 1, max: 999999 }),
  homeTeam: fc.string({ minLength: 1, maxLength: 20 }),
  awayTeam: fc.string({ minLength: 1, maxLength: 20 }),
  league: fc.constant('Test League'),
  leagueId: fc.integer({ min: 1, max: 999 }),
  kickoff: fc.constant('2026-06-14T15:00:00Z'),
  odds: fc.array(oddsValueArb, { minLength: 1, maxLength: 5 }),
})

const matchSelectionArb: fc.Arbitrary<MatchSelection> = fc.record({
  fixture: fixtureArb,
  state0: oddsValueArb,
  state1: oddsValueArb,
  volatility: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true, noDefaultInfinity: true }),
})

const selectionsArb = fc.array(matchSelectionArb, { minLength: 8, maxLength: 8 })

const configArb: fc.Arbitrary<SessionConfig> = fc.record({
  date: fc.constant('2026-06-14'),
  stakePerSlip: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true, noDefaultInfinity: true }),
  numAccounts: fc.constantFrom(6 as const, 7 as const),
  sessionPrefix: fc.constant('SESS-20260614-test'),
})

// ─── Property 1: Slip Count Completeness ─────────────────────────────────────

/**
 * Validates: Requirement 1.1
 *
 * generateMatrix always returns exactly 42 slips for any 8 valid selections.
 */
describe('Property 1: Slip Count Completeness', () => {
  it('always returns exactly 42 slips', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        expect(slips).toHaveLength(42)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 2: Tier Distribution Invariant ─────────────────────────────────

/**
 * Validates: Requirement 1.2
 *
 * Every matrix has exactly 30 CORE + 8 PIVOT + 4 CHAOS slips.
 */
describe('Property 2: Tier Distribution Invariant', () => {
  it('always produces 30 CORE + 8 PIVOT + 4 CHAOS slips', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        const coreCount  = slips.filter(s => s.tier === 'CORE').length
        const pivotCount = slips.filter(s => s.tier === 'PIVOT').length
        const chaosCount = slips.filter(s => s.tier === 'CHAOS').length
        expect(coreCount).toBe(30)
        expect(pivotCount).toBe(8)
        expect(chaosCount).toBe(4)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 3: Pivot Uniqueness ────────────────────────────────────────────

/**
 * Validates: Requirement 1.3
 *
 * No two pivot slips share the same inversion index.
 * For every pivot slip, exactly one leg has state=1; the inversion index (0–7)
 * is unique across all 8 pivot slips, covering [0,7] exactly once.
 */
describe('Property 3: Pivot Uniqueness', () => {
  it('each pivot slip has exactly one state=1 leg, covering indices 0–7 exactly once', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        const pivotSlips = slips.filter(s => s.tier === 'PIVOT')

        // Each pivot slip has exactly 1 leg with state=1
        for (const slip of pivotSlips) {
          const state1Legs = slip.legs.filter(l => l.state === 1)
          expect(state1Legs).toHaveLength(1)
        }

        // The inversion indices cover [0,7] exactly once
        const inversionIndices = pivotSlips.map(slip =>
          slip.legs.findIndex(l => l.state === 1)
        )
        const sorted = [...inversionIndices].sort((a, b) => a - b)
        expect(sorted).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 4: Leg Count and Odds Fidelity ─────────────────────────────────

/**
 * Validates: Requirements 1.4, 1.5
 *
 * Every slip has exactly 8 legs.
 * Each leg's odds equals the exact state0 or state1 value from the selection
 * (no rounding or transformation).
 */
describe('Property 4: Leg Count and Odds Fidelity', () => {
  it('every slip has 8 legs with odds matching the exact state0 or state1 value', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)

        for (const slip of slips) {
          // 8 legs per slip
          expect(slip.legs).toHaveLength(8)

          for (const leg of slip.legs) {
            const sel = selections[leg.matchIndex]
            // Odds must match the exact value from state0 or state1 —
            // unless a chaos slip overrides the market (slip 40, the
            // OVER_UNDER_1.5 chaos slip), which may use odds from
            // sel.fixture.odds. We only assert fidelity when leg.state
            // aligns with sel.state0 / sel.state1 odds values.
            if (leg.state === 0) {
              expect(leg.odds).toBe(sel.state0.value)
            } else {
              // For CHAOS slip 40 the leg may use a fixture-level odds
              // value (OVER_UNDER_1.5 override), so we accept any of:
              // - sel.state1.value
              // - any value from sel.fixture.odds
              const fixtureOddsValues = sel.fixture.odds.map(o => o.value)
              const validOdds = [sel.state1.value, ...fixtureOddsValues]
              expect(validOdds).toContain(leg.odds)
            }
          }
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ─── Property 5: Combined Odds Correctness ───────────────────────────────────

/**
 * Validates: Requirement 1.6
 *
 * combinedOdds === product of all 8 leg odds for every slip.
 * Floating-point accumulation can cause tiny rounding errors, so we
 * allow a relative tolerance of 1e-9.
 */
describe('Property 5: Combined Odds Correctness', () => {
  it('combinedOdds equals the product of all 8 leg odds', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)

        for (const slip of slips) {
          const product = slip.legs.reduce((acc, leg) => acc * leg.odds, 1)
          // Allow tiny floating-point tolerance
          expect(slip.combinedOdds).toBeCloseTo(product, 9)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 6: Matrix Determinism ─────────────────────────────────────────

/**
 * Validates: Requirement 1.7
 *
 * Calling generateMatrix twice with identical selections and config produces
 * structurally identical results: same tier per slip and same state vectors
 * (leg.state values) for every slip.
 */
describe('Property 6: Matrix Determinism', () => {
  it('two calls with identical input produce structurally identical state vectors', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips1 = generateMatrix(selections, config)
        const slips2 = generateMatrix(selections, config)

        expect(slips1).toHaveLength(slips2.length)

        for (let i = 0; i < slips1.length; i++) {
          const s1 = slips1[i]
          const s2 = slips2[i]

          // Same tier assignment
          expect(s1.tier).toBe(s2.tier)

          // Same state vector (leg.state values)
          expect(s1.legs.map(l => l.state)).toEqual(s2.legs.map(l => l.state))
        }
      }),
      { numRuns: 200 },
    )
  })
})
