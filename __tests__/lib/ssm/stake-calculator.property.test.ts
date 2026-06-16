/**
 * Property-based tests for lib/ssm/stake-calculator.ts
 *
 * Property 4: Stake allocation preserves the full bankroll
 *
 * Validates: Requirements 5.2, 5.7
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { calculateStakes, minBankroll } from '../../../lib/ssm/stake-calculator'

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('calculateStakes — unit tests', () => {
  it('works correctly at the ₦10,000 default', () => {
    const result = calculateStakes(10_000)
    expect(result.bankroll).toBe(10_000)
    expect(result.coreStakePerSlip).toBe(246)   // floor(10000 * 0.74 / 30)
    expect(result.pivotStakePerSlip).toBe(200)   // floor(10000 * 0.16 / 8)
    expect(result.chaosStakePerSlip).toBe(100)   // floor(10000 * 0.04 / 4)
    expect(result.buffer).toBe(620)              // 10000 - (246*30 + 200*8 + 100*4)
    expect(result.total).toBe(10_000)
  })

  it('all per-slip stakes are positive integers', () => {
    const result = calculateStakes(10_000)
    expect(Number.isInteger(result.coreStakePerSlip)).toBe(true)
    expect(Number.isInteger(result.pivotStakePerSlip)).toBe(true)
    expect(Number.isInteger(result.chaosStakePerSlip)).toBe(true)
    expect(result.coreStakePerSlip).toBeGreaterThan(0)
    expect(result.pivotStakePerSlip).toBeGreaterThan(0)
    expect(result.chaosStakePerSlip).toBeGreaterThan(0)
  })

  it('buffer is non-negative at ₦10,000', () => {
    expect(calculateStakes(10_000).buffer).toBeGreaterThanOrEqual(0)
  })

  it('staked + buffer exactly equals bankroll at ₦10,000', () => {
    const r = calculateStakes(10_000)
    const staked = r.coreStakePerSlip * 30 + r.pivotStakePerSlip * 8 + r.chaosStakePerSlip * 4
    expect(staked + r.buffer).toBe(10_000)
  })

  it('throws for bankroll = 0', () => {
    expect(() => calculateStakes(0)).toThrow()
  })

  it('throws for negative bankroll', () => {
    expect(() => calculateStakes(-500)).toThrow()
  })

  it('throws when bankroll is too small (< minBankroll)', () => {
    expect(() => calculateStakes(minBankroll() - 1)).toThrow()
  })

  it('succeeds at exactly minBankroll()', () => {
    const min = minBankroll()
    const result = calculateStakes(min)
    expect(result.coreStakePerSlip).toBeGreaterThan(0)
    expect(result.pivotStakePerSlip).toBeGreaterThan(0)
    expect(result.chaosStakePerSlip).toBeGreaterThan(0)
  })

  it('scales correctly with a larger bankroll', () => {
    const result = calculateStakes(100_000)
    expect(result.coreStakePerSlip).toBe(Math.floor(100_000 * 0.74 / 30))
    expect(result.pivotStakePerSlip).toBe(Math.floor(100_000 * 0.16 / 8))
    expect(result.chaosStakePerSlip).toBe(Math.floor(100_000 * 0.04 / 4))
  })
})

// ─── Property 4: Budget identity ─────────────────────────────────────────────

/**
 * Validates: Requirements 5.2, 5.7
 *
 * For any bankroll >= minBankroll():
 * coreStake×30 + pivotStake×8 + chaosStake×4 + buffer = bankroll
 * All per-slip stakes are positive integers; buffer is non-negative.
 */
describe('Property 4: Stake allocation preserves the full bankroll', () => {
  const min = minBankroll()

  const bankrollArb = fc.integer({ min, max: 10_000_000 })

  it('coreStake×30 + pivotStake×8 + chaosStake×4 + buffer === bankroll', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        const staked = r.coreStakePerSlip * 30 + r.pivotStakePerSlip * 8 + r.chaosStakePerSlip * 4
        expect(staked + r.buffer).toBe(bankroll)
      }),
      { numRuns: 1000 },
    )
  })

  it('all per-slip stakes are positive integers', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        expect(Number.isInteger(r.coreStakePerSlip)).toBe(true)
        expect(Number.isInteger(r.pivotStakePerSlip)).toBe(true)
        expect(Number.isInteger(r.chaosStakePerSlip)).toBe(true)
        expect(r.coreStakePerSlip).toBeGreaterThan(0)
        expect(r.pivotStakePerSlip).toBeGreaterThan(0)
        expect(r.chaosStakePerSlip).toBeGreaterThan(0)
      }),
      { numRuns: 1000 },
    )
  })

  it('buffer is always non-negative', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        expect(r.buffer).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 1000 },
    )
  })

  it('total field always equals bankroll', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        expect(r.total).toBe(bankroll)
      }),
      { numRuns: 1000 },
    )
  })

  it('floor is applied — all per-slip stakes are integers (not decimals)', () => {
    fc.assert(
      fc.property(bankrollArb, (bankroll) => {
        const r = calculateStakes(bankroll)
        expect(r.coreStakePerSlip % 1).toBe(0)
        expect(r.pivotStakePerSlip % 1).toBe(0)
        expect(r.chaosStakePerSlip % 1).toBe(0)
      }),
      { numRuns: 1000 },
    )
  })
})
