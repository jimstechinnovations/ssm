/**
 * GET /api/sessions/[id]/games — the pool games behind a session (the base slip's legs), sorted by
 * kickoff, each with recent total-goals history (both teams' last matches from the store) so the UI
 * can plot totals-vs-time and mark the 4.5 line. History is [] for games we have no data on.
 */

import { getSession, listSessionSlips } from '@/lib/sessions/store'
import { getTeamRecent } from '@/lib/pedlas/history-store'

export const runtime = 'nodejs'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const [base] = await listSessionSlips(session.id, { withLegs: true, limit: 1 })
  const legs = (base?.legs as Array<{ fixtureId: number; game: string; league: string; kickoff: string; line: number; odds: number }> | undefined) ?? []

  const games = await Promise.all(
    legs.map(async (l) => {
      const [home, away] = l.game.split(' vs ').map(s => s.trim())
      const [hr, ar] = await Promise.all([getTeamRecent(home, l.kickoff, 8), getTeamRecent(away, l.kickoff, 8)])
      // both teams' recent matches → total goals over time (most recent last, for a left→right chart)
      const history = [...hr, ...ar]
        .map(m => ({ date: m.date, total: m.hg + m.ag }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-14)
      const overRate = history.length ? history.filter(h => h.total >= 5).length / history.length : null
      return { fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, line: l.line, underOdds: l.odds, history, overRate }
    }),
  )
  games.sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  return Response.json({ games, count: games.length, withHistory: games.filter(g => g.history.length > 0).length })
}
