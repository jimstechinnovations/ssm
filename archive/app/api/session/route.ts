/**
 * app/api/session/route.ts
 *
 * Session CRUD handler — reads/writes the `ssm_session_id` HTTP-only cookie
 * and the Supabase `draft_sessions` / `sessions` tables.
 *
 * All cookie access uses the async Next.js 15+ API:
 *   const cookieStore = await cookies()
 *
 * Requirements: 4.1, 4.5, 4.6, 12.4, 12.6
 */

import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'

const COOKIE_NAME = 'ssm_session_id'

const COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/',
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
}

// ---------------------------------------------------------------------------
// GET — Load active session (Requirement 4.5)
// ---------------------------------------------------------------------------

export async function GET(_request: Request): Promise<Response> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(COOKIE_NAME)?.value

  if (!sessionId) {
    return Response.json({ session: null })
  }

  const supabase = createServerClient()

  // Try the `sessions` table first (completed, generated matrix)
  const { data: sessionData, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle()

  if (!sessionError && sessionData) {
    return Response.json({ session: sessionData })
  }

  // Fall back to `draft_sessions` (in-progress selections)
  const { data: draftData, error: draftError } = await supabase
    .from('draft_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle()

  if (!draftError && draftData) {
    return Response.json({ session: draftData })
  }

  // Row not found in either table
  return Response.json({ session: null })
}

// ---------------------------------------------------------------------------
// POST — Create new draft session (Requirement 4.1)
// ---------------------------------------------------------------------------

export async function POST(_request: Request): Promise<Response> {
  const supabase = createServerClient()

  // The Supabase client is untyped (no generated DB types), so we cast the
  // result to access the returned `id` column safely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await supabase
    .from('draft_sessions')
    .insert({ selections: [], config: {} } as never)
    .select('id')
    .single()) as { data: { id: string } | null; error: unknown }

  if (error || !data) {
    return Response.json(
      { error: 'Failed to create session' },
      { status: 503 }
    )
  }

  const uuid: string = data.id

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, uuid, COOKIE_OPTIONS)

  return Response.json({ id: uuid })
}

// ---------------------------------------------------------------------------
// DELETE — Flush active session (Requirement 4.6)
// ---------------------------------------------------------------------------

export async function DELETE(_request: Request): Promise<Response> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(COOKIE_NAME)?.value

  // Idempotent — no cookie means nothing to delete
  if (!sessionId) {
    return Response.json({ success: true })
  }

  const supabase = createServerClient()

  // Attempt delete from `sessions` table first
  await supabase.from('sessions').delete().eq('id', sessionId)

  // Then attempt delete from `draft_sessions` (one of these will be a no-op)
  await supabase.from('draft_sessions').delete().eq('id', sessionId)

  // Clear the cookie regardless of whether the row existed
  cookieStore.delete(COOKIE_NAME)

  return Response.json({ success: true })
}
