/**
 * GET /api/sessions/[id]/games — the pool games behind a session (the base slip's legs, all Under),
 * sorted by kickoff. Lets the user see exactly which fixtures a session is built on.
 */

import { getSession, listSessionSlips } from '@/lib/sessions/store'

export const runtime = 'nodejs'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  // slip 1 is the base (all Under) — its legs ARE the full pool.
  const [base] = await listSessionSlips(session.id, { withLegs: true, limit: 1 })
  const legs = (base?.legs as Array<{ fixtureId: number; game: string; league: string; kickoff: string; line: number; odds: number }> | undefined) ?? []
  const games = legs
    .map(l => ({ fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, line: l.line, underOdds: l.odds }))
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  return Response.json({ games, count: games.length })
}
