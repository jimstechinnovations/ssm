/**
 * POST /api/sessions/[id]/clone — duplicate a session (same games/slips/params) into a new session
 * id so the identical book can be placed independently (parallel / horizontal scaling).
 */

import { cloneSession, sessionSummary } from '@/lib/sessions/store'

export const runtime = 'nodejs'

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const clone = await cloneSession(id)
  if (!clone) return Response.json({ error: 'Could not clone (unknown session or DB error)' }, { status: 404 })
  return Response.json({ session: clone, summary: await sessionSummary(clone.id) })
}
