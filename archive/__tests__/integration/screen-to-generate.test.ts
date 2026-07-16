/**
 * Integration test: screen → generate round-trip (v2 workflow)
 *
 * Validates: Requirements 3.1, 4.6, 7.1, 7.2, 5.2
 *
 * Flow:
 *   1. POST /api/screen  → qualifies 8 of 10 known fixtures, creates session_groups row
 *   2. POST /api/generate (v2 body) → detects market, allocates stakes, generates 42 slips
 *
 * Mock strategy (vi.hoisted + vi.mock — same pattern as __tests__/app/api/generate.test.ts):
 *   - `@/lib/football-api/client`  → deterministic 10-fixture set with odds that pass all 4 gates
 *   - `@/lib/supabase/server`      → chainable in-memory builder; screen INSERT returns group UUID;
 *                                     generate SELECT returns that UUID with status 'screening';
 *                                     sessions INSERT returns session UUID
 *   - `next/headers`               → async cookie store with get/set/delete
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist all mock factories so they are available before vi.mock() runs
// ---------------------------------------------------------------------------

const {
  mockSearchFixturesByDateRange,
  mockFetchFixtureOdds,
  mockCreateServerClient,
  cookieStore,
} = vi.hoisted(() => {
  // ── Cookie store ──────────────────────────────────────────────────────────
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
    mockSearchFixturesByDateRange: vi.fn(),
    mockFetchFixtureOdds:          vi.fn(),
    mockCreateServerClient:        vi.fn(),
    cookieStore:                   store,
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

vi.mock('@/lib/football-api/client', () => ({
  searchFixturesByDateRange: (...args: unknown[]) => mockSearchFixturesByDateRange(...args),
  fetchFixtureOdds:          (...args: unknown[]) => mockFetchFixtureOdds(...args),
}))

// Import route handlers AFTER mocks are registered
import { POST as screenPOST }   from '@/app/api/screen/route'
import { POST as generatePOST } from '@/app/api/generate/route'

// ---------------------------------------------------------------------------
// Test fixtures — 10 fixtures whose odds all pass G1–G4
// ---------------------------------------------------------------------------

/**
 * Gate thresholds (from gate-screener.ts):
 *   G1: Over 0.5  < 1.15   → use 1.10  ✓
 *   G2: Under 0.5 > 5.00   → use 6.00  ✓
 *   G3: BTTS Yes  1.50–1.80 AND BTTS No 1.80–2.20
 *       → use BTTS Yes 1.65 and BTTS No 2.00  ✓
 *   G4: DC 12     < 1.40   → use 1.30  ✓
 *
 * Additional 1X2 Home/Away odds and OVER_UNDER_2.5 are included so the
 * OddsValueSchema (which only allows 6 specific market enum values) is
 * satisfied. The gate screener reads from the OddsValue[].label values
 * directly via buildOddsMap() in the screen route, so labels are the key.
 *
 * NOTE: OddsValueSchema constrains market to one of the 6 known MarketType
 * values. We map our gate-relevant odds to the nearest valid market:
 *   - 'Over 0.5'  / 'Under 0.5' → OVER_UNDER_1.5 (any Over/Under market works;
 *     the gate screener only looks at the label string, not the market enum)
 *   - 'BTTS Yes'  / 'BTTS No'   → BTTS
 *   - 'DC 12'                   → 1X2  (gate screener reads label 'DC 12')
 */
