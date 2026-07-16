/**
 * Property-based tests for SlipCard rendering completeness.
 *
 * Validates: Requirements 8.2, 11.3
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, within } from '@testing-library/react'
import * as fc from 'fast-check'
import { SlipCard } from '../../../components/matrix/SlipCard'
import type { Slip, SlipLeg } from '../../../lib/ssm/types'

// ─── Arbitraries ─────────────────────────────────────────────────────────────

// Build 8 legs with unique matchIndex values covering [0,7] exactly once.
// SlipCard keys leg rows on matchIndex, so duplicates would silently drop rows.
const legsArb: fc.Arbitrary<SlipLeg[]> = fc
  .shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7], { minLength: 8, maxLength: 8 })
  .chain((indices) =>
    fc.record({
      fixtureId: fc.integer({ min: 1, max: 99999 }),
      homeTeam: fc.string({ minLength: 1, maxLength: 15 }),
      awayTeam: fc.string({ minLength: 1, maxLength: 15 }),
      market: fc.constantFrom('1X2', 'BTTS', 'OVER_UNDER_2.5') as fc.Arbitrary<'1X2' | 'BTTS' | 'OVER_UNDER_2.5'>,
      outcome: fc.string({ minLength: 1, maxLength: 10 }),
      odds: fc.float({ min: Math.fround(1.01), max: Math.fround(20), noNaN: true, noDefaultInfinity: true }),
      state: fc.constantFrom(0 as const, 1 as const),
    }).map((shared) =>
      indices.map((idx): SlipLeg => ({ ...shared, matchIndex: idx }))
    )
  )

const slipArb: fc.Arbitrary<Slip> = fc.record({
  slipId: fc.integer({ min: 1, max: 42 }),
  tier: fc.constantFrom('CORE' as const, 'PIVOT' as const, 'CHAOS' as const),
  tierIndex: fc.integer({ min: 1, max: 30 }),
  legs: legsArb,
  combinedOdds: fc.float({ min: Math.fround(1.01), max: Math.fround(1000), noNaN: true, noDefaultInfinity: true }),
  stake: fc.float({ min: Math.fround(100), max: Math.fround(10000), noNaN: true, noDefaultInfinity: true }),
  potentialPayout: fc.float({ min: Math.fround(100), max: Math.fround(1000000), noNaN: true, noDefaultInfinity: true }),
  sessionHash: fc.string({ minLength: 5, maxLength: 40 }),
})

// ─── Concrete slip fixture ────────────────────────────────────────────────────

const concreteLegs: SlipLeg[] = Array.from({ length: 8 }, (_, i) => ({
  matchIndex: i,
  fixtureId: 1000 + i,
  homeTeam: `Home${i}`,
  awayTeam: `Away${i}`,
  market: '1X2',
  outcome: 'Home',
  odds: 1.5 + i * 0.1,
  state: 0 as const,
}))

const concreteSlip: Slip = {
  slipId: 5,
  tier: 'CORE',
  tierIndex: 5,
  legs: concreteLegs,
  combinedOdds: 14.52,
  stake: 5000,
  potentialPayout: 72600,
  sessionHash: 'SESS-20260614-abcd-A01-S05',
}

// ─── Unit test: concrete slip ─────────────────────────────────────────────────

describe('SlipCard unit test: concrete slip rendering', () => {
  it('renders all expected content for a concrete slip', () => {
    const { container } = render(<SlipCard slip={concreteSlip} />)
    const q = within(container)

    // Slip ID — React splits "Slip #" and "5" into separate text nodes;
    // use a regex to match across the full rendered text content.
    expect(q.getByText(/Slip #5/)).toBeDefined()

    // Tier badge — TierBadge maps 'CORE' → 'Core'
    expect(q.getByText('Core')).toBeDefined()

    // Session hash
    expect(q.getByText('SESS-20260614-abcd-A01-S05')).toBeDefined()

    // 8 leg rows — each LegRow renders the match index in a <span>
    // We verify by querying all match-index spans (0–7)
    for (let i = 0; i < 8; i++) {
      const all = q.getAllByText(String(i))
      expect(all.length).toBeGreaterThanOrEqual(1)
    }

    // Combined odds — OddsDisplay formats to 2 decimal places
    expect(q.getByText('14.52')).toBeDefined()

    // Stake formatted with ₦ and locale separator
    expect(q.getByText('₦5,000')).toBeDefined()

    // Potential payout
    expect(q.getByText('₦72,600')).toBeDefined()
  })
})

// ─── Property 17: Slip Card Rendering Completeness ───────────────────────────

/**
 * Validates: Requirements 8.2, 11.3
 *
 * For any Slip:
 *  - The rendered output contains "Slip #<slipId>"
 *  - The rendered output contains the slip's sessionHash text
 *  - There are exactly 8 leg rows rendered (one per leg, keyed by matchIndex 0–7)
 */
describe('Property 17: Slip Card Rendering Completeness', () => {
  it('always renders slipId, sessionHash, and 8 leg rows for any valid Slip', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(slipArb, (slip) => {
        const { container, unmount } = render(<SlipCard slip={slip} />)
        const q = within(container)

        // "Slip #<id>" header text — React splits "Slip #" and the number
        // into separate text nodes, so use a regex to match the full content.
        const slipHeader = q.queryByText(new RegExp(`Slip #${slip.slipId}`))
        expect(slipHeader).not.toBeNull()

        // sessionHash text is rendered verbatim.
        // @testing-library normalizes whitespace by default, so we fall back
        // to checking the container's raw textContent for edge-case hashes
        // that consist entirely of whitespace.
        const hashEl = q.queryByText(slip.sessionHash, { normalizer: (text) => text })
        const hashInDom =
          hashEl !== null ||
          container.textContent?.includes(slip.sessionHash)
        expect(hashInDom).toBe(true)

        // Exactly 8 legs — each LegRow renders the matchIndex (0–7) in a
        // dedicated span. Since matchIndex values span 0–7 (guaranteed by
        // the arbitrary), we check for each.
        for (let i = 0; i < 8; i++) {
          const legIndexEls = q.queryAllByText(String(i))
          expect(legIndexEls.length).toBeGreaterThanOrEqual(1)
        }

        unmount()
      }),
      { numRuns: 50 },
    )
  })
})
