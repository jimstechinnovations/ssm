/**
 * app/api/session/config/route.ts
 *
 * Session config PATCH handler — merges partial config updates into the
 * `draft_sessions.config` JSONB column.
 *
 * All cookie access uses the async Next.js 15+ API:
 *   const cookieStore = await cookies()
 *
 * Requirements: 4.3, 7.3, 12.4
 */

import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase/server'

const COOKIE_NAME = 'ssm_session_id'

// Partial config schema — all fields are optional but individually validated
const ConfigPatchSchema = z.object({
  stakePerSlip: z.number().positive().min(0.01).max(999999.99).optional(),
  numAccounts: z.union([z.literal(6), z.literal(7)]).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

// ---------------------------------------------------------------------------
// PATCH — Update session config (Requirements 4.3, 7.3, 12.4)
// ---------------------------------------------------------------------------

export async function PATCH(request: Request): Promise<Response> {
  // 1. Parse and validate request body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = ConfigPatchSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    )
  }

  // 2. Read session cookie
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(COOKIE_NAME)?.value

  if (!sessionId) {
    return Response.json({ error: 'No active session' }, { status: 400 })
  }

  const supabase = createServerClient()

  // 3. Fetch existing config from draft_sessions
  const { data: draft, error: fetchError } = (await supabase
    .from('draft_sessions')
    .select('config')
    .eq('id', sessionId)
    .maybeSingle()) as {
    data: { config: Record<string, unknown> } | null
    error: unknown
  }

  if (fetchError) {
    return Response.json({ error: 'Failed to fetch session' }, { status: 503 })
  }

  if (!draft) {
    return Response.json({ error: 'No active session' }, { status: 400 })
  }

  // 4. Shallow-merge new fields into existing config
  const existingConfig: Record<string, unknown> = draft.config ?? {}
  const mergedConfig = { ...existingConfig, ...parsed.data }

  // 5. Persist merged config
  const { error: updateError } = await supabase
    .from('draft_sessions')
    .update({ config: mergedConfig } as never)
    .eq('id', sessionId)

  if (updateError) {
    return Response.json({ error: 'Failed to update session' }, { status: 503 })
  }

  return Response.json({ success: true })
}
