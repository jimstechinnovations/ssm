/**
 * lib/ssm/stake-calculator.ts
 *
 * Bankroll-proportional stake allocation for SSM Builder v3.1.
 *
 * Four-tier structure (56 slips total):
 *   CORE   60% — 30 slips (0-flip + single-flip + two-flip coverage)
 *   PIVOT  14% —  8 slips (single-flip error-correcting, N-1 guarantee)
 *   BRIDGE 14% — 14 slips (three-flip + four-flip midpoint coverage — NEW)
 *   CHAOS   6% —  4 slips (extreme/all-breakout anchors)
 *   Buffer  6%
 *
 * Nigerian bookmaker constraint: minimum stake per slip = ₦100.
 * Binding constraint: BRIDGE tier (14 slips × ₦100 / 0.14 = ₦10,000).
 * Minimum bankroll = ₦10,000.
 *
 * No I/O, no side effects.
 */

import type { TierAllocation } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const CORE_RATIO   = 0.60
const PIVOT_RATIO  = 0.14
const BRIDGE_RATIO = 0.14
const CHAOS_RATIO  = 0.06
// Buffer = 0.06 — implied by: 1 - 0.60 - 0.14 - 0.14 - 0.06

const CORE_SLIP_COUNT   = 30
const PIVOT_SLIP_COUNT  = 8
const BRIDGE_SLIP_COUNT = 14   // 12 three-flip + 2 four-flip midpoint
const CHAOS_SLIP_COUNT  = 4

/** Nigerian bookmaker minimum stake per slip */
export const MIN_STAKE_PER_SLIP = 100

// ─── Stake Calculator ─────────────────────────────────────────────────────────

/**
 * Computes per-tier stakes from a total bankroll.
 *
 * Worked example at ₦10,000 default (56 slips):
 *   Core:   floor(10000 × 0.60 / 30) = floor(200.00) = ₦200/slip  ✓
 *   Pivot:  floor(10000 × 0.14 / 8)  = floor(175.00) = ₦175/slip  ✓
 *   Bridge: floor(10000 × 0.14 / 14) = floor(100.00) = ₦100/slip  ✓ (exactly floor)
 *   Chaos:  floor(10000 × 0.06 / 4)  = floor(150.00) = ₦150/slip  ✓
 *
 *   Total staked: 200×30 + 175×8 + 100×14 + 150×4
 *               = 6,000 + 1,400 + 1,400 + 600 = ₦9,400
 *   Buffer: 10,000 - 9,400 = ₦600
 *
 * Minimum bankroll = ₦10,000 (BRIDGE is the binding constraint:
 *   ceil(14 × 100 / 0.14) = ₦10,000)
 *
 * @param bankroll  Total session bankroll (positive integer, minimum ₦10,000)
 */
export function calculateStakes(bankroll: number): TierAllocation {
  if (bankroll <= 0) {
    throw new Error(`calculateStakes: bankroll must be positive, got ${bankroll}`)
  }

  const min = minBankroll()
  if (bankroll < min) {
    throw new Error(
      `calculateStakes: bankroll ₦${bankroll} is below the minimum ₦${min}. ` +
      `Nigerian bookmakers require a minimum stake of ₦${MIN_STAKE_PER_SLIP} per slip. ` +
      `The minimum bankroll with 56 slips is ₦${min}.`,
    )
  }

  const coreStakePerSlip   = Math.floor(bankroll * CORE_RATIO   / CORE_SLIP_COUNT)
  const pivotStakePerSlip  = Math.floor(bankroll * PIVOT_RATIO  / PIVOT_SLIP_COUNT)
  const bridgeStakePerSlip = Math.floor(bankroll * BRIDGE_RATIO / BRIDGE_SLIP_COUNT)
  const chaosStakePerSlip  = Math.floor(bankroll * CHAOS_RATIO  / CHAOS_SLIP_COUNT)

  // Safety guard — should never fire given the minBankroll check above
  if (
    coreStakePerSlip   < MIN_STAKE_PER_SLIP ||
    pivotStakePerSlip  < MIN_STAKE_PER_SLIP ||
    bridgeStakePerSlip < MIN_STAKE_PER_SLIP ||
    chaosStakePerSlip  < MIN_STAKE_PER_SLIP
  ) {
    throw new Error(
      `calculateStakes: one or more per-slip stakes fall below ₦${MIN_STAKE_PER_SLIP}. ` +
      `Core: ₦${coreStakePerSlip}, Pivot: ₦${pivotStakePerSlip}, ` +
      `Bridge: ₦${bridgeStakePerSlip}, Chaos: ₦${chaosStakePerSlip}. ` +
      `Increase bankroll to at least ₦${min}.`,
    )
  }

  const totalStaked =
    coreStakePerSlip   * CORE_SLIP_COUNT   +
    pivotStakePerSlip  * PIVOT_SLIP_COUNT  +
    bridgeStakePerSlip * BRIDGE_SLIP_COUNT +
    chaosStakePerSlip  * CHAOS_SLIP_COUNT

  const buffer = bankroll - totalStaked

  return {
    bankroll,
    coreStakePerSlip,
    pivotStakePerSlip,
    bridgeStakePerSlip,
    chaosStakePerSlip,
    buffer,
    total: bankroll,
  }
}

/**
 * Returns the minimum bankroll so every per-slip stake is ≥ ₦100.
 *
 * Binding constraint analysis:
 *   Core:   ceil(30 × 100 / 0.60) = ₦5,000
 *   Pivot:  ceil(8  × 100 / 0.14) = ₦5,715
 *   Bridge: ceil(14 × 100 / 0.14) = ₦10,000  ← binding
 *   Chaos:  ceil(4  × 100 / 0.06) = ₦6,667
 *
 * Returns ₦10,000.
 */
export function minBankroll(): number {
  return Math.max(
    Math.ceil(CORE_SLIP_COUNT   * MIN_STAKE_PER_SLIP / CORE_RATIO),
    Math.ceil(PIVOT_SLIP_COUNT  * MIN_STAKE_PER_SLIP / PIVOT_RATIO),
    Math.ceil(BRIDGE_SLIP_COUNT * MIN_STAKE_PER_SLIP / BRIDGE_RATIO),
    Math.ceil(CHAOS_SLIP_COUNT  * MIN_STAKE_PER_SLIP / CHAOS_RATIO),
  )
}