function makeFixtureOdds() {
  return [
    { bookmaker: 'sportybet', market: 'OVER_UNDER_1.5' as const, label: 'Over 0.5',  value: 1.10 },
    { bookmaker: 'sportybet', market: 'OVER_UNDER_1.5' as const, label: 'Under 0.5', value: 6.00 },
    { bookmaker: 'sportybet', market: 'BTTS'           as const, label: 'BTTS Yes',  value: 1.65 },
    { bookmaker: 'sportybet', market: 'BTTS'           as const, label: 'BTTS No',   value: 2.00 },
    { bookmaker: 'sportybet', market: '1X2'            as const, label: 'DC 12',     value: 1.30 },
    // Extra odds for market detection coverage (≥6 fixtures must carry BTTS Yes/No)
    { bookmaker: 'sportybet', market: '1X2'            as const, label: 'Home',      value: 1.80 },
    { bookmaker: 'sportybet', market: '1X2'            as const, label: 'Away',      value: 2.10 },
    { bookmaker: 'sportybet', market: 'OVER_UNDER_2.5' as const, label: 'Over 2.5',  value: 1.90 },
    { bookmaker: 'sportybet', market: 'OVER_UNDER_2.5' as const, label: 'Under 2.5', value: 1.95 },
  ]
}

/** Build the 10 test fixtures returned by the mocked Football API */
function makeTestFixtures() {
  return Array.from({ length: 10 }, (_, i) => ({
    id:       100 + i,
    homeTeam: `Home Team ${i + 1}`,
    awayTeam: `Away Team ${i + 1}`,
    league:   'Test League',
    leagueId: 999,
    kickoff:  `2026-07-01T${String(10 + i).padStart(2, '0')}:00:00Z`,
    odds:     [],          // odds populated separately by fetchFixtureOdds mock
  }))
}

const TEST_FIXTURES = makeTestFixtures()
const GROUP_UUID    = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SESSION_UUID  = 'cccccccc-dddd-eeee-ffff-000000000001'

// ---------------------------------------------------------------------------
// Supabase builder helpers
// ---------------------------------------------------------------------------

/**
 * Builds a chainable Supabase builder that supports the exact call chains used
 * by the screen route and the generate route.
 *
 * Screen route calls (on a fresh client per call site):
 *   A. from('session_groups').select('claimed_fixture_ids').in('status', [...])
 *      → { data: [], error: null }
 *   B. from('session_groups').insert({...}).select('id').single()
 *      → { data: { id: GROUP_UUID }, error: null }
 *
 * Generate route (handleV2) calls:
 *   C. from('session_groups').select('id, status').eq('id', groupId).maybeSingle()
 *      → { data: { id: GROUP_UUID, status: 'screening' }, error: null }
 *
 * Generate route (persistAndReturn) calls a second createServerClient():
 *   D. from('sessions').insert({...}).select('id').single()
 *      → { data: { id: SESSION_UUID }, error: null }
 *   E. from('session_groups').update({...}).eq('id', groupId)
 *      → awaitable no-op
 */
