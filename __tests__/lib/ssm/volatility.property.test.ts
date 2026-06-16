import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { computeVolatility } from '../../../lib/ssm/volatility'
import type { OddsValue } from '../../../lib/ssm/types'

/** Helper to build a minimal OddsValue mock with only the `value` field needed */
function odds(value: number): OddsValue {
  return { value } as OddsValue
}

/** fc.float requires 32-bit float boundaries */
const F_MIN = Math.fround(0.01)
const F_MAX = Math.fround(100)
const F_MAX_10 = Math.fround(10)
const F_MAX_1 = Math.fround(1)

// ---------------------------------------------------------------------------
// Property 15: Volatility Score Correctness
// Validates: Requirements 10.1, 10.2, 10.3
// ---------------------------------------------------------------------------
describe('Property 15: Volatility Score Correctness', () => {
  it('result is always in [0.0, 1.0] for any positive state0 and state1', () => {
    fc.assert(
      fc.property(
        fc.float({ min: F_MIN, max: F_MAX, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: F_MIN, max: F_MAX, noNaN: true, noDefaultInfinity: true }),
        (s0, s1) => {
          const result = computeVolatility(odds(s0), odds(s1))
          expect(result).toBeGreaterThanOrEqual(0.0)
          expect(result).toBeLessThanOrEqual(1.0)
        }
      )
    )
  })

  it('matches the formula (clamp(ratio, 1, 10) - 1) / 9 for any positive inputs', () => {
    fc.assert(
      fc.property(
        fc.float({ min: F_MIN, max: F_MAX, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: F_MIN, max: F_MAX, noNaN: true, noDefaultInfinity: true }),
        (s0, s1) => {
          const ratio = s1 / s0
          const clamped = Math.min(Math.max(ratio, 1.0), 10.0)
          const expected = (clamped - 1.0) / 9.0

          const result = computeVolatility(odds(s0), odds(s1))
          expect(result).toBeCloseTo(expected, 10)
        }
      )
    )
  })

  it('ratio = 1.0 maps to exactly 0.0 (state1 === state0)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: F_MIN, max: F_MAX, noNaN: true, noDefaultInfinity: true }),
        (v) => {
          // When state1 === state0, ratio = 1.0 → result = 0.0
          const result = computeVolatility(odds(v), odds(v))
          expect(result).toBe(0.0)
        }
      )
    )
  })

  it('ratio >= 10.0 maps to exactly 1.0', () => {
    fc.assert(
      fc.property(
        fc.float({ min: F_MIN, max: F_MAX_10, noNaN: true, noDefaultInfinity: true }),
        // multiplier >= 1 guarantees ratio = s1/s0 >= 10
        fc.float({ min: F_MAX_1, max: F_MAX_10, noNaN: true, noDefaultInfinity: true }),
        (s0, multiplier) => {
          const s1 = s0 * 10 * multiplier // ratio = 10 * multiplier >= 10
          const result = computeVolatility(odds(s0), odds(s1))
          expect(result).toBe(1.0)
        }
      )
    )
  })
})

// ---------------------------------------------------------------------------
// Boundary unit tests
// ---------------------------------------------------------------------------
describe('computeVolatility – boundary unit tests', () => {
  it('ratio = 1.0 → 0.0  (same odds, e.g. 2.0 vs 2.0)', () => {
    expect(computeVolatility(odds(2.0), odds(2.0))).toBe(0.0)
  })

  it('ratio = 10.0 → 1.0  (1.0 vs 10.0)', () => {
    expect(computeVolatility(odds(1.0), odds(10.0))).toBe(1.0)
  })

  it('ratio = 100.0 clamped to 10 → 1.0  (1.0 vs 100.0)', () => {
    expect(computeVolatility(odds(1.0), odds(100.0))).toBe(1.0)
  })

  it('ratio = 2.75 → approx 0.194  (2.0 vs 5.5)', () => {
    // ratio = 5.5 / 2.0 = 2.75 → (2.75 - 1) / 9 ≈ 0.19444...
    expect(computeVolatility(odds(2.0), odds(5.5))).toBeCloseTo((2.75 - 1) / 9, 10)
  })
})
