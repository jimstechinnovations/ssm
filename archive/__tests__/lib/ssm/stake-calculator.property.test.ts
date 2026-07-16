/**
 * Property-based tests for lib/ssm/stake-calculator.ts
 *
 * v3.1: Four tiers — CORE (60%), PIVOT (14%), BRIDGE (14%), CHAOS (6%), Buffer (6%)
 * 56 slips total. Minimum bankroll ₦10,000.
 *
 * Property 4: Stake allocation preserves the full bankroll
 * Validates: Requirements 5.2, 5.7
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { calculateStakes, minBankroll, MIN_STAKE_PER_SLIP } from '../../../lib/ssm/stake-calculator'

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('calculateStakes — unit tests', () => {
  it('works correctly at the ₦10,000 default', () => {
    const result = calculateStakes(10_000)
    expect(result.bankroll).toBe(10_000)
    // Core:   floor(10000 * 0.60 / 30) = floor(200.00) = 200
    expect(result.coreStakePerSlip).toBe(200)
    // Pivot:  floor(10000 * 0.14 / 8)  = floor(175.00) = 175
    expect(result.pivotStakePerSlip).toBe(175)
    // Bridge: floor(10000 * 0.14 / 14) = floor(100.00) = 100
    expect(result.bridgeStakePerSlip).toBe(100)
    // Chaos:  floor(10000 * 0.06 / 4)  = floor(150.00) = 150
    expect(result.chaosStakePerSlip).toBe(150)
    // Buffer: 10000 - (200×30 + 175×8 + 100×14 + 150×4)
    //       = 10000 - (6000 + 1400 + 1400 + 600) = 10000 - 9400 = 600
    expect(result.buffer).toBe(600)
    expect(result.total).toBe(10_000)
  })

  it('all per-slip stakes are positive integers', () => {
    const result = calculateStakes(10_000)
    expect(Number.isInteger(result.coreStakePerSlip)).toBe(true)
    expect(Number.isInteger(result.pivotStakePerSlip)).toBe(true)
    expect(Number.isInteger(result.bridgeStakePerSlip)).toBe(true)
    expect(Number.isInteger(result.chaosStakePerSlip)).toBe(true)
    expect(result.coreStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
    expect(result.pivotStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
    expect(result.bridgeStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
    expect(result.chaosStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
  })

  it('buffer is non-negative at ₦10,000', () => {
    expect(calculateStakes(10_000).buffer).toBeGreaterThanOrEqual(0)
  })

  it('staked + buffer exactly equals bankroll at ₦10,000', () => {
    const r = calculateStakes(10_000)
    const staked =
      r.coreStakePerSlip   * 30 +
      r.pivotStakePerSlip  *  8 +
      r.bridgeStakePerSlip * 14 +
      r.chaosStakePerSlip  *  4
    expect(staked + r.buffer).toBe(10_000)
  })

  it('throws for bankroll = 0', () => {
    expect(() => calculateStakes(0)).toThrow()
  })

  it('throws for negative bankroll', () => {
    expect(() => calculateStakes(-500)).toThrow()
  })

  it('throws when bankroll is below minBankroll()', () => {
    expect(() => calculateStakes(minBankroll() - 1)).toThrow()
  })

  it('succeeds at exactly minBankroll() = ₦10,000', () => {
    const min = minBankroll()
    expect(min).toBe(10_000)
    const result = calculateStakes(min)
    expect(result.coreStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
    expect(result.pivotStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
    expect(result.bridgeStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
    expect(result.chaosStakePerSlip).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
  })

  it('scales correctly with a larger bankroll', () => {
    const result = calculateStakes(100_000)
    expect(result.coreStakePerSlip).toBe(Math.floor(100_000 * 0.60 / 30))
    expect(result.pivotStakePerSlip).toBe(Math.floor(100_000 * 0.14 / 8))
    expect(result.bridgeStakePerSlip).toBe(Math.floor(100_000 * 0.14 / 14))
    expect(result.chaosStakePerSlip).toBe(Math.floor(100_000 * 0.06 / 4))
  })
})

// ─── Property 4: Budget identity (v3.1 — 4 tiers, 56 slips) ─────────────────

/**
 * For any bankroll >= minBankroll():
 *   coreStake×30 + pivotStake×8 + bridgeStake×14 + chaosStake×4 + buffer = bankroll
 *   All per-slip stakes are positive integers >= ₦100; buffer >= 0.
 *
 * Validates: Requirements 5.2, 5.7
 */
describe('Property 4: Stake allocation preserves the full bankroll', () => {
  const min = minBankroll()
  const bankrollArb = fc.integer({ min, max: 10_000_000 })

  it('coreStake×30 + pivotStake×8 + bridgeStake×14 + chaosStake×4 + buffer === bankroll', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        const staked =
          r.coreStakePerSlip   * 30 +
          r.pivotStakePerSlip  *  8 +
          r.bridgeStakePerSlip * 14 +
          r.chaosStakePerSlip  *  4
        expect(staked + r.buffer).toBe(bankroll)
      }),
      { numRuns: 1000 },
    )
  })

  it('all per-slip stakes are integers >= ₦100 (Nigerian bookmaker minimum)', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        for (const stake of [r.coreStakePerSlip, r.pivotStakePerSlip, r.bridgeStakePerSlip, r.chaosStakePerSlip]) {
          expect(Number.isInteger(stake)).toBe(true)
          expect(stake).toBeGreaterThanOrEqual(MIN_STAKE_PER_SLIP)
        }
      }),
      { numRuns: 1000 },
    )
  })

  it('buffer is always non-negative', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        expect(calculateStakes(bankroll).buffer).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 1000 },
    )
  })

  it('total field always equals bankroll', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        expect(calculateStakes(bankroll).total).toBe(bankroll)
      }),
      { numRuns: 1000 },
    )
  })
})
