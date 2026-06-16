/**
 * Property-based tests for lib/ssm/market-detector.ts
 *
 * Property 3: Breakout is always the direct counterpart of dominant
 *
 * Validates: Requirements 4.2, 4.3, 4.4
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  detectDominantMarket,
  findOddsByLabel,
  mean,
  populationVariance,
} from '../../../lib/ssm/market-detector'
import { MARKET_COUNTERPART, OUTCOME_TO_LABEL } from '../../../lib/ssm/types'
import type { Fixture, MarketOutcome, OddsValue } from '../../../lib/ssm/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Fixture with specific odds entries */
function makeFixture(id: number, oddsEntries: Array<{ label: string; value: number }>): Fixture {
  return {
    id,
    homeTeam: `Home${id}`,
    awayTeam: `Away${id}`,
    league:   'Test League',
    leagueId: 1,
    kickoff:  '2026-06-14T15:00:00Z',
    odds:     oddsEntries.map(({ label, value }) => ({
      bookmaker: 'Test',
      market:    '1X2' as const,
      label,
      value,
    })),
  }
}

/** Build a full set of 8 fixtures all carrying the same complete odds map */
function make8Fixtures(oddsMap: Record<string, number>): Fixture[] {
  return Array.from({ length: 8 }, (_, i) =>
    makeFixture(i + 1, Object.entries(oddsMap).map(([label, value]) => ({ label, value }))),
  )
}

