/**
 * Property-based tests for lib/ssm/gate-screener.ts
 *
 * SSM v3: Gates replaced by adaptive profile classification.
 * runGateScreener is now a compatibility shim that always returns qualified=true.
 * The new profileFixture function is the primary API — tested here.
 *
 * Property 1: profileFixture always returns a valid GameProfile
 * Property 2: profileFixture is deterministic and side-effect free
 * Property 3: dominant/breakout outcomes are always valid counterparts
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { runGateScreener, profileFixture } from '../../../lib/ssm/gate-screener'
import { MARKET_COUNTERPART } from '../../../lib/ssm/types'
import type { Fixture, OddsValue, GameProfile } from '../../../lib/ssm/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_PROFILES: GameProfile[] = ['GOAL_CERTAIN', 'BALANCED', 'DEFENSIVE']

const MARKET_TYPE = 'OVER_UNDER_2.5' as const

/** Build a minimal Fixture with given odds labels */
function makeFixture(oddsEntries: { label: string; value: number }[]): Fixture {
  const odds: OddsValue[] = oddsEntries.map(e => ({
    bookmaker: 'test',
    market:    MARKET_TYPE,
    label:     e.label,
    value:     e.value,
  }))
  return {
    id:       1,
    homeTeam: 'A',
    awayTeam: 'B',
    league:   'Test',
    leagueId: 1,
    kickoff:  '2026-07-01T15:00:00Z',
    odds,
  }
}

/** A full odds set covering all gate-relevant markets */
function makeFullOddsFixture(
  over05: number,
  under05: number,
  bttsYes: number,
  bttsNo: number,
  dc12: number,
): Fixture {
  return makeFixture([
    { label: 'Over 0.5',  value: over05  },
    { label: 'Under 0.5', value: under05 },
    { label: 'BTTS Yes',  value: bttsYes },
    { label: 'BTTS No',   value: bttsNo  },
    { label: 'DC 12',     value: dc12    },
    { label: 'Over 2.5',  value: 1.90    },
    { label: 'Under 2.5', value: 1.95    },
  ])
}

// ─── Backward-compatibility shim tests ───────────────────────────────────────
//
// runGateScreener now always returns qualified=true (no rejection in v3).
// These tests verify the shim contract.

describe('runGateScreener — backward-compat shim (v3)', () => {
  it('always returns qualified=true regardless of odds', () => {
    const anyMap = new Map([
      ['Over 0.5', 2.50],   // would have failed G1 in v2
      ['Under 0.5', 1.20],  // would have failed G2 in v2
      ['BTTS Yes',  3.00],  // would have failed G3 in v2
      ['BTTS No',   1.10],  // would have failed G3 in v2
      ['DC 12',     2.50],  // would have failed G4 in v2
    ])
    const result = runGateScreener(1, anyMap)
    expect(result.qualified).toBe(true)
    expect(result.gates).toHaveLength(0)
    expect(result.rejectReason).toBeUndefined()
  })

  it('returns qualified=true even with empty odds map', () => {
    const result = runGateScreener(42, new Map())
    expect(result.qualified).toBe(true)
  })

  it('preserves the fixtureId', () => {
    expect(runGateScreener(99999, new Map()).fixtureId).toBe(99999)
  })
})

// ─── profileFixture — unit tests ─────────────────────────────────────────────

