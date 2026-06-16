import type { OddsValue } from './types'

/**
 * Computes a normalised volatility score [0.0, 1.0] for a fixture
 * based on the ratio of State 1 (breakout) to State 0 (dominant) odds.
 *
 * Formula: (clamp(state1.value / state0.value, 1.0, 10.0) - 1.0) / 9.0
 *
 * Edge cases:
 * - If state0.value is 0, return 1.0 (maximum volatility)
 * - ratio = 1.0 → returns 0.0
 * - ratio >= 10.0 → returns 1.0
 */
export function computeVolatility(state0: OddsValue, state1: OddsValue): number {
  if (state0.value === 0) return 1.0
  const ratio = state1.value / state0.value
  const clamped = Math.min(Math.max(ratio, 1.0), 10.0)
  return (clamped - 1.0) / 9.0
}
