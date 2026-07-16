/**
 * Property-based and unit tests for session.ts helpers.
 *
 * Validates: Requirements 4.9, 11.1, 11.2
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { generateSessionPrefix, generateSlipHash } from '../../../lib/ssm/session'

// ─── Unit tests ──────────────────────────────────────────────────────────────

describe('generateSlipHash – unit tests', () => {
  it('formats account and slip numbers with zero-padding (3, 5)', () => {
    expect(generateSlipHash('SESS-20260614-a3f2', 3, 5)).toBe('SESS-20260614-a3f2-A03-S05')
  })

  it('formats account and slip numbers with zero-padding (1, 1)', () => {
    expect(generateSlipHash('SESS-20260614-a3f2', 1, 1)).toBe('SESS-20260614-a3f2-A01-S01')
  })
})

// ─── Property 12: Session Prefix Format ──────────────────────────────────────

/**
 * Validates: Requirements 4.9, 11.1
 *
 * For any date (within a realistic 4-digit year range), generateSessionPrefix(date)
 * must return a string matching SESS-{YYYYMMDD}-{4 hex chars} (case-insensitive on hex).
 *
 * The date range is constrained to 1970–2099 because getUTCFullYear() returns 5+
 * digit strings for extreme dates, which is not an intended use case for session IDs.
 */
describe('Property 12: Session Prefix Format', () => {
  it('always matches /^SESS-\\d{8}-[0-9a-f]{4}$/i for any date', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('2099-12-31T23:59:59.999Z'),
        }).filter(d => !isNaN(d.getTime())),
        (date) => {
          const prefix = generateSessionPrefix(date)
          expect(prefix).toMatch(/^SESS-\d{8}-[0-9a-f]{4}$/i)
        },
      ),
      { numRuns: 1000 },
    )
  })
})

// ─── Property 13: Session Hash Format ────────────────────────────────────────

/**
 * Validates: Requirements 11.2
 *
 * For any valid SESS prefix, accountNum 1–7, and slipNum 1–6,
 * generateSlipHash must return a string matching
 * /^SESS-\d{8}-[0-9a-f]{4}-A\d{2}-S\d{2}$/.
 */
describe('Property 13: Session Hash Format', () => {
  // Generate the prefix once as a stable constant for the hash test.
  const sessionPrefix = generateSessionPrefix(new Date())

  it('always matches /^SESS-\\d{8}-[0-9a-f]{4}-A\\d{2}-S\\d{2}$/', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 1, max: 6 }),
        (accountNum, slipNum) => {
          const hash = generateSlipHash(sessionPrefix, accountNum, slipNum)
          expect(hash).toMatch(/^SESS-\d{8}-[0-9a-f]{4}-A\d{2}-S\d{2}$/)
        },
      ),
      { numRuns: 500 },
    )
  })
})
