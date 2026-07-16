/**
 * Property-based tests for the SSM matrix generator.
 *
 * v3.1: 56 slips — 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS
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

describe('Property 1: Slip Count Completeness', () => {
  it('always returns exactly 56 slips', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        expect(slips).toHaveLength(56)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 2: Tier Distribution Invariant ─────────────────────────────────

describe('Property 2: Tier Distribution Invariant', () => {
  it('always produces 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS slips', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        expect(slips.filter(s => s.tier === 'CORE').length).toBe(30)
        expect(slips.filter(s => s.tier === 'PIVOT').length).toBe(8)
        expect(slips.filter(s => s.tier === 'BRIDGE').length).toBe(14)
        expect(slips.filter(s => s.tier === 'CHAOS').length).toBe(4)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 3: Pivot Uniqueness ────────────────────────────────────────────

describe('Property 3: Pivot Uniqueness', () => {
  it('each pivot slip has exactly one state=1 leg, covering indices 0–7 exactly once', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        const pivotSlips = slips.filter(s => s.tier === 'PIVOT')

        for (const slip of pivotSlips) {
          expect(slip.legs.filter(l => l.state === 1)).toHaveLength(1)
        }

        const inversionIndices = pivotSlips.map(slip => slip.legs.findIndex(l => l.state === 1))
        expect([...inversionIndices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 3b: Bridge flip counts ─────────────────────────────────────────

describe('Property 3b: Bridge Slip Flip Counts', () => {
  it('first 12 bridge slips have exactly 3 state=1 legs; last 2 have exactly 4', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        const bridgeSlips = slips.filter(s => s.tier === 'BRIDGE')

        expect(bridgeSlips).toHaveLength(14)

        // First 12 are three-flip
        for (let i = 0; i < 12; i++) {
          const flips = bridgeSlips[i].legs.filter(l => l.state === 1).length
          expect(flips).toBe(3)
        }
        // Last 2 are four-flip
        for (let i = 12; i < 14; i++) {
          const flips = bridgeSlips[i].legs.filter(l => l.state === 1).length
          expect(flips).toBe(4)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 4: Leg Count and Odds Fidelity ─────────────────────────────────

describe('Property 4: Leg Count and Odds Fidelity', () => {
  it('every slip has 8 legs with odds matching state0 or state1', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)

        for (const slip of slips) {
          expect(slip.legs).toHaveLength(8)

          for (const leg of slip.legs) {
            const sel = selections[leg.matchIndex]
            if (leg.state === 0) {
              expect(leg.odds).toBe(sel.state0.value)
            } else {
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

describe('Property 5: Combined Odds Correctness', () => {
  it('combinedOdds equals the product of all 8 leg odds', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips = generateMatrix(selections, config)
        for (const slip of slips) {
          const product = slip.legs.reduce((acc, leg) => acc * leg.odds, 1)
          expect(slip.combinedOdds).toBeCloseTo(product, 9)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 6: Matrix Determinism ─────────────────────────────────────────

describe('Property 6: Matrix Determinism', () => {
  it('two calls with identical input produce structurally identical state vectors', () => {
    fc.assert(
      fc.property(selectionsArb, configArb, (selections, config) => {
        const slips1 = generateMatrix(selections, config)
        const slips2 = generateMatrix(selections, config)

        expect(slips1).toHaveLength(slips2.length)
        for (let i = 0; i < slips1.length; i++) {
          expect(slips1[i].tier).toBe(slips2[i].tier)
          expect(slips1[i].legs.map(l => l.state)).toEqual(slips2[i].legs.map(l => l.state))
        }
      }),
      { numRuns: 200 },
    )
  })
})
