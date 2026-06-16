/**
 * Property-based tests for lib/ssm/gate-screener.ts
 *
 * Property 1: Qualification iff all gates pass
 * Property 2: Gate screener is deterministic and side-effect free
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { runGateScreener } from '../../../lib/ssm/gate-screener'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a Map with all 5 required keys. */
function buildOddsMap(
  over05: number,
  under05: number,
  bttsYes: number,
  bttsNo: number,
  dc12: number,
): Map<string, number> {
  return new Map([
    ['Over 0.5',  over05],
    ['Under 0.5', under05],
    ['BTTS Yes',  bttsYes],
    ['BTTS No',   bttsNo],
    ['DC 12',     dc12],
  ])
}

/** A known fully-passing odds set (based on the FK Sveikata template). */
const PASSING_MAP = buildOddsMap(1.03, 6.75, 1.65, 2.00, 1.27)

// ─── Unit tests: known values ─────────────────────────────────────────────────

describe('runGateScreener — unit tests', () => {
  it('qualifies a fixture that passes all four gates', () => {
    const result = runGateScreener(1, PASSING_MAP)
    expect(result.qualified).toBe(true)
    expect(result.gates).toHaveLength(4)
    expect(result.gates.every(g => g.passed)).toBe(true)
    expect(result.rejectReason).toBeUndefined()
  })

  it('rejects on G1 (Over 0.5 >= 1.15) and short-circuits — gates[] has only 1 entry', () => {
    const map = buildOddsMap(1.20, 6.75, 1.65, 2.00, 1.27)
    const result = runGateScreener(1, map)
    expect(result.qualified).toBe(false)
    expect(result.gates).toHaveLength(1)
    expect(result.gates[0].gate).toBe('G1')
    expect(result.gates[0].passed).toBe(false)
    expect(result.rejectReason).toBe('GATE_FAILURE')
  })

  it('rejects on G2 (Under 0.5 <= 5.00) and short-circuits — gates[] has 2 entries', () => {
    const map = buildOddsMap(1.03, 4.50, 1.65, 2.00, 1.27)
    const result = runGateScreener(1, map)
    expect(result.qualified).toBe(false)
    expect(result.gates).toHaveLength(2)
    expect(result.gates[1].gate).toBe('G2')
    expect(result.gates[1].passed).toBe(false)
    expect(result.rejectReason).toBe('GATE_FAILURE')
  })

  it('rejects on G3 (BTTS Yes out of range) and short-circuits — gates[] has 3 entries', () => {
    const map = buildOddsMap(1.03, 6.75, 1.90, 2.00, 1.27) // Yes too high
    const result = runGateScreener(1, map)
    expect(result.qualified).toBe(false)
    expect(result.gates).toHaveLength(3)
    expect(result.gates[2].gate).toBe('G3')
    expect(result.gates[2].passed).toBe(false)
  })

  it('rejects on G4 (DC 12 >= 1.40) — gates[] has 4 entries', () => {
    const map = buildOddsMap(1.03, 6.75, 1.65, 2.00, 1.55)
    const result = runGateScreener(1, map)
    expect(result.qualified).toBe(false)
    expect(result.gates).toHaveLength(4)
    expect(result.gates[3].gate).toBe('G4')
    expect(result.gates[3].passed).toBe(false)
  })

  it('returns ODDS_UNAVAILABLE when Over 0.5 is missing', () => {
    const map = new Map([['Under 0.5', 6.75], ['BTTS Yes', 1.65], ['BTTS No', 2.00], ['DC 12', 1.27]])
    const result = runGateScreener(42, map)
    expect(result.qualified).toBe(false)
    expect(result.rejectReason).toBe('ODDS_UNAVAILABLE')
    expect(result.gates).toHaveLength(0)
  })

  it('returns ODDS_UNAVAILABLE when DC 12 is missing (after G1–G3 pass)', () => {
    const map = new Map([['Over 0.5', 1.03], ['Under 0.5', 6.75], ['BTTS Yes', 1.65], ['BTTS No', 2.00]])
    const result = runGateScreener(99, map)
    expect(result.qualified).toBe(false)
    expect(result.rejectReason).toBe('ODDS_UNAVAILABLE')
    // G1, G2, G3 were evaluated before DC 12 lookup
    expect(result.gates).toHaveLength(3)
  })

  it('preserves the fixtureId in the returned GateResult', () => {
    expect(runGateScreener(12345, PASSING_MAP).fixtureId).toBe(12345)
    const failMap = buildOddsMap(2.0, 1.0, 3.0, 0.5, 2.0)
    expect(runGateScreener(99999, failMap).fixtureId).toBe(99999)
  })
})

