/**
 * Integration test: session round-trip via in-memory Supabase mock
 *
 * Property 14: Selections Round-Trip via Supabase
 *
 * Validates: Requirements 4.2, 4.3, 4.5, 4.6
 *
 * Uses the same mock pattern as __tests__/app/api/session.test.ts:
 *   - `next/headers` → shared in-memory cookie jar
 *   - `@/lib/supabase/server` → in-memory draftsTable that persists between
 *     handler calls within a single test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Shared in-memory state
// ---------------------------------------------------------------------------

let draftsTable: Record<string, { id: string; selections: unknown[]; config: unknown }> = {}
let activeCookieJar: Record<string, string> = {}

// Reset before each test
beforeEach(() => {
  draftsTable = {}
  activeCookieJar = {}
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Cookie store mock — shared activeCookieJar
// ---------------------------------------------------------------------------

const cookieStore = {
  get(name: string) {
    const value = activeCookieJar[name]
    return value !== undefined ? { value } : undefined
  },
  set(name: string, value: string, _opts?: unknown) {
    activeCookieJar[name] = value
  },
  delete(name: string) {
    delete activeCookieJar[name]
  },
}

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(cookieStore)),
}))

// ---------------------------------------------------------------------------
// In-memory Supabase mock
// ---------------------------------------------------------------------------

/**
 * The mock createServerClient() returns a client where each call to .from()
 * delegates to the in-memory draftsTable.
 *
 * Supported chains:
 *
 *   draft_sessions:
 *     .insert(data).select('id').single()        → create row, return { id }
 *     .select('*').eq('id', id).maybeSingle()    → read row
 *     .select('selections').eq('id', id).maybeSingle() → read row (selections field)
 *     .update(data).eq('id', id)                 → update row
 *     .delete().eq('id', id)                     → remove row
 *
 *   sessions:
 *     .select('*').eq('id', id).maybeSingle()    → always null (no completed sessions)
 *     .delete().eq('id', id)                     → no-op
 */