describe('profileFixture — unit tests', () => {
  it('returns GOAL_CERTAIN for a clear goal-certain fixture', () => {
    const fixture = makeFullOddsFixture(1.03, 6.75, 1.65, 2.00, 1.27)
    const profiled = profileFixture(fixture)
    expect(profiled.profile).toBe('GOAL_CERTAIN')
    expect(profiled.dominantOutcome).toBeTruthy()
    expect(profiled.breakoutOutcome).toBeTruthy()
    expect(profiled.dominantProb).toBeGreaterThan(0)
  })

  it('returns DEFENSIVE for a low-scoring fixture', () => {
    // Under 2.5 at 1.30 → clearly below DEFENSIVE_UNDER25_MAX (1.50) → DEFENSIVE
    // Build fixture manually so Under 2.5 is 1.30
    const fixture = makeFixture([
      { label: 'Over 0.5',  value: 1.35 },
      { label: 'Under 0.5', value: 3.50 },
      { label: 'BTTS Yes',  value: 2.10 },
      { label: 'BTTS No',   value: 1.65 },
      { label: 'DC 12',     value: 1.55 },
      { label: 'Over 2.5',  value: 3.20 },
      { label: 'Under 2.5', value: 1.30 }, // ← below DEFENSIVE_UNDER25_MAX=1.50
    ])
    const profiled = profileFixture(fixture)
    expect(profiled.profile).toBe('DEFENSIVE')
  })

  it('returns BALANCED for a typical open match', () => {
    // Over 0.5 at 1.22, Under 2.5 at 1.75 → balanced
    const fixture = makeFullOddsFixture(1.22, 3.25, 1.95, 1.75, 1.50)
    const profiled = profileFixture(fixture)
    expect(profiled.profile).toBe('BALANCED')
  })

  it('breakout is always the counterpart of dominant', () => {
    const fixture = makeFullOddsFixture(1.03, 6.75, 1.65, 2.00, 1.27)
    const profiled = profileFixture(fixture)
    expect(MARKET_COUNTERPART[profiled.dominantOutcome]).toBe(profiled.breakoutOutcome)
    expect(profiled.dominantOutcome).not.toBe(profiled.breakoutOutcome)
  })

  it('works with a fixture that has no odds at all', () => {
    const fixture = makeFixture([])
    // Should not throw — falls back to DC12/DC1X defaults
    const profiled = profileFixture(fixture)
    expect(profiled.profile).toBe('BALANCED')
    expect(profiled.dominantOutcome).toBeTruthy()
    expect(profiled.breakoutOutcome).toBeTruthy()
  })

  it('signals object reflects the actual fixture odds', () => {
    const fixture = makeFullOddsFixture(1.03, 6.75, 1.65, 2.00, 1.27)
    const { signals } = profileFixture(fixture)
    expect(signals.over05).toBe(1.03)
    expect(signals.under05).toBe(6.75)
    expect(signals.bttsYes).toBe(1.65)
    expect(signals.bttsNo).toBe(2.00)
    expect(signals.dc12).toBe(1.27)
  })
})

// ─── Property 1: Profile is always a valid GameProfile ───────────────────────

describe('Property 1: profileFixture always returns a valid profile', () => {
  const oddsArb = fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true })

  it('profile is always one of GOAL_CERTAIN | BALANCED | DEFENSIVE', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const fixture = makeFullOddsFixture(over05, under05, bttsYes, bttsNo, dc12)
          const profiled = profileFixture(fixture)
          expect(VALID_PROFILES).toContain(profiled.profile)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('dominantProb is always in (0, 1]', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const fixture = makeFullOddsFixture(over05, under05, bttsYes, bttsNo, dc12)
          const profiled = profileFixture(fixture)
          expect(profiled.dominantProb).toBeGreaterThan(0)
          expect(profiled.dominantProb).toBeLessThanOrEqual(1)
        },
      ),
      { numRuns: 500 },
    )
  })
})

// ─── Property 2: Determinism ──────────────────────────────────────────────────

describe('Property 2: profileFixture is deterministic and side-effect free', () => {
  const oddsArb = fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true })

  it('produces identical results on two calls with the same fixture', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const fixture = makeFullOddsFixture(over05, under05, bttsYes, bttsNo, dc12)
          const r1 = profileFixture(fixture)
          const r2 = profileFixture(fixture)
          expect(r1.profile).toBe(r2.profile)
          expect(r1.dominantOutcome).toBe(r2.dominantOutcome)
          expect(r1.breakoutOutcome).toBe(r2.breakoutOutcome)
          expect(r1.dominantProb).toBe(r2.dominantProb)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('does not mutate the input fixture', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const fixture = makeFullOddsFixture(over05, under05, bttsYes, bttsNo, dc12)
          const originalOddsLength = fixture.odds.length
          const originalFirstOdds  = fixture.odds[0]?.value

          profileFixture(fixture)

          expect(fixture.odds.length).toBe(originalOddsLength)
          if (originalFirstOdds !== undefined) {
            expect(fixture.odds[0].value).toBe(originalFirstOdds)
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ─── Property 3: Dominant/Breakout are always valid counterparts ──────────────

describe('Property 3: dominant and breakout are always valid counterparts', () => {
  const oddsArb = fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true })

  it('breakoutOutcome is always MARKET_COUNTERPART[dominantOutcome]', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const fixture  = makeFullOddsFixture(over05, under05, bttsYes, bttsNo, dc12)
          const profiled = profileFixture(fixture)
          expect(MARKET_COUNTERPART[profiled.dominantOutcome]).toBe(profiled.breakoutOutcome)
          expect(profiled.dominantOutcome).not.toBe(profiled.breakoutOutcome)
        },
      ),
      { numRuns: 500 },
    )
  })
})
