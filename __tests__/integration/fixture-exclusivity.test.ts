/**
 * Integration test: fixture exclusivity across session groups
 *
 * Validates: Requirements 6.2, 6.3
 *
 * Flow:
 *   1. POST /api/screen (Group A) → qualifies 8 of 10 known fixtures, claims top-8 IDs
 *   2. POST /api/screen (Group B, same date range) → the mock returns Group A's claimed IDs
 *      as an active group's claimed_fixture_ids, so Group B's unclaimed pool has only 2 fixtures
 *      (< 8 threshold) and its qualifyingFixtures (top-8 unclaimed, capped) do NOT overlap
 *      with Group A's claimedFixtureIds
 *
 * Mock strategy (vi.hoisted + vi.mock — same pattern as screen-to-generate.test.ts):
 *   - `@/lib/football-api/client`  → deterministic 10-fixture set with odds that pass all 4 gates
 *   - `@/lib/supabase/server`      → stateful in-memory builder:
 *       • Group A INSERT returns GROUP_A_UUID; subsequent SELECT for active groups returns
 *         Group A's claimed IDs so Group B can see them
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
  supabaseState,
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

  // ── Shared stateful store — tracks what Group A claimed ───────────────────
  const state = {
    /** IDs claimed by Group A after its INSERT completes */
    groupAClaimedIds: [] as number[],
    /** Reset between tests */
    _reset() {
      state.groupAClaimedIds = []
    },
  }

  return {
    mockSearchFixturesByDateRange: vi.fn(),
    mockFetchFixtureOdds:          vi.fn(),
    mockCreateServerClient:        vi.fn(),
    cookieStore:                   store,
    supabaseState:                 state,
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

// Import route handler AFTER mocks are registered
import { POST as screenPOST } from '@/app/api/screen/route'

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
 */
function makeFixtureOdds() {
  return [
    { bookmaker: 'sportybet', market: 'OVER_UNDER_1.5' as const, label: 'Over 0.5',  value: 1.10 },
    { bookmaker: 'sportybet', market: 'OVER_UNDER_1.5' as const, label: 'Under 0.5', value: 6.00 },
    { bookmaker: 'sportybet', market: 'BTTS'           as const, label: 'BTTS Yes',  value: 1.65 },
    { bookmaker: 'sportybet', market: 'BTTS'           as const, label: 'BTTS No',   value: 2.00 },
    { bookmaker: 'sportybet', market: '1X2'            as const, label: 'DC 12',     value: 1.30 },
    { bookmaker: 'sportybet', market: '1X2'            as const, label: 'Home',      value: 1.80 },
    { bookmaker: 'sportybet', market: '1X2'            as const, label: 'Away',      value: 2.10 },
    { bookmaker: 'sportybet', market: 'OVER_UNDER_2.5' as const, label: 'Over 2.5',  value: 1.90 },
    { bookmaker: 'sportybet', market: 'OVER_UNDER_2.5' as const, label: 'Under 2.5', value: 1.95 },
  ]
}

/** Build the 10 test fixtures returned by the mocked Football API */
function makeTestFixtures() {
  return Array.from({ length: 10 }, (_, i) => ({
    id:       100 + i,        // IDs: 100, 101, 102, ..., 109
    homeTeam: `Home Team ${i + 1}`,
    awayTeam: `Away Team ${i + 1}`,
    league:   'Test League',
    leagueId: 999,
    kickoff:  `2026-07-01T${String(10 + i).padStart(2, '0')}:00:00Z`,
    odds:     [],
  }))
}

const TEST_FIXTURES = makeTestFixtures()

// Group UUIDs as specified
const GROUP_A_UUID = 'group-a-uuid-1111-1111-111111111111'
const GROUP_B_UUID = 'group-b-uuid-2222-2222-222222222222'

// ---------------------------------------------------------------------------
// Supabase builder helpers
// ---------------------------------------------------------------------------

/**
 * Builds a stateful Supabase builder.
 *
 * The `callCount` counter distinguishes the two sequential INSERT calls:
 *   - Call 1 (Group A screen): SELECT claimed_fixture_ids → empty (no active groups yet)
 *                              INSERT session_groups → GROUP_A_UUID
 *                              After INSERT: supabaseState.groupAClaimedIds is populated
 *   - Call 2 (Group B screen): SELECT claimed_fixture_ids → returns Group A's claimed IDs
 *                              INSERT session_groups → GROUP_B_UUID
 *
 * A new client instance is created per createServerClient() call, but they share
 * the supabaseState reference (hoisted), so Group B's SELECT sees Group A's data.
 */
function makeSupabaseClient(instanceId: 'A' | 'B') {
  return {
    from(table: string) {
      if (table === 'session_groups') {
        return {
          // Chain: SELECT claimed_fixture_ids … IN status
          select(_fields: string) {
            return {
              in(_col: string, _vals: string[]) {
                // Group B sees Group A's claimed IDs; Group A sees nothing
                if (instanceId === 'B' && supabaseState.groupAClaimedIds.length > 0) {
                  return Promise.resolve({
                    data: [{ claimed_fixture_ids: supabaseState.groupAClaimedIds }],
                    error: null,
                  })
                }
                return Promise.resolve({ data: [], error: null })
              },
              eq(_col: string, _val: unknown) {
                return {
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }
              },
            }
          },
          // Chain: INSERT … SELECT id … single()
          insert(data: { claimed_fixture_ids?: number[] }) {
            return {
              select(_fields: string) {
                return {
                  single: () => {
                    if (instanceId === 'A') {
                      // Record what Group A claimed so Group B can see it
                      supabaseState.groupAClaimedIds = data.claimed_fixture_ids ?? []
                      return Promise.resolve({ data: { id: GROUP_A_UUID }, error: null })
                    }
                    return Promise.resolve({ data: { id: GROUP_B_UUID }, error: null })
                  },
                }
              },
            }
          },
          // update / neq (used on re-screen path — not exercised here)
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

      throw new Error(`Unexpected Supabase table in fixture-exclusivity test: "${table}"`)
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  cookieStore._reset()
  supabaseState._reset()

  // Football API mocks — same 10 fixtures for both calls
  mockSearchFixturesByDateRange.mockResolvedValue(TEST_FIXTURES)
  mockFetchFixtureOdds.mockResolvedValue({
    odds:            makeFixtureOdds(),
    oddsUnavailable: false,
  })

  // Supabase mock — alternates between Group A and Group B instances
  let callCount = 0
  mockCreateServerClient.mockImplementation(() => {
    const instance = callCount === 0 ? 'A' : 'B'
    callCount++
    return makeSupabaseClient(instance)
  })
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
// Integration: Fixture Exclusivity
// ===========================================================================

describe('Integration: fixture exclusivity across session groups', () => {
  it('Group B qualifyingFixtures do not overlap with Group A claimedFixtureIds (Req 6.2, 6.3)', async () => {
    const screenBody = {
      bookmaker: 'sportybet',
      date_from: '2026-07-01',
      date_to:   '2026-07-01',
    }

    // ── Step 1: Group A screens ─────────────────────────────────────────────
    const resA = await screenPOST(jsonRequest('http://localhost/api/screen', screenBody))

    expect(resA.status).toBe(200)

    const bodyA = await resA.json() as {
      groupId:             string
      qualifyingFixtures:  Array<{ fixture: { id: number }; profile: string }>
      claimedFixtureIds?:  number[]
      unclaimedQualifying: number
    }

    // Group A gets its UUID
    expect(bodyA.groupId).toBe(GROUP_A_UUID)

    // All 10 fixtures have odds → all are profiled → top-8 returned
    expect(bodyA.qualifyingFixtures.length).toBe(8)
    for (const profiled of bodyA.qualifyingFixtures) {
      // v3: every fixture gets a profile (no rejection)
      expect(['GOAL_CERTAIN', 'BALANCED', 'DEFENSIVE']).toContain(profiled.profile)
    }

    // The IDs that Group A claimed are the top-8 fixture IDs (sorted by kickoff: 100–107)
    const groupAClaimedIds = bodyA.qualifyingFixtures.map((p: { fixture: { id: number } }) => p.fixture.id)

    // Confirm supabaseState was populated (verifies the mock captured the insert data)
    expect(supabaseState.groupAClaimedIds).toEqual(groupAClaimedIds)
    expect(supabaseState.groupAClaimedIds.length).toBe(8)

    // ── Step 2: Group B screens (same date range) ───────────────────────────
    const resB = await screenPOST(jsonRequest('http://localhost/api/screen', screenBody))

    expect(resB.status).toBe(200)

    const bodyB = await resB.json() as {
      groupId:             string
      qualifyingFixtures:  Array<{ fixture: { id: number }; profile: string }>
      unclaimedQualifying: number
    }

    // Group B gets its own UUID
    expect(bodyB.groupId).toBe(GROUP_B_UUID)

    // Requirement 6.3: Group B's qualifyingFixtures must NOT overlap with Group A's claimed IDs
    const groupAClaimedSet  = new Set(groupAClaimedIds)
    const groupBFixtureIds  = bodyB.qualifyingFixtures.map((p: { fixture: { id: number } }) => p.fixture.id)

    for (const id of groupBFixtureIds) {
      expect(groupAClaimedSet.has(id)).toBe(false)
    }

    // Requirement 6.2: Only 2 of 10 fixtures remain unclaimed → fewer than 8
    expect(bodyB.unclaimedQualifying).toBeLessThan(8)

    // All of Group B's fixtures still have a valid profile
    for (const profiled of bodyB.qualifyingFixtures) {
      expect(['GOAL_CERTAIN', 'BALANCED', 'DEFENSIVE']).toContain(profiled.profile)
    }
  })
})