function makeDraftSessionsClient() {
  // Each builder captures its operation type and resolves appropriately.
  const makeChain = (op: 'insert' | 'select' | 'update' | 'delete', payload?: unknown) => {
    let _eqId: string | null = null
    let _selectFields: string | null = null
    let _updateData: Record<string, unknown> | null = null

    if (op === 'select') _selectFields = payload as string
    if (op === 'update') _updateData = payload as Record<string, unknown>

    const chain = {
      select(fields: string) {
        _selectFields = fields
        return chain
      },
      eq(_col: string, id: string) {
        _eqId = id
        return chain
      },
      single(): Promise<{ data: unknown; error: unknown }> {
        if (op === 'insert') {
          const row = payload as { selections: unknown[]; config: unknown }
          const newRow = { id: 'draft-uuid-001', selections: row.selections ?? [], config: row.config ?? {} }
          draftsTable['draft-uuid-001'] = newRow
          return Promise.resolve({ data: { id: 'draft-uuid-001' }, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      maybeSingle(): Promise<{ data: unknown; error: null }> {
        if (op === 'select' && _eqId !== null) {
          const row = draftsTable[_eqId] ?? null
          return Promise.resolve({ data: row, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      // For update().eq() — the route handler awaits the result of .eq()
      then(resolve: (v: { data: null; error: null }) => void) {
        if (op === 'update' && _eqId !== null && _updateData !== null) {
          const existing = draftsTable[_eqId]
          if (existing) {
            draftsTable[_eqId] = { ...existing, ..._updateData }
          }
        }
        if (op === 'delete' && _eqId !== null) {
          delete draftsTable[_eqId]
        }
        resolve({ data: null, error: null })
      },
    }
    return chain
  }

  return {
    from(table: string) {
      if (table === 'draft_sessions') {
        return {
          insert(data: unknown) {
            return makeChain('insert', data)
          },
          select(fields: string) {
            return makeChain('select', fields)
          },
          update(data: unknown) {
            return makeChain('update', data)
          },
          delete() {
            return makeChain('delete')
          },
        }
      }

      if (table === 'sessions') {
        // No completed sessions in these tests
        return {
          select(_fields: string) {
            return {
              eq(_col: string, _id: string) {
                return {
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }
              },
            }
          },
          delete() {
            return {
              eq: (_col: string, _id: string) => Promise.resolve({ data: null, error: null }),
            }
          },
        }
      }

      throw new Error(`Unexpected Supabase table access: "${table}"`)
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => makeDraftSessionsClient(),
}))

// ---------------------------------------------------------------------------
// Import route handlers (after mocks are set up)
// ---------------------------------------------------------------------------

import { GET, POST, DELETE } from '../../app/api/session/route'
import { POST as POST_SEL } from '../../app/api/session/selections/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(method: string, body?: unknown): Request {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return new Request('http://localhost/api/session', init)
}

function selReq(body: unknown): Request {
  return new Request('http://localhost/api/session/selections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// A valid MatchSelection body
const validSelection = {
  fixture: {
    id: 42,
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    league: 'Premier League',
    leagueId: 39,
    kickoff: '2025-01-15T15:00:00+00:00',
    venue: 'Emirates Stadium',
    odds: [
      { bookmaker: 'Bet365', market: '1X2' as const, label: 'Home', value: 1.8 },
    ],
  },
  state0: { bookmaker: 'Bet365', market: '1X2' as const, label: 'Home', value: 1.8 },
  state1: { bookmaker: 'Bet365', market: '1X2' as const, label: 'Away', value: 2.5 },
  volatility: 0.3,
}

// ===========================================================================
// Test 1: POST creates draft → GET returns it
// ===========================================================================

describe('Test 1: POST creates draft → GET returns it', () => {
  it('creates a draft session and GET returns it with empty selections', async () => {
    // Step 1: POST /api/session
    const postRes = await POST(req('POST'))
    const postBody = await postRes.json()

    expect(postRes.status).toBe(200)
    expect(postBody).toEqual({ id: 'draft-uuid-001' })

    // Cookie must be set
    expect(activeCookieJar['ssm_session_id']).toBe('draft-uuid-001')

    // Step 2: GET /api/session → should return the draft row
    const getRes = await GET(req('GET'))
    const getBody = await getRes.json()

    expect(getRes.status).toBe(200)
    expect(getBody.session).toMatchObject({
      id: 'draft-uuid-001',
      selections: [],
      config: {},
    })
  })
})

// ===========================================================================
// Test 2: POST selections → GET returns selections
// ===========================================================================

describe('Test 2: POST selections → GET returns selections', () => {
  it('adds a selection via POST /api/session/selections and GET returns it', async () => {
    // Step 1: create draft
    await POST(req('POST'))
    expect(activeCookieJar['ssm_session_id']).toBe('draft-uuid-001')

    // Step 2: POST a selection
    const selRes = await POST_SEL(selReq(validSelection))
    const selBody = await selRes.json()

    expect(selRes.status).toBe(200)
    expect(selBody).toEqual({ success: true })

    // Step 3: GET /api/session → selections array contains the added selection
    const getRes = await GET(req('GET'))
    const getBody = await getRes.json()

    expect(getRes.status).toBe(200)
    expect(Array.isArray(getBody.session.selections)).toBe(true)
    expect(getBody.session.selections).toHaveLength(1)
    expect(getBody.session.selections[0].fixture.id).toBe(42)
    expect(getBody.session.selections[0].fixture.homeTeam).toBe('Arsenal')
    expect(getBody.session.selections[0].fixture.awayTeam).toBe('Chelsea')
  })
})

// ===========================================================================
// Test 3: DELETE clears session
// ===========================================================================

describe('Test 3: DELETE clears session', () => {
  it('DELETE removes the draft and clears cookie; subsequent GET returns null', async () => {
    // Step 1: create draft
    await POST(req('POST'))
    expect(activeCookieJar['ssm_session_id']).toBe('draft-uuid-001')

    // Step 2: DELETE /api/session
    const delRes = await DELETE(req('DELETE'))
    const delBody = await delRes.json()

    expect(delRes.status).toBe(200)
    expect(delBody).toEqual({ success: true })

    // Cookie must be cleared
    expect(activeCookieJar['ssm_session_id']).toBeUndefined()

    // Step 3: GET /api/session → session: null
    const getRes = await GET(req('GET'))
    const getBody = await getRes.json()

    expect(getRes.status).toBe(200)
    expect(getBody).toEqual({ session: null })
  })
})