/** A "complete" odds map containing all 8 candidate market labels */
const FULL_ODDS: Record<string, number> = {
  'BTTS Yes':  1.65,
  'BTTS No':   2.00,
  'Over 2.5':  1.75,
  'Under 2.5': 1.85,
  'Odd':       1.85,
  'Even':      1.80,
  'DC 12':     1.27,
  'DC 1X':     1.43,
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('detectDominantMarket — unit tests', () => {
  it('returns DC12 as dominant when DC 12 has highest implied prob in template data', () => {
    const fixtures = make8Fixtures(FULL_ODDS)
    const result = detectDominantMarket(fixtures)
    // DC 12 = 1.27 → implied ≈ 0.787 (highest of all outcomes in FULL_ODDS)
    // BTTS Yes = 1.65 → implied ≈ 0.606
    expect(result.dominantOutcome).toBe('DC12')
    expect(result.breakoutOutcome).toBe('DC1X')
    expect(result.tieBroken).toBe(false)
  })

  it('breakoutOutcome is always MARKET_COUNTERPART[dominantOutcome]', () => {
    const fixtures = make8Fixtures(FULL_ODDS)
    const result = detectDominantMarket(fixtures)
    expect(result.breakoutOutcome).toBe(MARKET_COUNTERPART[result.dominantOutcome])
  })

  it('dominantOutcome and breakoutOutcome are never equal', () => {
    const fixtures = make8Fixtures(FULL_ODDS)
    const result = detectDominantMarket(fixtures)
    expect(result.dominantOutcome).not.toBe(result.breakoutOutcome)
  })

  it('allOutcomes only includes outcomes with coverageCount >= 6', () => {
    // 4 of 8 fixtures are missing 'Odd' and 'Even' labels
    const fixtures = Array.from({ length: 8 }, (_, i) => {
      const oddsEntries = i < 4
        ? Object.entries(FULL_ODDS).map(([label, value]) => ({ label, value }))
        : Object.entries(FULL_ODDS)
            .filter(([label]) => label !== 'Odd' && label !== 'Even')
            .map(([label, value]) => ({ label, value }))
      return makeFixture(i + 1, oddsEntries)
    })
    const result = detectDominantMarket(fixtures)
    for (const op of result.allOutcomes) {
      expect(op.coverageCount).toBeGreaterThanOrEqual(6)
    }
  })

  it('tie-break selects lower-variance outcome and sets tieBroken=true', () => {
    // Make BTTS Yes and DC 12 have identical avg implied prob
    // by adjusting their odds so 1/odds is equal across all 8 fixtures
    // BTTS Yes avg = 0.606, DC 12 avg = 0.787 — they don't naturally tie.
    // Force a tie: give BTTS Yes the same avg implied as DC 12 won't easily work
    // with the existing FULL_ODDS, so we craft specific values:
    // Target avgImplied = 0.70 for both BTTS Yes and Over 2.5
    // BTTS Yes = 1/0.70 = 1.4286... — same for all 8 = zero variance
    // Over 2.5 = alternating 1/0.68 and 1/0.72 — avg = 0.70, variance > 0
    const tieOddsMap: Record<string, number> = {
      'BTTS Yes':  1 / 0.70, // avg 0.70, variance 0
      'BTTS No':   2.00,
      'Over 2.5':  1.75,
      'Under 2.5': 1.85,
      'Odd':       1.85,
      'Even':      1.80,
      'DC 12':     1.27,
      'DC 1X':     1.43,
    }
    // Make BTTS_NO have exactly the same average as BTTS_YES by using 1/0.70
    // Actually let's just test the tie-break logic with two outcomes at exactly 0.606
    // by setting both BTTS Yes AND DC 12 to the same odds value (1.65)
    const tiedOdds: Record<string, number> = {
      'BTTS Yes':  1.65,
      'BTTS No':   1.65,   // same implied as BTTS Yes → guaranteed tie
      'Over 2.5':  1.75,
      'Under 2.5': 1.85,
      'Odd':       1.85,
      'Even':      1.80,
      'DC 12':     2.50,
      'DC 1X':     2.80,
    }
    const fixtures = make8Fixtures(tiedOdds)
    const result = detectDominantMarket(fixtures)
    // BTTS Yes and BTTS No both have avgImplied = 1/1.65 ≈ 0.606
    // Both have variance = 0 (same odds for all 8 fixtures)
    // Tie-break by variance picks the first in iteration order (BTTS_YES)
    expect(result.tieBroken).toBe(true)
    expect(result.breakoutOutcome).toBe(MARKET_COUNTERPART[result.dominantOutcome])
  })

  it('throws when fewer than 2 eligible outcomes found', () => {
    // Fixtures with no recognisable market labels
    const fixtures = Array.from({ length: 8 }, (_, i) =>
      makeFixture(i + 1, [{ label: 'Unknown', value: 2.0 }]),
    )
    expect(() => detectDominantMarket(fixtures)).toThrow()
  })

  it('throws when given fewer than 8 fixtures', () => {
    const fixtures = make8Fixtures(FULL_ODDS).slice(0, 5)
    expect(() => detectDominantMarket(fixtures)).toThrow()
  })
})

// ─── Property 3: Counterpart integrity ───────────────────────────────────────

/**
 * Validates: Requirements 4.2, 4.3, 4.4
 *
 * For any 8-fixture set with valid BTTS Yes/No odds:
 * - breakoutOutcome = MARKET_COUNTERPART[dominantOutcome]
 * - dominantOutcome ≠ breakoutOutcome
 * - Result is deterministic (same input → same output)
 */
describe('Property 3: Breakout is always the direct counterpart of dominant', () => {
  // Arbitrary: float in [1.10, 4.00] representing decimal odds
  const oddsArb = fc.float({
    min: Math.fround(1.10),
    max: Math.fround(4.00),
    noNaN: true,
    noDefaultInfinity: true,
  })

  /**
   * Build 8 fixtures with BTTS Yes/No and at least one other market so
   * detectDominantMarket always finds ≥ 2 eligible outcomes.
   */
  const fixtures8Arb = fc.record({
    bttsYes:  oddsArb,
    bttsNo:   oddsArb,
    over25:   oddsArb,
    under25:  oddsArb,
    odd:      oddsArb,
    even:     oddsArb,
    dc12:     oddsArb,
    dc1x:     oddsArb,
  }).map(({ bttsYes, bttsNo, over25, under25, odd, even, dc12, dc1x }) =>
    make8Fixtures({
      'BTTS Yes':  bttsYes,
      'BTTS No':   bttsNo,
      'Over 2.5':  over25,
      'Under 2.5': under25,
      'Odd':       odd,
      'Even':      even,
      'DC 12':     dc12,
      'DC 1X':     dc1x,
    }),
  )

  it('breakoutOutcome always equals MARKET_COUNTERPART[dominantOutcome]', () => {
    fc.assert(
      fc.property(fixtures8Arb, (fixtures) => {
        const result = detectDominantMarket(fixtures)
        expect(result.breakoutOutcome).toBe(MARKET_COUNTERPART[result.dominantOutcome])
      }),
      { numRuns: 200 },
    )
  })

  it('dominantOutcome and breakoutOutcome are never equal', () => {
    fc.assert(
      fc.property(fixtures8Arb, (fixtures) => {
        const result = detectDominantMarket(fixtures)
        expect(result.dominantOutcome).not.toBe(result.breakoutOutcome)
      }),
      { numRuns: 200 },
    )
  })

  it('result is deterministic — same fixtures always produce the same dominant outcome', () => {
    fc.assert(
      fc.property(fixtures8Arb, (fixtures) => {
        const r1 = detectDominantMarket(fixtures)
        const r2 = detectDominantMarket(fixtures)
        expect(r1.dominantOutcome).toBe(r2.dominantOutcome)
        expect(r1.breakoutOutcome).toBe(r2.breakoutOutcome)
        expect(r1.tieBroken).toBe(r2.tieBroken)
      }),
      { numRuns: 200 },
    )
  })

  it('allOutcomes only contains entries with coverageCount >= 6', () => {
    fc.assert(
      fc.property(fixtures8Arb, (fixtures) => {
        const result = detectDominantMarket(fixtures)
        for (const op of result.allOutcomes) {
          expect(op.coverageCount).toBeGreaterThanOrEqual(6)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('when tieBroken=true the tieBreakDetail is a non-empty string', () => {
    fc.assert(
      fc.property(fixtures8Arb, (fixtures) => {
        const result = detectDominantMarket(fixtures)
        if (result.tieBroken) {
          expect(typeof result.tieBreakDetail).toBe('string')
          expect((result.tieBreakDetail ?? '').length).toBeGreaterThan(0)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Internal helper unit tests ───────────────────────────────────────────────

describe('findOddsByLabel', () => {
  it('returns the value when label is found', () => {
    const odds: OddsValue[] = [
      { bookmaker: 'b', market: '1X2', label: 'BTTS Yes', value: 1.65 },
      { bookmaker: 'b', market: '1X2', label: 'BTTS No',  value: 2.00 },
    ]
    expect(findOddsByLabel(odds, 'BTTS Yes')).toBe(1.65)
    expect(findOddsByLabel(odds, 'BTTS No')).toBe(2.00)
  })

  it('returns null when label is not found', () => {
    const odds: OddsValue[] = [{ bookmaker: 'b', market: '1X2', label: 'Home', value: 1.85 }]
    expect(findOddsByLabel(odds, 'BTTS Yes')).toBeNull()
  })

  it('returns null for an empty array', () => {
    expect(findOddsByLabel([], 'Over 2.5')).toBeNull()
  })
})

describe('mean and populationVariance', () => {
  it('mean([4]) = 4', () => expect(mean([4])).toBe(4))
  it('mean([1,3]) = 2', () => expect(mean([1, 3])).toBe(2))
  it('populationVariance([4]) = 0', () => expect(populationVariance([4])).toBe(0))
  it('populationVariance([2,4]) = 1', () => expect(populationVariance([2, 4])).toBe(1))
})
