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
  // Persisted live outcomes (from /settle), keyed by fixture — shown per game as it finishes.
  const outcomes = new Map<number, { finished: boolean; total: number | null; over: boolean | null }>(
    (((session.meta as { gameResults?: Array<{ fixtureId: number; finished: boolean; total: number | null; over: boolean | null }> } | null)?.gameResults) ?? []).map(g => [g.fixtureId, g]),
  )

  const games = await Promise.all(
    legs.map(async (l) => {
      const [home, away] = l.game.split(' vs ').map(s => s.trim())
      const [hr, ar] = await Promise.all([getTeamRecent(home, l.kickoff, 14), getTeamRecent(away, l.kickoff, 14)])
      // STRICTLY the two teams' own meetings (H2H) — no team-form fallback.
      const isH2H = (m: { home: string; away: string }) => (m.home === home && m.away === away) || (m.home === away && m.away === home)
      const h2h = dedupe([...hr, ...ar].filter(isH2H))
      const history = h2h.map(m => ({ date: m.date, total: m.hg + m.ag })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14)
      const overRate = history.length ? history.filter(h => h.total >= 5).length / history.length : null
      const outcome = outcomes.get(l.fixtureId) ?? null
      return { fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, line: l.line, underOdds: l.odds, history, overRate, source: history.length ? 'h2h' : 'none', outcome }
    }),
  )
  games.sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  return Response.json({ games, count: games.length, withHistory: games.filter(g => g.history.length > 0).length, withH2H: games.filter(g => g.source === 'h2h').length })
}

function dedupe(ms: { date: string; home: string; away: string; hg: number; ag: number }[]) {
  const seen = new Set<string>()
  return ms.filter(m => { const k = `${m.date}|${m.home}|${m.away}|${m.hg}-${m.ag}`; if (seen.has(k)) return false; seen.add(k); return true })
}
