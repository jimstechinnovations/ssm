/**
 * Unit tests for the resolveMarket helper (Property 11: Odds Cache Market Mapping).
 *
 * resolveMarket is a private function inside lib/football-api/client.ts, so we
 * maintain a local copy here to test the mapping rules directly.
 *
 * Validates: Requirements 3.6
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Local copy of resolveMarket for testing
// Keep in sync with lib/football-api/client.ts
// ---------------------------------------------------------------------------
function resolveMarket(betId: number, valueLabel: string): string | null {
  switch (betId) {
    case 1:
      return '1X2'
    case 4:
      return 'BTTS'
    case 5: {
      const match = valueLabel.match(/[\d.]+/)
      if (!match) return null
      return `OVER_UNDER_${match[0]}`
    }
    case 8:
      return 'ASIAN_HANDICAP'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveMarket – market type mapping', () => {
  describe('bet.id === 1 (1X2)', () => {
    it('returns "1X2" regardless of value label', () => {
      expect(resolveMarket(1, 'Home')).toBe('1X2')
      expect(resolveMarket(1, 'Draw')).toBe('1X2')
      expect(resolveMarket(1, 'Away')).toBe('1X2')
      expect(resolveMarket(1, '')).toBe('1X2')
    })
  })

  describe('bet.id === 4 (BTTS)', () => {
    it('returns "BTTS" regardless of value label', () => {
      expect(resolveMarket(4, 'Yes')).toBe('BTTS')
      expect(resolveMarket(4, 'No')).toBe('BTTS')
      expect(resolveMarket(4, '')).toBe('BTTS')
    })
  })

  describe('bet.id === 5 (Over/Under)', () => {
    it('returns "OVER_UNDER_2.5" for "Over 2.5"', () => {
      expect(resolveMarket(5, 'Over 2.5')).toBe('OVER_UNDER_2.5')
    })

    it('returns "OVER_UNDER_1.5" for "Under 1.5"', () => {
      expect(resolveMarket(5, 'Under 1.5')).toBe('OVER_UNDER_1.5')
    })

    it('returns "OVER_UNDER_3.5" for "Over 3.5"', () => {
      expect(resolveMarket(5, 'Over 3.5')).toBe('OVER_UNDER_3.5')
    })

    it('returns "OVER_UNDER_0.5" for "Over 0.5"', () => {
      expect(resolveMarket(5, 'Over 0.5')).toBe('OVER_UNDER_0.5')
    })

    it('returns null when the label contains no number', () => {
      expect(resolveMarket(5, 'Over')).toBeNull()
      expect(resolveMarket(5, '')).toBeNull()
      expect(resolveMarket(5, 'N/A')).toBeNull()
    })
  })

  describe('bet.id === 8 (Asian Handicap)', () => {
    it('returns "ASIAN_HANDICAP"', () => {
      expect(resolveMarket(8, 'Home -0.5')).toBe('ASIAN_HANDICAP')
      expect(resolveMarket(8, 'Away +1')).toBe('ASIAN_HANDICAP')
    })
  })

  describe('unknown bet.id', () => {
    it('returns null for unrecognised bet ids', () => {
      expect(resolveMarket(99, 'Some label')).toBeNull()
      expect(resolveMarket(0, '')).toBeNull()
      expect(resolveMarket(2, 'Home')).toBeNull()
    })
  })
})
