/**
 * GET /api/sessions/[id] — one session with its slips + scoreboard.
 * Accepts the UUID or the S-XXXXXX code. Settle-on-load (pulling live results into won/lost) is a
 * later hook; for now this returns the persisted state so the UI can render + poll.
 */

import { getSession, listSessionSlips, scoreboards } from '@/lib/sessions/store'

export const runtime = 'nodejs'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const url = new URL(request.url)
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 50))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  // withLegs=1 returns each slip's full legs (needed by the placer to build booking codes). The UI
  // omits legs for speed; only the out-of-process placer asks for them.
  const withLegs = url.searchParams.get('withLegs') === '1'
  const [slips, sb] = await Promise.all([
    listSessionSlips(session.id, { limit, offset, withLegs }),
    scoreboards([{ id: session.id, slipCount: session.slipCount }]),
  ])
  return Response.json({ session, slips, summary: sb[session.id], page: { offset, limit, total: session.slipCount ?? sb[session.id]?.slips ?? slips.length } })
}
