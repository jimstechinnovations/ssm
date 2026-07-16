/**
 * GET /api/sessions/[id] — one session with its slips + scoreboard.
 * Accepts the UUID or the S-XXXXXX code. Settle-on-load (pulling live results into won/lost) is a
 * later hook; for now this returns the persisted state so the UI can render + poll.
 */

import { getSession, listSessionSlips, sessionSummary } from '@/lib/sessions/store'

export const runtime = 'nodejs'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const [slips, summary] = await Promise.all([listSessionSlips(session.id), sessionSummary(session.id)])
  return Response.json({ session, slips, summary })
}
