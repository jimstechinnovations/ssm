/**
 * Unit + property-based tests for AccountCard and the account-slot builder.
 *
 * Property 18: Account Card Count Matches Configuration
 * Validates: Requirement 8.4
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, within } from '@testing-library/react'
import * as fc from 'fast-check'
import { AccountCard } from '../../../components/accounts/AccountCard'
import type { AccountAllocation } from '../../../lib/ssm/types'

// ─── Pure function under test ─────────────────────────────────────────────────
//
// Mirrors the exact slot-building logic in app/(builder)/accounts/page.tsx.
// Extracting it here lets us property-test it without mounting the full page.

function buildAccountSlots(
  distribution: AccountAllocation[],
  numAccounts: 6 | 7,
): (AccountAllocation | null)[] {
  return Array.from({ length: numAccounts }, (_, i) => {
    const accountNumber = i + 1
    return distribution.find((a) => a.accountNumber === accountNumber) ?? null
  })
}

// ─── Shared mock data ─────────────────────────────────────────────────────────

const mockAllocation: AccountAllocation = {
  accountNumber: 1,
  profile: 'Balanced Aggressive',
  slips: [],
  totalStake: 6000,
  sessionHashes: [],
}

function makeAllocation(accountNumber: number): AccountAllocation {
  return { ...mockAllocation, accountNumber }
}

// ─── Unit tests: buildAccountSlots ───────────────────────────────────────────

describe('buildAccountSlots – unit tests', () => {
  it('1. returns 7 nulls for empty distribution with numAccounts=7', () => {
    const result = buildAccountSlots([], 7)
    expect(result).toHaveLength(7)
    expect(result.every((s) => s === null)).toBe(true)
  })

  it('2. returns 6 nulls for empty distribution with numAccounts=6', () => {
    const result = buildAccountSlots([], 6)
    expect(result).toHaveLength(6)
    expect(result.every((s) => s === null)).toBe(true)
  })

  it('3. slot[2] is non-null when accountNumber=3 present; rest are null', () => {
    const dist = [makeAllocation(3)]
    const result = buildAccountSlots(dist, 7)
    expect(result).toHaveLength(7)
    expect(result[2]).not.toBeNull()
    expect(result[2]?.accountNumber).toBe(3)
    const otherSlots = result.filter((_, i) => i !== 2)
    expect(otherSlots.every((s) => s === null)).toBe(true)
  })

  it('4. full 7-account distribution → all 7 slots non-null', () => {
    const dist = [1, 2, 3, 4, 5, 6, 7].map(makeAllocation)
    const result = buildAccountSlots(dist, 7)
    expect(result).toHaveLength(7)
    expect(result.every((s) => s !== null)).toBe(true)
    result.forEach((slot, i) => {
      expect(slot?.accountNumber).toBe(i + 1)
    })
  })
})

// ─── Property 18: Account Card Count Matches Configuration ───────────────────

/**
 * Validates: Requirement 8.4
 */
describe('Property 18: Account Card Count Matches Configuration', () => {
  // Arbitrary: a sparse distribution (subset of account numbers 1–7)
  const distributionArb = fc
    .shuffledSubarray([1, 2, 3, 4, 5, 6, 7])
    .map((nums) => nums.map(makeAllocation))

  it('5. buildAccountSlots with numAccounts=6 always returns length 6', () => {
    fc.assert(
      fc.property(distributionArb, (dist) => {
        const result = buildAccountSlots(dist, 6)
        expect(result).toHaveLength(6)
      }),
      { numRuns: 200 },
    )
  })

  it('6. buildAccountSlots with numAccounts=7 always returns length 7', () => {
    fc.assert(
      fc.property(distributionArb, (dist) => {
        const result = buildAccountSlots(dist, 7)
        expect(result).toHaveLength(7)
      }),
      { numRuns: 200 },
    )
  })

  it('7. slot at index i matches the allocation with accountNumber=i+1, or null', () => {
    fc.assert(
      fc.property(
        distributionArb,
        fc.constantFrom(6 as const, 7 as const),
        (dist, numAccounts) => {
          const result = buildAccountSlots(dist, numAccounts)
          result.forEach((slot, i) => {
            const expectedAccountNumber = i + 1
            const inDist = dist.find((a) => a.accountNumber === expectedAccountNumber)
            if (inDist) {
              expect(slot).not.toBeNull()
              expect(slot?.accountNumber).toBe(expectedAccountNumber)
            } else {
              expect(slot).toBeNull()
            }
          })
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ─── AccountCard rendering tests ─────────────────────────────────────────────

describe('AccountCard rendering', () => {
  it('8. renders "Account 3" and "No slips assigned yet" when allocation is null', () => {
    const { container } = render(
      <AccountCard allocation={null} accountNumber={3} />,
    )
    const q = within(container)
    expect(q.getByText('Account 3')).toBeDefined()
    expect(q.getByText('No slips assigned yet')).toBeDefined()
  })

  it('9. renders "Account 1" and the profile label when allocation is provided', () => {
    const { container } = render(
      <AccountCard allocation={mockAllocation} accountNumber={1} />,
    )
    const q = within(container)
    expect(q.getByText('Account 1')).toBeDefined()
    expect(q.getByText('Balanced Aggressive')).toBeDefined()
  })
})
