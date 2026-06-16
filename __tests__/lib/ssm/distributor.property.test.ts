/**
 * Property-based tests for the SSM account distributor.
 *
 * Validates: Requirements 2.1–2.9
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { distributeToAccounts } from '../../../lib/ssm/distributor'
import type { Slip, SessionConfig } from '../../../lib/ssm/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a minimal Slip object for testing.
 * legs, combinedOdds, potentialPayout, and sessionHash are filled with
 * placeholder values since the distributor only reads tier and slipId.
 */
function makeMockSlip(slipId: number, tier: 'CORE' | 'PIVOT' | 'CHAOS', stake: number): Slip {
  return {
    slipId,
    tier,
    tierIndex: slipId,
    legs: [],
    combinedOdds: 1,
    stake,
    potentialPayout: stake,
    sessionHash: `SESS-20260614-test-S${String(slipId).padStart(2, '0')}`,
  }
}

/**
 * Builds the canonical 42-slip mock array:
 *   - 30 CORE  slips with slipId 1-30
 *   - 8  PIVOT slips with slipId 31-38
 *   - 4  CHAOS slips with slipId 39-42
 */
function makeMockSlips(stake: number): Slip[] {
  const slips: Slip[] = []
  for (let i = 1; i <= 30; i++) slips.push(makeMockSlip(i, 'CORE', stake))
  for (let i = 31; i <= 38; i++) slips.push(makeMockSlip(i, 'PIVOT', stake))
  for (let i = 39; i <= 42; i++) slips.push(makeMockSlip(i, 'CHAOS', stake))
  return slips
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const positiveStakeArb = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(10_000),
  noNaN: true,
  noDefaultInfinity: true,
})

const config7Arb: fc.Arbitrary<SessionConfig> = positiveStakeArb.map(stake => ({
  date: '2026-06-14',
  stakePerSlip: stake,
  numAccounts: 7 as const,
  sessionPrefix: 'SESS-20260614-test',
}))

const config6Arb: fc.Arbitrary<SessionConfig> = positiveStakeArb.map(stake => ({
  date: '2026-06-14',
  stakePerSlip: stake,
  numAccounts: 6 as const,
  sessionPrefix: 'SESS-20260614-test',
}))

// ─── Property 8: Seven-Account Distribution Composition ──────────────────────

/**
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 *
 * For any stakePerSlip > 0 with numAccounts=7:
 *   - Accounts 1-4: exactly 4 CORE + 1 PIVOT + 1 CHAOS, profile='Balanced Aggressive'
 *   - Account 5:    exactly 4 CORE + 2 PIVOT,            profile='Standard Accumulator'
 *   - Accounts 6-7: exactly 5 CORE + 1 PIVOT,            profile='Heavy Core'
 *   - Total slips = 42, no slip appears in more than one account
 */
describe('Property 8: Seven-Account Distribution Composition', () => {
  it('accounts 1-4 get 4 CORE + 1 PIVOT + 1 CHAOS (Balanced Aggressive)', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        expect(accounts).toHaveLength(7)

        // Accounts 1-4: Balanced Aggressive
        for (let i = 0; i < 4; i++) {
          const acc = accounts[i]
          const core  = acc.slips.filter(s => s.tier === 'CORE').length
          const pivot = acc.slips.filter(s => s.tier === 'PIVOT').length
          const chaos = acc.slips.filter(s => s.tier === 'CHAOS').length
          expect(core,  `account ${i + 1} CORE count`).toBe(4)
          expect(pivot, `account ${i + 1} PIVOT count`).toBe(1)
          expect(chaos, `account ${i + 1} CHAOS count`).toBe(1)
          expect(acc.profile, `account ${i + 1} profile`).toBe('Balanced Aggressive')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('account 5 gets 4 CORE + 2 PIVOT (Standard Accumulator)', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        const acc5 = accounts[4]
        expect(acc5.slips.filter(s => s.tier === 'CORE').length).toBe(4)
        expect(acc5.slips.filter(s => s.tier === 'PIVOT').length).toBe(2)
        expect(acc5.slips.filter(s => s.tier === 'CHAOS').length).toBe(0)
        expect(acc5.profile).toBe('Standard Accumulator')
      }),
      { numRuns: 200 },
    )
  })

  it('accounts 6-7 get 5 CORE + 1 PIVOT (Heavy Core)', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        for (const i of [5, 6]) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,  `account ${i + 1} CORE`).toBe(5)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length, `account ${i + 1} PIVOT`).toBe(1)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length, `account ${i + 1} CHAOS`).toBe(0)
          expect(acc.profile, `account ${i + 1} profile`).toBe('Heavy Core')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('total across all 7 accounts is exactly 42 with no duplicate slips', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        const grandTotal = accounts.reduce((sum, a) => sum + a.slips.length, 0)
        expect(grandTotal).toBe(42)

        // No slip appears in more than one account
        const allSlipIds = accounts.flatMap(a => a.slips.map(s => s.slipId))
        const uniqueSlipIds = new Set(allSlipIds)
        expect(uniqueSlipIds.size).toBe(42)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 9: Six-Account Distribution Composition ────────────────────────

/**
 * Validates: Requirements 2.1, 2.2, 2.3, 2.7, 2.8, 2.9
 *
 * For any stakePerSlip > 0 with numAccounts=6:
 *   - Accounts 1-4: exactly 5 CORE + 1 PIVOT + 1 CHAOS, profile='Balanced Aggressive'
 *   - Accounts 5-6: exactly 5 CORE + 2 PIVOT,            profile='Standard Accumulator'
 *   - Total slips across all accounts = 42
 *
 * Note: All 4 chaos slips are distributed (one to each of accounts 1-4).
 */
describe('Property 9: Six-Account Distribution Composition', () => {
  it('accounts 1-4 get 5 CORE + 1 PIVOT + 1 CHAOS (Balanced Aggressive)', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        expect(accounts).toHaveLength(6)

        for (let i = 0; i < 4; i++) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,  `account ${i + 1} CORE`).toBe(5)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length, `account ${i + 1} PIVOT`).toBe(1)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length, `account ${i + 1} CHAOS`).toBe(1)
          expect(acc.profile, `account ${i + 1} profile`).toBe('Balanced Aggressive')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('accounts 5-6 get 5 CORE + 2 PIVOT (Standard Accumulator)', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        for (const i of [4, 5]) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,  `account ${i + 1} CORE`).toBe(5)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length, `account ${i + 1} PIVOT`).toBe(2)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length, `account ${i + 1} CHAOS`).toBe(0)
          expect(acc.profile, `account ${i + 1} profile`).toBe('Standard Accumulator')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('total across all 6 accounts is exactly 42', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        const grandTotal = accounts.reduce((sum, a) => sum + a.slips.length, 0)
        expect(grandTotal).toBe(42)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 10: Account Total Stake ────────────────────────────────────────

/**
 * Validates: Requirements 2.3, 2.9
 *
 * For any stakePerSlip, each account's totalStake equals
 * account.slips.length * stakePerSlip.
 */
describe('Property 10: Account Total Stake', () => {
  it('totalStake === slips.length * stakePerSlip for every account (7-account)', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        for (const acc of accounts) {
          const expected = acc.slips.length * config.stakePerSlip
          expect(acc.totalStake).toBeCloseTo(expected, 10)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('totalStake === slips.length * stakePerSlip for every account (6-account)', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        for (const acc of accounts) {
          const expected = acc.slips.length * config.stakePerSlip
          expect(acc.totalStake).toBeCloseTo(expected, 10)
        }
      }),
      { numRuns: 200 },
    )
  })
})
