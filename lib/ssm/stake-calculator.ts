/**
 * lib/ssm/stake-calculator.ts
 *
 * Pure bankroll-proportional stake allocation for SSM Builder v2.
 * Fixed tier ratios: Core 74%, Pivot 16%, Chaos 4%, Buffer 6%.
 * Per-slip stakes are floored to whole numbers; buffer absorbs rounding slack.
 *
 * No I/O, no side effects.
 *
 * Requirements: 5.2, 5.6, 5.7
 */

import type { TierAllocation } from './types'

// ─── Constants (fixed by the model — not user-configurable) ──────────────────

const CORE_RATIO  = 0.74
const PIVOT_RATIO = 0.16
const CHAOS_RATIO = 0.04
// Buffer = 0.06 — implied by: 1 - 0.74 - 0.16 - 0.04

const CORE_SLIP_COUNT  = 30
const PIVOT_SLIP_COUNT = 8
const CHAOS_SLIP_COUNT = 4

// ─── Stake Calculator ─────────────────────────────────────────────────────────

/**
 * Computes per-tier stakes from a total bankroll.
 *
 * Worked example at ₦10,000 default:
 *   Core:  floor(10000 × 0.74 / 30) = floor(246.67) = ₦246 per slip
 *   Pivot: floor(10000 × 0.16 / 8)  = floor(200.00) = ₦200 per slip
 *   Chaos: floor(10000 × 0.04 / 4)  = floor(100.00) = ₦100 per slip
 *   Staked: 246×30 + 200×8 + 100×4  = 7380 + 1600 + 400 = ₦9,380
 *   Buffer: 10000 - 9380 = ₦620
 *
 * @param bankroll  Total session bankroll (positive integer, default 10000)
 * @throws Error when bankroll ≤ 0
 * @throws Error when any per-slip stake floors to 0 (bankroll too small)
 */
export function calculateStakes(bankroll: number): TierAllocation {
  if (bankroll <= 0) {
    throw new Error(`calculateStakes: bankroll must be positive, got ${bankroll}`)
  }

  const coreStakePerSlip  = Math.floor(bankroll * CORE_RATIO  / CORE_SLIP_COUNT)
  const pivotStakePerSlip = Math.floor(bankroll * PIVOT_RATIO / PIVOT_SLIP_COUNT)
  const chaosStakePerSlip = Math.floor(bankroll * CHAOS_RATIO / CHAOS_SLIP_COUNT)

  if (coreStakePerSlip <= 0 || pivotStakePerSlip <= 0 || chaosStakePerSlip <= 0) {
    throw new Error(
      `calculateStakes: bankroll ₦${bankroll} is too small — ` +
      `one or more per-slip stakes floor to 0. Minimum bankroll is ₦${minBankroll()}.`,
    )
  }

  const totalStaked =
    coreStakePerSlip  * CORE_SLIP_COUNT +
    pivotStakePerSlip * PIVOT_SLIP_COUNT +
    chaosStakePerSlip * CHAOS_SLIP_COUNT

  const buffer = bankroll - totalStaked

  return {
    bankroll,
    coreStakePerSlip,
    pivotStakePerSlip,
    chaosStakePerSlip,
    buffer,
    total: bankroll,
  }
}

/**
 * Returns the minimum bankroll required so all per-slip stakes are ≥ 1.
 *
 * Core:  ceil(30 / 0.74)  = 41
 * Pivot: ceil(8  / 0.16)  = 50
 * Chaos: ceil(4  / 0.04)  = 100
 * Minimum = 100 (Chaos is the binding constraint).
 */
export function minBankroll(): number {
  return Math.max(
    Math.ceil(CORE_SLIP_COUNT  / CORE_RATIO),
    Math.ceil(PIVOT_SLIP_COUNT / PIVOT_RATIO),
    Math.ceil(CHAOS_SLIP_COUNT / CHAOS_RATIO),
  )
}
