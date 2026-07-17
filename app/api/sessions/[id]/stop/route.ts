/**
 * POST /api/sessions/[id]/stop — ask a running placement to stop after the current slip.
 * The placer checks this flag between slips (via the slip-status report) and exits gracefully.
 * Already-placed slips stay placed; the session can be resumed later (idempotency skips them).
 */

import { getSession, requestStop } from '@/lib/sessions/store'

export const runtime = 'nodejs'

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const ok = await requestStop(session.id)
  return ok ? Response.json({ stopping: true }) : Response.json({ error: 'Could not request stop' }, { status: 500 })
}
