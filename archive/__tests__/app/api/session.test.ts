/**
 * Unit tests for app/api/session/route.ts
 *
 * Validates: Requirements 4.1, 4.5, 4.6
 *
 * Mocks:
 *   - `next/headers`           → fake cookie store (get / set / delete)
 *   - `@/lib/supabase/server`  → chainable mock query builder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Cookie store mock
// ---------------------------------------------------------------------------

/** Mutable store shared across all mock calls within a single test */
const cookieStore = {
  _jar: {} as Record<string, string>,
  get(name: string) {
    const value = this._jar[name]
    return value !== undefined ? { value } : undefined
  },
  set(name: string, value: string, _opts?: unknown) {
    this._jar[name] = value
  },
  delete(name: string) {
    delete this._jar[name]
  },
  _reset() {
    this._jar = {}
  },
}

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(cookieStore)),
}))

// ---------------------------------------------------------------------------
// Supabase mock – chainable query builder
// ---------------------------------------------------------------------------

/**
 * Factory that creates a fresh chainable builder for a single query chain.
 * The terminal method (`.single()`, `.maybeSingle()`, or implicit `.eq()`)
 * resolves to the provided `result`.
 */
function makeBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {}
  const chain = () => builder

  builder.select = vi.fn(chain)
  builder.insert = vi.fn(chain)
  builder.delete = vi.fn(chain)
  builder.eq = vi.fn(chain)
  builder.single = vi.fn(() => Promise.resolve(result))
  builder.maybeSingle = vi.fn(() => Promise.resolve(result))

  return builder
}

/**
 * The mock Supabase client keeps a map of table name → builder so each `from()`
 * call can return a predictable result.
 */
let supabaseTables: Map<string, ReturnType<typeof makeBuilder>>

const mockCreateServerClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => mockCreateServerClient(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake Request (route handlers ignore the body for GET/DELETE) */
function fakeRequest(method = 'GET'): Request {
  return new Request('http://localhost/api/session', { method })
}

/** Wire up the mock Supabase client to forward `.from(table)` to the table map */
function setupSupabase(tables: Map<string, ReturnType<typeof makeBuilder>>) {
  supabaseTables = tables
  mockCreateServerClient.mockReturnValue({
    from: vi.fn((table: string) => {
      const builder = tables.get(table)
      if (!builder) {
        throw new Error(`Unexpected Supabase table access: "${table}"`)
      }
      return builder
    }),
  })
}

// ---------------------------------------------------------------------------
// Import route handlers (after mocks are set up)
// ---------------------------------------------------------------------------
import { GET, POST, DELETE } from '../../../app/api/session/route'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  cookieStore._reset()
  vi.clearAllMocks()
})

// ===========================================================================
// GET /api/session
// ===========================================================================

describe('GET /api/session', () => {
  it('1. returns { session: null } when no ssm_session_id cookie is present', async () => {
    // No tables should be hit — cookie is absent
    setupSupabase(new Map())

    const response = await GET(fakeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ session: null })
  })

  it('2. returns session data when cookie exists and sessions row is found', async () => {
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000001'
    cookieStore._jar['ssm_session_id'] = uuid

    const sessionRow = { id: uuid, slips: [], distribution: [] }

    const sessionsBuilder = makeBuilder({ data: sessionRow, error: null })
    const draftBuilder = makeBuilder({ data: null, error: null })

    setupSupabase(
      new Map([
        ['sessions', sessionsBuilder],
        ['draft_sessions', draftBuilder],
      ]),
    )

    const response = await GET(fakeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ session: sessionRow })
    // draft_sessions should NOT be queried when sessions row is found
    expect(draftBuilder.select).not.toHaveBeenCalled()
  })

  it('3. falls back to draft_sessions when sessions row is absent', async () => {
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000002'
    cookieStore._jar['ssm_session_id'] = uuid

    const draftRow = { id: uuid, selections: [], config: {} }

    const sessionsBuilder = makeBuilder({ data: null, error: null })
    const draftBuilder = makeBuilder({ data: draftRow, error: null })

    setupSupabase(
      new Map([
        ['sessions', sessionsBuilder],
        ['draft_sessions', draftBuilder],
      ]),
    )

    const response = await GET(fakeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ session: draftRow })
  })

  it('4. returns { session: null } when cookie exists but neither table has the row', async () => {
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000003'
    cookieStore._jar['ssm_session_id'] = uuid

    const sessionsBuilder = makeBuilder({ data: null, error: null })
    const draftBuilder = makeBuilder({ data: null, error: null })

    setupSupabase(
      new Map([
        ['sessions', sessionsBuilder],
        ['draft_sessions', draftBuilder],
      ]),
    )

    const response = await GET(fakeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ session: null })
  })
})

// ===========================================================================
// POST /api/session
// ===========================================================================

describe('POST /api/session', () => {
  it('5. creates a draft session, sets httpOnly cookie, and returns { id: uuid }', async () => {
    const newUuid = 'bbbbbbbb-0000-0000-0000-000000000001'

    const draftBuilder = makeBuilder({ data: { id: newUuid }, error: null })

    setupSupabase(new Map([['draft_sessions', draftBuilder]]))

    const setCookieSpy = vi.spyOn(cookieStore, 'set')

    const response = await POST(fakeRequest('POST'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ id: newUuid })

    // Cookie must be set with httpOnly: true
    expect(setCookieSpy).toHaveBeenCalledOnce()
    const [cookieName, cookieValue, cookieOptions] = setCookieSpy.mock.calls[0]
    expect(cookieName).toBe('ssm_session_id')
    expect(cookieValue).toBe(newUuid)
    expect((cookieOptions as Record<string, unknown>).httpOnly).toBe(true)
  })

  it('6. returns 503 when Supabase insert fails', async () => {
    const draftBuilder = makeBuilder({ data: null, error: { message: 'DB error' } })

    setupSupabase(new Map([['draft_sessions', draftBuilder]]))

    const response = await POST(fakeRequest('POST'))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toHaveProperty('error')
  })
})

// ===========================================================================
// DELETE /api/session
// ===========================================================================

describe('DELETE /api/session', () => {
  it('7. returns { success: true } when no cookie is present (idempotent)', async () => {
    // No Supabase tables should be touched
    setupSupabase(new Map())

    const response = await DELETE(fakeRequest('DELETE'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true })
  })

  it('8. deletes both tables and clears cookie, returns { success: true }', async () => {
    const uuid = 'cccccccc-0000-0000-0000-000000000001'
    cookieStore._jar['ssm_session_id'] = uuid

    // Both tables need delete chains; use simple builders that resolve successfully
    const sessionsDeleteBuilder = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
    }
    const draftDeleteBuilder = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
    }

    mockCreateServerClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'sessions') return sessionsDeleteBuilder
        if (table === 'draft_sessions') return draftDeleteBuilder
        throw new Error(`Unexpected table: "${table}"`)
      }),
    })

    const deleteCookieSpy = vi.spyOn(cookieStore, 'delete')

    const response = await DELETE(fakeRequest('DELETE'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true })

    // Both tables must have been targeted
    expect(sessionsDeleteBuilder.delete).toHaveBeenCalled()
    expect(sessionsDeleteBuilder.eq).toHaveBeenCalledWith('id', uuid)

    expect(draftDeleteBuilder.delete).toHaveBeenCalled()
    expect(draftDeleteBuilder.eq).toHaveBeenCalledWith('id', uuid)

    // Cookie must be cleared
    expect(deleteCookieSpy).toHaveBeenCalledWith('ssm_session_id')
    expect(cookieStore._jar['ssm_session_id']).toBeUndefined()
  })
})