function makeScreenSupabaseClient() {
  // Track which insert call we are handling via a simple counter
  return {
    from(table: string) {
      if (table === 'session_groups') {
        return {
          // Chain A: SELECT claimed_fixture_ids … IN status
          select(_fields: string) {
            return {
              in(_col: string, _vals: string[]) {
                return Promise.resolve({ data: [], error: null })
              },
              eq(_col: string, _val: unknown) {
                return {
                  maybeSingle: () =>
                    Promise.resolve({ data: { id: GROUP_UUID, status: 'screening' }, error: null }),
                }
              },
            }
          },
          // Chain B: INSERT … SELECT id … single()
          insert(_data: unknown) {
            return {
              select(_fields: string) {
                return {
                  single: () =>
                    Promise.resolve({ data: { id: GROUP_UUID }, error: null }),
                }
              },
            }
          },
          // Chain for update (used by persistAndReturn)
          update(_data: unknown) {
            return {
              eq(_col: string, _val: unknown) {
                return Promise.resolve({ data: null, error: null })
              },
            }
          },
          neq(_col: string, _val: unknown) {
            return Promise.resolve({ data: [], error: null })
          },
        }
      }

      if (table === 'sessions') {
        return {
          insert(_data: unknown) {
            return {
              select(_fields: string) {
                return {
                  single: () =>
                    Promise.resolve({ data: { id: SESSION_UUID }, error: null }),
                }
              },
            }
          },
        }
      }

      throw new Error(`Unexpected Supabase table in screen client: "${table}"`)
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  cookieStore._reset()

  // Football API mocks
  mockSearchFixturesByDateRange.mockResolvedValue(TEST_FIXTURES)
  mockFetchFixtureOdds.mockResolvedValue({
    odds:             makeFixtureOdds(),
    oddsUnavailable:  false,
  })

  // Supabase mock — same client handles both screen and generate tables
  mockCreateServerClient.mockImplementation(() => makeScreenSupabaseClient())
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

// ===========================================================================
// Integration: Screen → Generate
// ===========================================================================

describe('Integration: POST /api/screen → POST /api/generate (v2)', () => {
  it('screen qualifies top-8 fixtures and generate produces 42 slips with correct tier distribution', async () => {
    // ── Step 1: POST /api/screen ────────────────────────────────────────────
    const screenRes = await screenPOST(
      jsonRequest('http://localhost/api/screen', {
        bookmaker: 'sportybet',
        date_from: '2026-07-01',
        date_to:   '2026-07-01',
      }),
    )

    expect(screenRes.status).toBe(200)

    const screenBody = await screenRes.json()

    // groupId must be a valid UUID
    expect(typeof screenBody.groupId).toBe('string')
    expect(screenBody.groupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    // v3: all fixtures are profiled (no rejection), top-8 are returned
    expect(Array.isArray(screenBody.qualifyingFixtures)).toBe(true)
    expect(screenBody.qualifyingFixtures.length).toBe(8)

    // All returned fixtures must have a valid profile (not a gateResult)
    for (const profiled of screenBody.qualifyingFixtures) {
      expect(['GOAL_CERTAIN', 'BALANCED', 'DEFENSIVE']).toContain(profiled.profile)
    }

    const { groupId, qualifyingFixtures } = screenBody as {
      groupId: string
      qualifyingFixtures: Array<{ fixture: (typeof TEST_FIXTURES)[0]; profile: string }>
    }
    const top8Fixtures = qualifyingFixtures.map((p) => p.fixture)

    // ── Step 2: POST /api/generate (v2 body) ───────────────────────────────
    const BANKROLL = 10000

    const generateRes = await generatePOST(
      jsonRequest('http://localhost/api/generate', {
        groupId,
        fixtures:    top8Fixtures,
        bankroll:    BANKROLL,
        numAccounts: 7,
      }),
    )

    expect(generateRes.status).toBe(200)

    const genBody = await generateRes.json()

    // Requirements 7.1: 56 slips are generated (v3.1: 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS)
    expect(Array.isArray(genBody.slips)).toBe(true)
    expect(genBody.slips.length).toBe(56)

    // Requirements 7.2: tier distribution 30/8/14/4
    const coreSlips   = genBody.slips.filter((s: { tier: string }) => s.tier === 'CORE')
    const pivotSlips  = genBody.slips.filter((s: { tier: string }) => s.tier === 'PIVOT')
    const bridgeSlips = genBody.slips.filter((s: { tier: string }) => s.tier === 'BRIDGE')
    const chaosSlips  = genBody.slips.filter((s: { tier: string }) => s.tier === 'CHAOS')

    expect(coreSlips.length).toBe(30)
    expect(pivotSlips.length).toBe(8)
    expect(bridgeSlips.length).toBe(14)
    expect(chaosSlips.length).toBe(4)

    // Requirements 4.6: dominantMarket must be detected and present
    expect(genBody.dominantMarket).toBeDefined()
    expect(genBody.dominantMarket).not.toBeNull()
    expect(typeof genBody.dominantMarket.dominantOutcome).toBe('string')
    expect(typeof genBody.dominantMarket.breakoutOutcome).toBe('string')

    // Requirements 5.2: tierAllocation.total must equal bankroll
    expect(genBody.tierAllocation).toBeDefined()
    expect(genBody.tierAllocation.total).toBe(BANKROLL)

    // sessionId must be present
    expect(typeof genBody.sessionId).toBe('string')
  })
})

