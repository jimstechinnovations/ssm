/**
 * app/api/groups/route.ts
 *
 * Session Group CRUD — GET (list all) + POST (create) handlers.
 * DELETE for a specific group lives in app/api/groups/[id]/route.ts
 *
 * Requirements: 6.1, 6.4, 6.6, 10.6
 */

import { z } from 'zod'
import { createServerClient } from '@/lib/supabase/server'
import { BookmakerPlatformSchema } from '@/lib/ssm/schemas'

// ─── Validation ───────────────────────────────────────────────────────────────

const CreateGroupSchema = z.object({
  bookmaker: BookmakerPlatformSchema,
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bankroll:  z.number().int().positive().optional().default(10000),
  num_accounts: z.union([z.literal(6), z.literal(7)]).optional().default(7),
})

// ─── GET — list all active session groups ────────────────────────────────────

export async function GET(_request: Request): Promise<Response> {
  const supabase = createServerClient()

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase
      .from('session_groups')
      .select('*')
      .in('status', ['screening', 'generated', 'printed'])
      .order('created_at', { ascending: false })) as {
        data: unknown[] | null
        error: { message?: string } | null
      }

    if (error) {
      return Response.json({
        groups: [],
        warning: 'Failed to load session groups',
        detail: error.message ?? 'Supabase query failed',
      })
    }

    return Response.json({ groups: data ?? [] })
  } catch (err) {
    return Response.json({
      groups: [],
      warning: 'Failed to load session groups',
      detail: err instanceof Error ? err.message : 'Supabase request failed',
    })
  }
}

// ─── POST — create a new session group ───────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CreateGroupSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  const { bookmaker, date_from, date_to, bankroll, num_accounts } = parsed.data
  const supabase = createServerClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase
    .from('session_groups')
    .insert({
      status:              'screening',
      bookmaker,
      date_from,
      date_to,
      bankroll,
      num_accounts,
      claimed_fixture_ids: [],
    } as never)
    .select('*')
    .single()) as { data: unknown | null; error: unknown }

  if (error || !data) {
    return Response.json({ error: 'Failed to create session group' }, { status: 503 })
  }

  return Response.json({ group: data })
}
