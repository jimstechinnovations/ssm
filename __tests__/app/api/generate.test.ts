/**
 * Unit tests for app/api/generate/route.ts
 *
 * Validates: Requirements 1.8–1.12, 4.7, 12.4
 *
 * Mock strategy:
 *   - `next/headers`          → async-resolved cookie store with get/set/delete
 *   - `@/lib/supabase/server` → chainable query builder
 *   - `@/lib/ssm/generator`   → returns 42 mock slips
 *   - `@/lib/ssm/distributor` → returns mock distribution
 *   - `@/lib/ssm/session`     → deterministic prefix/hash helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Hoist mocks so they are initialised before vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockGenerateMatrix,
  mockDistributeToAccounts,
  mockGenerateSessionPrefix,
  mockGenerateSlipHash,
  mockCreateServerClient,
  cookieStore,
} = vi.hoisted(() => {
  // ---------- cookie store --------------------------------------------------
  const _jar: Record<string, string> = {}
  const store = {
    get(name: string) {
      return _jar[name] !== undefined ? { value: _jar[name] } : undefined
    },
    set: vi.fn((name: string, value: string, _opts?: unknown) => {
      _jar[name] = value
    }),
    delete: vi.fn((name: string) => {
      delete _jar[name]
    }),
    _reset() {
      for (const k of Object.keys(_jar)) delete _jar[k]
      store.set.mockClear()
      store.delete.mockClear()
    },
  }

  return {
    mockGenerateMatrix:         vi.fn(),
    mockDistributeToAccounts:   vi.fn(),
    mockGenerateSessionPrefix:  vi.fn(),
    mockGenerateSlipHash:       vi.fn(),
    mockCreateServerClient:     vi.fn(),
    cookieStore:                store,
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(cookieStore)),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => mockCreateServerClient(),
}))

vi.mock('@/lib/ssm/generator', () => ({
  generateMatrix: mockGenerateMatrix,
}))

vi.mock('@/lib/ssm/distributor', () => ({
  distributeToAccounts: mockDistributeToAccounts,
}))

vi.mock('@/lib/ssm/session', () => ({
  generateSessionPrefix: mockGenerateSessionPrefix,
  generateSlipHash:      mockGenerateSlipHash,
}))

// Import route handler AFTER mocks are in place
import { POST } from '@/app/api/generate/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A single valid match that satisfies MatchSelectionSchema */
const VALID_MATCH = {
  fixture: {
    id: 1,
    homeTeam: 'A',
    awayTeam: 'B',
    league: 'L',
    leagueId: 1,
    kickoff: '2026-06-14T15:00:00Z',
    odds: [],
  },
  state0: { bookmaker: 'b', market: '1X2', label: 'Home', value: 1.5 },
  state1: { bookmaker: 'b', market: '1X2', label: 'Away', value: 3.0 },
  volatility: 0.5,
}

function makeValidBody(overrides?: Partial<{ matches: unknown[]; config: unknown }>) {
  return {
    matches: Array(8).fill(VALID_MATCH),
    config: { date: '2026-06-14', stakePerSlip: 1000, numAccounts: 7 },
    ...overrides,
  }
}

/** Build a mock Supabase builder that resolves .single() with the given result */
function makeSupabaseBuilder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.from   = vi.fn(chain)
  b.insert = vi.fn(chain)
  b.select = vi.fn(chain)
  b.eq     = vi.fn(chain)
  b.single = vi.fn(() => Promise.resolve(result))
  return b
}

/** Wires up the Supabase mock client with an insert that returns the given result */
function setupSupabase(result: { data: unknown; error: unknown }) {
  const builder = makeSupabaseBuilder(result)
  mockCreateServerClient.mockReturnValue({
    from: vi.fn(() => builder),
  })
  return builder
}

/** Build the 42 mock slips returned by the mocked generateMatrix */
function make42MockSlips() {
  return Array.from({ length: 42 }, (_, i) => ({
    slipId:          i + 1,
    tier:            i < 30 ? 'CORE' : i < 38 ? 'PIVOT' : 'CHAOS',
    tierIndex:       i + 1,
    legs:            [],
    combinedOdds:    2.0,
    stake:           1000,
    potentialPayout: 2000,
    sessionHash:     '',
  }))
}

/** Build mock distribution returned by distributeToAccounts */
function makeMockDistribution(slips: ReturnType<typeof make42MockSlips>) {
  return [
    { accountNumber: 1, profile: 'Balanced Aggressive', slips: slips.slice(0, 6),  totalStake: 6000,  sessionHashes: [] },
    { accountNumber: 2, profile: 'Balanced Aggressive', slips: slips.slice(6, 12), totalStake: 6000,  sessionHashes: [] },
    { accountNumber: 3, profile: 'Balanced Aggressive', slips: slips.slice(12, 18), totalStake: 6000, sessionHashes: [] },
    { accountNumber: 4, profile: 'Balanced Aggressive', slips: slips.slice(18, 24), totalStake: 6000, sessionHashes: [] },
    { accountNumber: 5, profile: 'Standard Accumulator', slips: slips.slice(24, 30), totalStake: 6000, sessionHashes: [] },
    { accountNumber: 6, profile: 'Heavy Core',           slips: slips.slice(30, 36), totalStake: 6000, sessionHashes: [] },
    { accountNumber: 7, profile: 'Heavy Core',           slips: slips.slice(36, 42), totalStake: 6000, sessionHashes: [] },
  ]
}

function makeJsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  cookieStore._reset()

  // Default session mock values
  mockGenerateSessionPrefix.mockReturnValue('SESS-20260614-abcd')
  mockGenerateSlipHash.mockImplementation(
    (prefix: string, accountNum: number, slipNum: number) =>
      `${prefix}-A${String(accountNum).padStart(2, '0')}-S${String(slipNum).padStart(2, '0')}`,
  )
})

// ===========================================================================
// Validation rejection tests — all should return 400 without calling generateMatrix
// ===========================================================================

describe('POST /api/generate — validation rejections', () => {
  it('1. returns 400 when matches array has 7 items instead of 8', async () => {
    const body = makeValidBody({ matches: Array(7).fill(VALID_MATCH) })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('2. returns 400 when one match is missing state0', async () => {
    const matches = Array(8).fill(VALID_MATCH).map((m, i) =>
      i === 3 ? { ...m, state0: undefined } : m,
    )
    const body = makeValidBody({ matches })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('3. returns 400 when one match is missing state1', async () => {
    const matches = Array(8).fill(VALID_MATCH).map((m, i) =>
      i === 5 ? { ...m, state1: undefined } : m,
    )
    const body = makeValidBody({ matches })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('4. returns 400 when stakePerSlip is 0', async () => {
    const body = makeValidBody({
      config: { date: '2026-06-14', stakePerSlip: 0, numAccounts: 7 },
    })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('5. returns 400 when stakePerSlip is negative', async () => {
    const body = makeValidBody({
      config: { date: '2026-06-14', stakePerSlip: -50, numAccounts: 7 },
    })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('6. returns 400 when numAccounts is 5 (invalid)', async () => {
    const body = makeValidBody({
      config: { date: '2026-06-14', stakePerSlip: 1000, numAccounts: 5 },
    })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('7. returns 400 when numAccounts is 8 (invalid)', async () => {
    const body = makeValidBody({
      config: { date: '2026-06-14', stakePerSlip: 1000, numAccounts: 8 },
    })
    const res = await POST(makeJsonRequest(body))

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })

  it('8. returns 400 for a non-JSON body', async () => {
    const req = new Request('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json at all!!!',
    })
    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(mockGenerateMatrix).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Property 7: Validation Rejects Invalid Requests (fast-check)
//
// Validates: Requirements 1.8–1.12, 12.4
// ===========================================================================

/**
 * **Validates: Requirements 1.8–1.12**
 *
 * Property 7: For any request body where matches.length ≠ 8 (generated via
 * fc.integer({ min: 0, max: 7 })), the handler always returns HTTP 400
 * without invoking generateMatrix.
 */
describe('Property 7: Validation Rejects Invalid Requests', () => {
  it('always returns 400 without calling generateMatrix when match count ≠ 8', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 7 }).filter(n => n !== 8),
        async (count) => {
          vi.clearAllMocks()
          const body = makeValidBody({ matches: Array(count).fill(VALID_MATCH) })
          const res = await POST(makeJsonRequest(body))

          expect(res.status).toBe(400)
          expect(mockGenerateMatrix).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 50 },
    )
  })
})

// ===========================================================================
// Success case
// ===========================================================================

describe('POST /api/generate — success path', () => {
  it('10. valid request → generateMatrix called, distributeToAccounts called, 200 with slips/distribution/sessionId and httpOnly cookie set', async () => {
    const mockSlips = make42MockSlips()
    const mockDistribution = makeMockDistribution(mockSlips)
    const sessionUuid = 'cccccccc-0000-0000-0000-000000000001'

    mockGenerateMatrix.mockReturnValue(mockSlips)
    mockDistributeToAccounts.mockReturnValue(mockDistribution)
    setupSupabase({ data: { id: sessionUuid }, error: null })

    const res = await POST(makeJsonRequest(makeValidBody()))

    expect(res.status).toBe(200)

    // Generator and distributor must have been called
    expect(mockGenerateMatrix).toHaveBeenCalledOnce()
    expect(mockDistributeToAccounts).toHaveBeenCalledOnce()

    // Response shape
    const body = await res.json()
    expect(body).toHaveProperty('slips')
    expect(body).toHaveProperty('distribution')
    expect(body).toHaveProperty('sessionId', sessionUuid)
    expect(Array.isArray(body.slips)).toBe(true)
    expect(Array.isArray(body.distribution)).toBe(true)

    // Cookie must be set with httpOnly: true
    expect(cookieStore.set).toHaveBeenCalledOnce()
    const [cookieName, cookieValue, cookieOptions] = cookieStore.set.mock.calls[0]
    expect(cookieName).toBe('ssm_session_id')
    expect(cookieValue).toBe(sessionUuid)
    expect((cookieOptions as Record<string, unknown>).httpOnly).toBe(true)
  })
})

// ===========================================================================
// Supabase failure — 503, no cookie
// ===========================================================================

describe('POST /api/generate — Supabase failure', () => {
  it('11. valid request but Supabase insert returns a non-unique error → 503, cookie NOT set', async () => {
    const mockSlips = make42MockSlips()
    const mockDistribution = makeMockDistribution(mockSlips)

    mockGenerateMatrix.mockReturnValue(mockSlips)
    mockDistributeToAccounts.mockReturnValue(mockDistribution)

    // Non-unique error (e.g. some other DB error) → should stop retrying and return 503
    setupSupabase({
      data:  null,
      error: { code: '42P01', message: 'relation does not exist' },
    })

    const res = await POST(makeJsonRequest(makeValidBody()))

    expect(res.status).toBe(503)
    // Cookie must NOT be set on failure
    expect(cookieStore.set).not.toHaveBeenCalled()
  })
})