// ─── Property 1: Qualification iff all four gates pass ───────────────────────

/**
 * Validates: Requirements 1.1, 1.2, 1.3
 *
 * result.qualified = true iff G1 ∧ G2 ∧ G3 ∧ G4 all pass.
 */
describe('Property 1: Qualification iff all gates pass', () => {
  const oddsArb = fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true })

  it('result.qualified matches the logical AND of all four gate conditions', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const map = buildOddsMap(over05, under05, bttsYes, bttsNo, dc12)
          const result = runGateScreener(1, map)

          const g1Pass = over05 < 1.15
          const g2Pass = under05 > 5.00
          const g3Pass = bttsYes >= 1.50 && bttsYes <= 1.80 && bttsNo >= 1.80 && bttsNo <= 2.20
          const g4Pass = dc12 < 1.40

          const allPass = g1Pass && g2Pass && g3Pass && g4Pass

          expect(result.qualified).toBe(allPass)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('gates.length <= 4 for any input', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const map = buildOddsMap(over05, under05, bttsYes, bttsNo, dc12)
          const result = runGateScreener(1, map)
          expect(result.gates.length).toBeLessThanOrEqual(4)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('when qualified=false, the last gate in gates[] is the failing one', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const map = buildOddsMap(over05, under05, bttsYes, bttsNo, dc12)
          const result = runGateScreener(1, map)

          if (!result.qualified && result.gates.length > 0) {
            const lastGate = result.gates[result.gates.length - 1]
            // All gates before the last must have passed
            const allButLast = result.gates.slice(0, -1)
            expect(allButLast.every(g => g.passed)).toBe(true)
            // The last gate must have failed
            expect(lastGate.passed).toBe(false)
          }
        },
      ),
      { numRuns: 500 },
    )
  })
})

// ─── Property 2: Determinism and no side effects ─────────────────────────────

/**
 * Validates: Requirements 1.1, 1.4
 *
 * Same oddsMap always produces the same GateResult.
 * The input map is not mutated.
 */
describe('Property 2: Gate screener is deterministic and side-effect free', () => {
  const oddsArb = fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true })

  it('produces identical results on two calls with the same input', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const map = buildOddsMap(over05, under05, bttsYes, bttsNo, dc12)
          const r1 = runGateScreener(1, map)
          const r2 = runGateScreener(1, map)
          expect(r1.qualified).toBe(r2.qualified)
          expect(r1.gates.length).toBe(r2.gates.length)
          expect(r1.rejectReason).toBe(r2.rejectReason)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('does not mutate the input Map', () => {
    fc.assert(
      fc.property(
        oddsArb, oddsArb, oddsArb, oddsArb, oddsArb,
        (over05, under05, bttsYes, bttsNo, dc12) => {
          const map = buildOddsMap(over05, under05, bttsYes, bttsNo, dc12)
          const originalSize = map.size
          const originalValues = Array.from(map.entries())

          runGateScreener(1, map)

          expect(map.size).toBe(originalSize)
          for (const [key, val] of originalValues) {
            expect(map.get(key)).toBe(val)
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
