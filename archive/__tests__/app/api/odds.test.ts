/**
 * Unit tests for app/api/odds/route.ts
 *
 * Validates: Requirements 3.2, 3.3
 *
 * Strategy: mock fetchFixtureOdds so the route handler contract is tested
 * in isolation — input validation, response shape, and status codes.
 * Cache logic lives inside fetchFixtureOdds and is not re-tested here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OddsValue } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Mock the football-api client module.
// `server-only` would throw in a jsdom environment, so we replace the entire
// module with a controlled stub before importing the route handler.
//
// vi.hoisted ensures the mock function is initialised before vi.mock's factory
// runs (vi.mock calls are hoisted to the top of the file by Vitest).
// ---------------------------------------------------------------------------

const { mockFetchFixtureOdds } = vi.hoisted(() => ({
  mockFetchFixtureOdds: vi.fn(),
}))

vi.mock('@/lib/football-api/client', () => ({
  fetchFixtureOdds: mockFetchFixtureOdds,
}))

// Import route handler AFTER mock is in place.
import { GET } from '@/app/api/odds/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string): Request {
  return new Request(url)
}

// Sample odds payload used across tests
const sampleOdds: OddsValue[] = [
  { bookmaker: '8Bet', market: '1X2',          label: 'Home', value: 1.85 },
  { bookmaker: '8Bet', market: 'BTTS',          label: 'Yes',  value: 1.72 },
  { bookmaker: '8Bet', market: 'OVER_UNDER_2.5', label: 'Over 2.5', value: 1.90 },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/odds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. Missing fixture param
  it('returns 400 when the fixture query param is absent', async () => {
    const res = await GET(makeRequest('http://localhost/api/odds'))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'fixture must be a positive integer' })
    expect(mockFetchFixtureOdds).not.toHaveBeenCalled()
  })

  // 2. Invalid fixture param (non-numeric)
  it('returns 400 when the fixture param is not a valid integer', async () => {
    const res = await GET(makeRequest('http://localhost/api/odds?fixture=abc'))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'fixture must be a positive integer' })
    expect(mockFetchFixtureOdds).not.toHaveBeenCalled()
  })

  // 2b. Invalid fixture param (zero — not a positive integer)
  it('returns 400 when the fixture param is zero', async () => {
    const res = await GET(makeRequest('http://localhost/api/odds?fixture=0'))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'fixture must be a positive integer' })
    expect(mockFetchFixtureOdds).not.toHaveBeenCalled()
  })

  // 2c. Invalid fixture param (negative)
  it('returns 400 when the fixture param is negative', async () => {
    const res = await GET(makeRequest('http://localhost/api/odds?fixture=-5'))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'fixture must be a positive integer' })
    expect(mockFetchFixtureOdds).not.toHaveBeenCalled()
  })

  // 3. Cache hit path — fetchFixtureOdds resolves with populated odds
  it('returns 200 with odds data when fetchFixtureOdds resolves successfully (cache hit)', async () => {
    mockFetchFixtureOdds.mockResolvedValueOnce({
      odds: sampleOdds,
      oddsUnavailable: false,
    })

    const res = await GET(makeRequest('http://localhost/api/odds?fixture=12345'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ odds: sampleOdds, oddsUnavailable: false })
    expect(mockFetchFixtureOdds).toHaveBeenCalledOnce()
    expect(mockFetchFixtureOdds).toHaveBeenCalledWith(12345)
  })

  // 4. Cache miss path — fetchFixtureOdds still returns populated odds
  it('returns 200 with odds data when fetchFixtureOdds resolves after a cache miss', async () => {
    mockFetchFixtureOdds.mockResolvedValueOnce({
      odds: sampleOdds,
      oddsUnavailable: false,
    })

    const res = await GET(makeRequest('http://localhost/api/odds?fixture=99999'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.odds).toEqual(sampleOdds)
    expect(body.oddsUnavailable).toBe(false)
    expect(mockFetchFixtureOdds).toHaveBeenCalledWith(99999)
  })

  // 5. API error path — fetchFixtureOdds signals oddsUnavailable
  it('returns 200 with oddsUnavailable=true when the upstream API fails (not a 5xx)', async () => {
    mockFetchFixtureOdds.mockResolvedValueOnce({
      odds: [],
      oddsUnavailable: true,
    })

    const res = await GET(makeRequest('http://localhost/api/odds?fixture=77777'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ odds: [], oddsUnavailable: true })
    expect(mockFetchFixtureOdds).toHaveBeenCalledWith(77777)
  })
})
