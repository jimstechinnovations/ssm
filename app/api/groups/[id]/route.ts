/**
 * app/api/groups/[id]/route.ts
 *
 * DELETE /api/groups/:id — Flush a specific session group.
 * Deletes the session_groups row, the linked sessions row (if any),
 * and clears the ssm_session_id cookie if it points to this group's session.
 *
 * Requirements: 6.1, 6.4, 10.6
 */

import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase/server'

const COOKIE_NAME = 'ssm_session_id'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params

  // Validate UUID
  const uuidSchema = z.string().uuid()
  if (!uuidSchema.safeParse(id).success) {
    return Response.json({ error: 'Invalid group ID' }, { status: 400 })
  }

  const supabase = createServerClient()

  // 1. Fetch the group to get linked session_id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: group, error: fetchErr } = await (supabase
    .from('session_groups')
    .select('id, session_id')
    .eq('id', id)
    .maybeSingle()) as { data: { id: string; session_id: string | null } | null; error: unknown }

  if (fetchErr) {
    return Response.json({ error: 'Failed to load group' }, { status: 503 })
  }

  if (!group) {
    // Already deleted — idempotent
    return Response.json({ success: true })
  }

  // 2. Delete the linked sessions row if present
  if (group.session_id) {
    await supabase.from('sessions').delete().eq('id', group.session_id)
  }

  // 3. Delete the session_groups row (FK cascade sets sessions.group_id = NULL)
  const { error: deleteErr } = await supabase
    .from('session_groups')
    .delete()
    .eq('id', id)

  if (deleteErr) {
    return Response.json({ error: 'Failed to delete group' }, { status: 503 })
  }

  // 4. Clear the cookie if it pointed to this group's session
  if (group.session_id) {
    const cookieStore = await cookies()
    const current = cookieStore.get(COOKIE_NAME)?.value
    if (current === group.session_id) {
      cookieStore.delete(COOKIE_NAME)
    }
  }

  return Response.json({ success: true })
}
