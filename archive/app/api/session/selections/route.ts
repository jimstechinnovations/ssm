/**
 * app/api/session/selections/route.ts
 *
 * Draft selection upsert / delete handler.
 *
 * POST  — Add or replace a MatchSelection in the active draft session.
 * DELETE — Remove a selection by fixtureId from the active draft session.
 *
 * Cookie access uses the async Next.js 15+ API:
 *   const cookieStore = await cookies()
 *
 * Requirements: 4.2, 6.3, 6.4, 12.4
 */

import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'
import { MatchSelectionSchema } from '@/lib/ssm/schemas'
import type { MatchSelectionInput } from '@/lib/ssm/schemas'

const COOKIE_NAME = 'ssm_session_id'

// ---------------------------------------------------------------------------
// POST — Add or update a selection (Requirements 4.2, 6.3, 12.4)
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  // Validate request body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parseResult = MatchSelectionSchema.safeParse(body)
  if (!parseResult.success) {
    return Response.json(
      { error: 'Validation failed', details: parseResult.error.flatten() },
      { status: 400 }
    )
  }

  const selection: MatchSelectionInput = parseResult.data

  // Read session cookie
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(COOKIE_NAME)?.value

  if (!sessionId) {
    return Response.json({ error: 'No active session' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Fetch existing draft_sessions row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: draft, error: fetchError } = (await supabase
    .from('draft_sessions')
    .select('selections')
    .eq('id', sessionId)
    .maybeSingle()) as { data: { selections: MatchSelectionInput[] } | null; error: unknown }

  if (fetchError || draft === null) {
    return Response.json({ error: 'Session not found' }, { status: 503 })
  }

  const existing: MatchSelectionInput[] = Array.isArray(draft.selections)
    ? draft.selections
    : []

  // Replace selection with same fixture.id, or append if new
  const fixtureId = selection.fixture.id
  const idx = existing.findIndex((s) => s.fixture.id === fixtureId)
  const updatedSelections =
    idx !== -1
      ? [...existing.slice(0, idx), selection, ...existing.slice(idx + 1)]
      : [...existing, selection]

  // Upsert updated selections array back to draft_sessions
  const { error: updateError } = await supabase
    .from('draft_sessions')
    .update({ selections: updatedSelections } as never)
    .eq('id', sessionId)

  if (updateError) {
    return Response.json({ error: 'Failed to update session' }, { status: 503 })
  }

  return Response.json({ success: true })
}

// ---------------------------------------------------------------------------
// DELETE — Remove a selection by fixtureId (Requirements 4.2, 6.4, 12.4)
// ---------------------------------------------------------------------------

export async function DELETE(request: Request): Promise<Response> {
  // Read fixtureId from query params
  const { searchParams } = new URL(request.url)
  const fixtureIdParam = searchParams.get('fixtureId')

  if (!fixtureIdParam) {
    return Response.json({ error: 'Missing fixtureId query param' }, { status: 400 })
  }

  const fixtureId = Number(fixtureIdParam)
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
    return Response.json({ error: 'Invalid fixtureId' }, { status: 400 })
  }

  // Read session cookie
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(COOKIE_NAME)?.value

  if (!sessionId) {
    return Response.json({ error: 'No active session' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Fetch existing draft_sessions row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: draft, error: fetchError } = (await supabase
    .from('draft_sessions')
    .select('selections')
    .eq('id', sessionId)
    .maybeSingle()) as { data: { selections: MatchSelectionInput[] } | null; error: unknown }

  if (fetchError || draft === null) {
    return Response.json({ error: 'Session not found' }, { status: 503 })
  }

  const existing: MatchSelectionInput[] = Array.isArray(draft.selections)
    ? draft.selections
    : []

  // Filter out the matching fixtureId
  const updatedSelections = existing.filter((s) => s.fixture.id !== fixtureId)

  // Upsert the filtered array back
  const { error: updateError } = await supabase
    .from('draft_sessions')
    .update({ selections: updatedSelections } as never)
    .eq('id', sessionId)

  if (updateError) {
    return Response.json({ error: 'Failed to update session' }, { status: 503 })
  }

  return Response.json({ success: true })
}
