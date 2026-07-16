/**
 * Property-based tests for the SSM account distributor.
 *
 * v3.1: 56 slips — 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS
 *
 * Validates: Requirements 2.1–2.9
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { distributeToAccounts } from '../../../lib/ssm/distributor'
import type { Slip, SessionConfig } from '../../../lib/ssm/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockSlip(slipId: number, tier: 'CORE' | 'PIVOT' | 'BRIDGE' | 'CHAOS', stake: number): Slip {
  return {
    slipId,
    tier,
    tierIndex: slipId,
    legs: [],
    combinedOdds: 1,
    stake,
    potentialPayout: stake,
    sessionHash: `SESS-test-S${String(slipId).padStart(2, '0')}`,
  }
}

/**
 * Builds the canonical 56-slip mock array:
 *   - 30 CORE   slips: ids  1–30
 *   - 8  PIVOT  slips: ids 31–38
 *   - 14 BRIDGE slips: ids 39–52
 *   - 4  CHAOS  slips: ids 53–56
 */
function makeMockSlips(stake: number): Slip[] {
  const slips: Slip[] = []
  for (let i = 1;  i <= 30; i++) slips.push(makeMockSlip(i,  'CORE',   stake))
  for (let i = 31; i <= 38; i++) slips.push(makeMockSlip(i,  'PIVOT',  stake))
  for (let i = 39; i <= 52; i++) slips.push(makeMockSlip(i,  'BRIDGE', stake))
  for (let i = 53; i <= 56; i++) slips.push(makeMockSlip(i,  'CHAOS',  stake))
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

// ─── Property 8: Seven-Account Distribution ───────────────────────────────────
//
// 7-account template (v3.1):
//   Acc 1–4: 3 CORE + 1 PIVOT + 2 BRIDGE + 1 CHAOS = 7  (Balanced Aggressive)
//   Acc 5:   4 CORE + 2 PIVOT + 2 BRIDGE + 0 CHAOS = 8  (Standard Accumulator)
//   Acc 6–7: 7 CORE + 1 PIVOT + 2 BRIDGE + 0 CHAOS = 10 (Heavy Core)
//   Total: (3×4+4+7×2) + (1×4+2+1×2) + (2×7) + (1×4)
//        = 30 + 8 + 14 + 4 = 56 ✓

describe('Property 8: Seven-Account Distribution Composition', () => {
  it('accounts 1-4 are Balanced Aggressive: 3 CORE + 1 PIVOT + 2 BRIDGE + 1 CHAOS', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)
        expect(accounts).toHaveLength(7)

        for (let i = 0; i < 4; i++) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,   `acc${i+1} CORE`).toBe(3)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length,  `acc${i+1} PIVOT`).toBe(1)
          expect(acc.slips.filter(s => s.tier === 'BRIDGE').length, `acc${i+1} BRIDGE`).toBe(2)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length,  `acc${i+1} CHAOS`).toBe(1)
          expect(acc.profile).toBe('Balanced Aggressive')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('account 5 is Standard Accumulator: 4 CORE + 2 PIVOT + 2 BRIDGE + 0 CHAOS', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)
        const acc5 = accounts[4]
        expect(acc5.slips.filter(s => s.tier === 'CORE').length).toBe(4)
        expect(acc5.slips.filter(s => s.tier === 'PIVOT').length).toBe(2)
        expect(acc5.slips.filter(s => s.tier === 'BRIDGE').length).toBe(2)
        expect(acc5.slips.filter(s => s.tier === 'CHAOS').length).toBe(0)
        expect(acc5.profile).toBe('Standard Accumulator')
      }),
      { numRuns: 200 },
    )
  })

  it('accounts 6-7 are Heavy Core: 7 CORE + 1 PIVOT + 2 BRIDGE + 0 CHAOS', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        for (const i of [5, 6]) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,   `acc${i+1} CORE`).toBe(7)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length,  `acc${i+1} PIVOT`).toBe(1)
          expect(acc.slips.filter(s => s.tier === 'BRIDGE').length, `acc${i+1} BRIDGE`).toBe(2)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length,  `acc${i+1} CHAOS`).toBe(0)
          expect(acc.profile).toBe('Heavy Core')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('total across all 7 accounts is exactly 56 with no duplicate slips', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        const grandTotal = accounts.reduce((sum, a) => sum + a.slips.length, 0)
        expect(grandTotal).toBe(56)

        const allSlipIds = accounts.flatMap(a => a.slips.map(s => s.slipId))
        expect(new Set(allSlipIds).size).toBe(56)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 9: Six-Account Distribution ────────────────────────────────────
//
// 6-account template (v3.1):
//   Acc 1–4: 4 CORE + 1 PIVOT + 2 BRIDGE + 1 CHAOS = 8  (Balanced Aggressive)
//   Acc 5–6: 7 CORE + 2 PIVOT + 3 BRIDGE + 0 CHAOS = 12 (Standard Accumulator)
//   Total: (4×4+7×2) + (1×4+2×2) + (2×4+3×2) + (1×4)
//        = 30 + 8 + 14 + 4 = 56 ✓

describe('Property 9: Six-Account Distribution Composition', () => {
  it('accounts 1-4 are Balanced Aggressive: 4 CORE + 1 PIVOT + 2 BRIDGE + 1 CHAOS', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)
        expect(accounts).toHaveLength(6)

        for (let i = 0; i < 4; i++) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,   `acc${i+1} CORE`).toBe(4)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length,  `acc${i+1} PIVOT`).toBe(1)
          expect(acc.slips.filter(s => s.tier === 'BRIDGE').length, `acc${i+1} BRIDGE`).toBe(2)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length,  `acc${i+1} CHAOS`).toBe(1)
          expect(acc.profile).toBe('Balanced Aggressive')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('accounts 5-6 are Standard Accumulator: 7 CORE + 2 PIVOT + 3 BRIDGE + 0 CHAOS', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        for (const i of [4, 5]) {
          const acc = accounts[i]
          expect(acc.slips.filter(s => s.tier === 'CORE').length,   `acc${i+1} CORE`).toBe(7)
          expect(acc.slips.filter(s => s.tier === 'PIVOT').length,  `acc${i+1} PIVOT`).toBe(2)
          expect(acc.slips.filter(s => s.tier === 'BRIDGE').length, `acc${i+1} BRIDGE`).toBe(3)
          expect(acc.slips.filter(s => s.tier === 'CHAOS').length,  `acc${i+1} CHAOS`).toBe(0)
          expect(acc.profile).toBe('Standard Accumulator')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('total across all 6 accounts is exactly 56 with no duplicate slips', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)

        const grandTotal = accounts.reduce((sum, a) => sum + a.slips.length, 0)
        expect(grandTotal).toBe(56)

        const allSlipIds = accounts.flatMap(a => a.slips.map(s => s.slipId))
        expect(new Set(allSlipIds).size).toBe(56)
      }),
      { numRuns: 200 },
    )
  })
})

// ─── Property 10: Account Total Stake ────────────────────────────────────────

describe('Property 10: Account Total Stake', () => {
  it('totalStake equals sum of slip stakes for every account (7-account)', () => {
    fc.assert(
      fc.property(config7Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)
        for (const acc of accounts) {
          const expected = acc.slips.reduce((sum, s) => sum + s.stake, 0)
          expect(acc.totalStake).toBeCloseTo(expected, 10)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('totalStake equals sum of slip stakes for every account (6-account)', () => {
    fc.assert(
      fc.property(config6Arb, (config) => {
        const slips = makeMockSlips(config.stakePerSlip)
        const accounts = distributeToAccounts(slips, config)
        for (const acc of accounts) {
          const expected = acc.slips.reduce((sum, s) => sum + s.stake, 0)
          expect(acc.totalStake).toBeCloseTo(expected, 10)
        }
      }),
      { numRuns: 200 },
    )
  })
})
